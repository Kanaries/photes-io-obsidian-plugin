import { sha256 } from "@noble/hashes/sha256";
import { isAuthCode, isRefreshToken, PixnoError, type TokenSet, type createPixnoReadClient } from "./service";

const LOGIN_TTL_MS = 5 * 60_000;
const REFRESH_EARLY_MS = 30_000;

export const OBSIDIAN_CALLBACK_ACTION = "pixno-auth";

type Client = Pick<ReturnType<typeof createPixnoReadClient>, "exchange" | "refresh" | "logout">;
type Storage = {
	readSecret(): string | null;
	writeSecret(value: string): void;
	writeRotationPending(value: boolean): Promise<void>;
};

function base64url(bytes: Uint8Array) {
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class PixnoAuthorization {
	private lifetime = new AbortController();
	private pending: { state: string; verifier: string; deadline: number } | undefined;
	private memory: { accessToken: string; refreshAt: number } | undefined;
	private refreshing: Promise<string> | undefined;
	private rotationPending: boolean;
	private exchanging = false;
	private signingOut = false;

	constructor(private client: Client, private storage: Storage, rotationPending: boolean, private origin: string) {
		this.rotationPending = rotationPending;
	}

	get signal() { return this.lifetime.signal; }
	get waiting() { return this.exchanging || Boolean(this.pending && Date.now() < this.pending.deadline); }
	get hasSession() { return isRefreshToken(this.storage.readSecret()); }
	get needsLogin() { return this.rotationPending && !this.refreshing; }

	private resetMemory() {
		this.lifetime.abort();
		this.lifetime = new AbortController();
		this.pending = undefined;
		this.memory = undefined;
		this.refreshing = undefined;
		this.exchanging = false;
	}

	beginLogin() {
		if (this.signingOut) throw new PixnoError(409);
		this.resetMemory();
		const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
		const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
		this.pending = { state, verifier, deadline: Date.now() + LOGIN_TTL_MS };
		const url = new URL("/plugin/obsidian/authorize", this.origin);
		url.search = new URLSearchParams({
			state,
			code_challenge: base64url(sha256(new TextEncoder().encode(verifier))),
			code_challenge_method: "S256",
		}).toString();
		return url.href;
	}

	async completeLogin(params: Record<string, string>) {
		const pending = this.pending;
		if (!pending || Date.now() >= pending.deadline || params.action !== OBSIDIAN_CALLBACK_ACTION ||
			Object.keys(params).some(key => key !== "action" && key !== "state" && key !== "code") ||
			params.state !== pending.state || !isAuthCode(params.code)) return false;

		this.pending = undefined;
		this.exchanging = true;
		const signal = this.signal;
		try {
			const tokens = await this.client.exchange(params.code, pending.verifier, signal);
			if (signal.aborted) {
				// A late exchange may already have created a grant. Retire it without exposing its secret.
				void this.client.logout(tokens.refreshToken).catch(() => {});
				return false;
			}
			const previous = this.storage.readSecret();
			await this.save(tokens, signal);
			if (isRefreshToken(previous) && previous !== tokens.refreshToken) {
				void this.client.logout(previous).catch(() => {});
			}
			return !signal.aborted;
		} finally {
			if (!signal.aborted) this.exchanging = false;
		}
	}

	async access() {
		if (this.signingOut || this.waiting) throw new PixnoError(401);
		if (this.memory && Date.now() < this.memory.refreshAt) {
			return this.memory.accessToken;
		}
		if (this.refreshing) return this.refreshing;
		const secret = this.storage.readSecret();
		if (!isRefreshToken(secret) || this.rotationPending) throw new PixnoError(401);

		const operation = this.rotate(secret, this.signal);
		this.refreshing = operation;
		try {
			return await operation;
		} finally {
			if (this.refreshing === operation) this.refreshing = undefined;
		}
	}

	private async save(tokens: TokenSet, signal: AbortSignal) {
		if (signal.aborted) throw new PixnoError(401);
		this.storage.writeSecret(tokens.refreshToken);
		this.rotationPending = false;
		await this.storage.writeRotationPending(false);
		if (signal.aborted) throw new PixnoError(401);
		const lead = Math.min(REFRESH_EARLY_MS, Math.max(0, (tokens.expiresAt - Date.now()) / 2));
		this.memory = { accessToken: tokens.accessToken, refreshAt: tokens.expiresAt - lead };
	}

	private async rotate(secret: string, signal: AbortSignal) {
		// A crash or ambiguous response may leave the old token spent. Never replay it automatically.
		this.rotationPending = true;
		await this.storage.writeRotationPending(true);
		if (signal.aborted) throw new PixnoError(401);
		try {
			const tokens = await this.client.refresh(secret, signal);
			await this.save(tokens, signal);
			return tokens.accessToken;
		} catch (error) {
			if (!signal.aborted && error instanceof PixnoError) {
				if (error.status === 401) {
					this.storage.writeSecret("");
					this.memory = undefined;
					this.rotationPending = false;
					await this.storage.writeRotationPending(false);
				} else if (error.status === 429 || error.code === "plugin_unavailable") {
					// These server responses reject the request before attempting rotation.
					this.rotationPending = false;
					await this.storage.writeRotationPending(false);
				}
			}
			throw error;
		}
	}

	invalidateAccess(accessToken: string) {
		if (this.memory?.accessToken === accessToken) this.memory = undefined;
	}

	stop() { this.resetMemory(); }

	async logout() {
		if (this.signingOut) return;
		this.signingOut = true;
		try {
			const secret = this.storage.readSecret();
			this.resetMemory();
			const revoke = isRefreshToken(secret) ? this.client.logout(secret) : Promise.resolve();
			const clear = async () => {
				// SecretStorage has no delete method at the supported API floor.
				this.storage.writeSecret("");
				this.rotationPending = false;
				await this.storage.writeRotationPending(false);
			};
			const outcomes = await Promise.allSettled([revoke, clear()]);
			for (const outcome of outcomes) {
				if (outcome.status === "rejected") throw outcome.reason;
			}
		} finally {
			this.signingOut = false;
		}
	}
}
