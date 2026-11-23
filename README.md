# Pixno for Obsidian

Import a Pixno notebook as a Markdown file in your Obsidian vault. Requires Obsidian 1.11.4 or later.

1. Open the Pixno plugin settings and select **Log in to Pixno**.
2. Sign in through your browser, approve Obsidian access, then select **Open Obsidian**.
3. Select **Load notebooks**, choose a notebook, then select **Import Markdown**.

Obsidian keeps the rotating session credential in the vault's SecretStorage. A session can resume when Obsidian starts. If Pixno cannot confirm credential rotation, sign in again. Use **Log out** in the plugin or [Pixno Integrations](https://photes.io/account/integrations) to revoke access.

Each import creates one file in `Pixno Imports`. Move an earlier copy before importing the notebook again. Text from each note is included in ID order. This version imports Markdown text. Source image attachments, automatic sync, uploads and AI note generation are unavailable.

## Development

Use `yarn install --frozen-lockfile`, `yarn test`, and `yarn build`. The build targets `https://photes.io` by default. To test against an authorized Preview with Obsidian login enabled, set `PIXNO_OBSIDIAN_API_ORIGIN` to its HTTPS origin before building. Only use an isolated test account on Preview.

For help, contact [Pixno support](https://photes.io/support). See [LICENSE](LICENSE).
