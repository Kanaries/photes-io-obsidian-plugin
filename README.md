# Pixno for Obsidian

Import a Pixno notebook as a Markdown file in your Obsidian vault. Requires Obsidian 1.11.4 or later.

1. Open the Pixno plugin settings and select **Log in to Pixno**.
2. Sign in through your browser, approve Obsidian access, then select **Open Obsidian**.
3. Select **Load notebooks**, choose a notebook, then select **Import notes and images**.

Obsidian keeps the rotating session credential in the vault's SecretStorage. A session can resume when Obsidian starts. If Pixno cannot confirm credential rotation, sign in again. Use **Log out** in the plugin or [Pixno Integrations](https://photes.io/account/integrations) to revoke access.

Each import creates one file in `Pixno Imports`. Move an earlier copy before importing the notebook again. Text from each note is included in ID order. Imports include source images as local attachments. Use the camera icon or Choose image to upload a PNG, JPEG, WebP or GIF and generate a note with GPT-5.4 mini. Generation saves to Pixno and appends to the Markdown note open when you select the image, or creates a new note if none is open. It uses Pixno AI credits (minimum 4 per successful image). Existing read-only sessions must log out and sign in again to approve generation. Images up to 20 MiB are accepted locally; larger uploads are resized to fit the 3 MiB request limit. An import supports up to 50 source images and 50 MiB of attachments. Automatic sync remains unavailable. After an uncertain generation or local-save failure, check Pixno notebooks before retrying.

## Development

Use `yarn install --frozen-lockfile`, `yarn test`, and `yarn build`. The build targets `https://photes.io` by default. To test against an authorized Preview with Obsidian login enabled, set `PIXNO_OBSIDIAN_API_ORIGIN` to its HTTPS origin before building. Only use an isolated test account on Preview.

For help, contact [Pixno support](https://photes.io/support). See [LICENSE](LICENSE).
