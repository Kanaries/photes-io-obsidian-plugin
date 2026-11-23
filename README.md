# Pixno for Obsidian

Generate notes from images, import notebooks with their source images, and sync Pixno changes into your vault. Requires Obsidian 1.11.4 or later.

1. Open plugin settings and select **Log in to Pixno**.
2. Sign in through your browser, approve access, then select **Open Obsidian**.
3. Use the button beside an image or right-click it to generate a note below that image. The camera ribbon also offers **Choose image** and **Upload from phone**.

Generation uses your Pixno account's note model, language, reasoning effort and core/advanced style. Free accounts use Pixno's shared automatic model policy. Generation saves to Pixno and uses AI credits, with a minimum of 4 per successful image. After an uncertain result, check Pixno before retrying; the plugin never automatically repeats generation.

## Import and sync

Use **Load notebooks** in settings to choose a notebook, then **Import notes and images**. Images appear below their corresponding note headings, in the notebook's saved note order. The default notebook folder is `Pixno Imports`; images go in `assets`. Both paths are configurable within the current vault.

Enable **Automatically sync Pixno notes** to check every minute while Obsidian is open, or run the **Sync notes** command. Large libraries are processed over multiple automatic rounds. Sync updates files created by this plugin. If you edit a synchronized file locally, the plugin preserves it and skips that update. Keep your edited copy at another path and import a fresh copy to resume syncing. Cloud deletions never delete local files automatically. Unreferenced older image attachments are retained to protect local copies.

For phone uploads, open the destination Markdown note and choose **Upload from phone** from the camera ribbon or command palette. Scan the QR to automatically sign your phone into the connected Pixno account and open that notebook, then upload or take photos. After phone sign-in, the QR window shows the connection status and lists received note titles. You can close it at any time. Generated notes and source images continue syncing in the background into the captured section of the original Obsidian note, even with Auto Sync off. A notification confirms when they are saved. The QR contains a short-lived, one-use login link. Use Refresh QR when it expires; do not share it. Preview sites may also require Vercel access on the phone.

Obsidian keeps the rotating session credential in the vault's SecretStorage and resumes it after restart. If Pixno cannot confirm credential rotation, sign in again. Use **Log out** or [Pixno Integrations](https://photes.io/account/integrations) to revoke access. Logging out or starting a new login pauses auto sync and forgets local sync mappings, preserving all files. Each vault has its own connection.

Existing read-only sessions must sign in again to approve generation. Upgrading from 0.4.2 also requires reconnecting once to explicitly allow phone sign-in; ordinary phone uploads keep the QR inside Obsidian and need no extra desktop-browser step. Local images up to 20 MiB are accepted; large uploads are resized to fit the 3 MiB generation request limit. Each notebook import supports up to 50 images and 50 MiB of attachments.

## Development

Use `yarn install --frozen-lockfile`, `yarn test`, and `yarn build`. The build targets `https://photes.io`. For an authorized Preview with plugin login enabled, set `PIXNO_OBSIDIAN_API_ORIGIN` before building and use an isolated test account. Never distribute a QA deployment-protection transport or credential.

For help, contact [Pixno support](https://photes.io/support). See [LICENSE](LICENSE).
