/**
 * The release build's settings (`npm run build:watch`). Where the settings
 * page is hosted: the static files in site (the page, its scripts and the
 * catalog folder), e.g. on Cloudflare Pages (`npm run deploy`). The
 * watchface itself needs no server: paintings come straight from the
 * Rijksmuseum. No trailing slash.
 *
 * For development, copy this to config.dev.js (not in git) and point it at
 * your Mac; see docs/DEPLOY.md, "Testing locally".
 */
module.exports = {
  SETTINGS_URL: "https://nightwatch.linthor.st",
};
