# Pixno for Obsidian

Import a Pixno notebook as a Markdown file in your Obsidian vault.

1. Sign in to Pixno in your browser and open [Account → Integrations](https://photes.io/account/integrations).
2. Create an Obsidian access key and copy it. In the Obsidian plugin settings, paste the key and select **Connect**.
3. Select **Load notebooks**, choose a notebook, then select **Import Markdown**.

The key expires after 24 hours. Pixno's Integrations page shows the last use and lets you revoke the key. The plugin keeps it in memory until you disconnect, close Obsidian or unload the plugin.

Each import creates one file in `Pixno Imports`. Move an earlier copy before importing the notebook again. Text from each note is included in ID order. This version imports Markdown text. Source image attachments, automatic sync, uploads, AI note generation and mobile QR sign-in are unavailable.

## Development

Use `yarn install --frozen-lockfile`, `yarn test`, and `yarn build`. The build targets `https://photes.io` by default. To test against a Pixno Preview that has v2 enabled, set `PIXNO_OBSIDIAN_API_ORIGIN` to its HTTPS origin before building. Only use test keys with Preview builds.

For help, contact [Pixno support](https://photes.io/support). See [LICENSE](LICENSE).
