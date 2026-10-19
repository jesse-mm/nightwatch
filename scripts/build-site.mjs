#!/usr/bin/env node
// Copy site/ to dist/ with our JS and CSS minified, for publishing. Every file
// keeps its name and path: the page loads several scripts by name (i18n.js
// loads app.js and tour.js, app.js loads OpenSeadragon), and the phone shares
// catalog.js, render.js, looks.js and settings.js from site/ unbuilt. Scripts
// stay classic scripts (no bundling), so their top-level names, which the
// other scripts use, are kept. vendor/ is copied as is.
//   node scripts/build-site.mjs
import { cpSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { transformSync } from 'esbuild';

const SOURCE = 'site';
const OUT = 'dist';
// Not part of the page: tells Node the shared scripts are CommonJS (tests).
const SKIP = new Set(['package.json']);

rmSync(OUT, { recursive: true, force: true });
cpSync(SOURCE, OUT, {
  recursive: true,
  filter: (path) => !SKIP.has(path.slice(SOURCE.length + 1)),
});

let before = 0;
let after = 0;
for (const path of files(OUT)) {
  const loader = path.endsWith('.js') ? 'js' : path.endsWith('.css') ? 'css' : null;
  if (!loader || path.startsWith(join(OUT, 'vendor'))) continue;
  const code = readFileSync(path, 'utf8');
  // es2022: the page already needs it (`??=`); fails loudly on anything newer.
  const out = transformSync(code, { loader, minify: true, target: 'es2022', legalComments: 'inline' });
  writeFileSync(path, out.code);
  before += code.length;
  after += out.code.length;
}
console.log(`site/ → ${OUT}/: JS and CSS ${kb(before)} → ${kb(after)}`);

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

function kb(n) {
  return `${(n / 1024).toFixed(0)} KB`;
}
