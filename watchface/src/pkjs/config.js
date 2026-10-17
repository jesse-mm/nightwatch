/**
 * Where the settings page is hosted: the static files in site (the
 * page, its scripts and catalog.json), e.g. on GitHub Pages. The watchface
 * itself needs no server: paintings come straight from the Rijksmuseum.
 * No trailing slash.
 */
module.exports = {
  SETTINGS_URL: 'https://your-name.github.io/treasure-trove'
  // Development only (see docs/DEPLOY.md, "Testing locally"):
  // DEV_BASE64_URL: 'http://<your-mac>:8092/base64?url=',  // images for the emulator
  // DEBUG: true                                             // settings page debug pane
};
