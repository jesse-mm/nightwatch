#!/usr/bin/env node
// Copy the generator's catalog folder (manifest.json, featured.json and one
// file per era) next to the settings page, where the phone and the page load
// it from: site/catalog/ (generated, not committed). Run after the generator:
//   node scripts/bundle-catalog.mjs [catalog/web]
import { cpSync, readFileSync, rmSync } from 'node:fs';

const source = process.argv[2] || 'catalog/web';
const manifest = JSON.parse(readFileSync(`${source}/manifest.json`, 'utf8'));
rmSync('site/catalog', { recursive: true, force: true });
cpSync(source, 'site/catalog', { recursive: true });
const counts = manifest.files.map((f) => `${f.pool} ${f.count}`).join(', ');
console.log(`catalog ${manifest.id} → site/catalog/: ${counts}`);
