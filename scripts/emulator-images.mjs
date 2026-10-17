#!/usr/bin/env node
// Development only: the Pebble emulator's PebbleKit JS can't download binary
// data, so it can't fetch the PNG crops from the Rijksmuseum's IIIF server.
// This helper fetches them and answers with base64 text, which it can:
//
//   GET /base64?url=<IIIF image URL>   → the image as base64 (IIIF URLs only)
//
// Set DEV_BASE64_URL: 'http://<your-mac>:8092/base64?url=' in the phone's
// config.js; the phone only uses it when binary downloads fail. Real phones
// and the settings page fetch straight from IIIF.
//
//   node scripts/emulator-images.mjs [port]      (default 8092)
//
// DEV_GONE=<iiif id>,… answers 404 for those images, to try how the phone
// handles a painting the Rijksmuseum dropped (e.g. a pinned one).
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] || 8092);
const ALLOWED = /^https:\/\/iiif\.micr\.io\//;
const GONE = (process.env.DEV_GONE || '').split(',').filter(Boolean);

function reply(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain',
    'Content-Length': Buffer.byteLength(text),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(text);
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const target = url.searchParams.get('url') || '';
  if (url.pathname !== '/base64' || !ALLOWED.test(target)) {
    reply(res, 400, 'use /base64?url=<Rijksmuseum IIIF URL>');
    return;
  }
  if (GONE.some((id) => target.includes(`/${id}/`))) {
    console.log(`404 (DEV_GONE)  ${target}`);
    reply(res, 404, 'gone (DEV_GONE)');
    return;
  }
  try {
    const upstream = await fetch(target);
    if (!upstream.ok) {
      reply(res, upstream.status, `IIIF: HTTP ${upstream.status}`);
      return;
    }
    const bytes = Buffer.from(await upstream.arrayBuffer());
    console.log(`base64 ${bytes.length} B  ${target}`);
    reply(res, 200, bytes.toString('base64'));
  } catch (e) {
    reply(res, 502, String(e.message || e));
  }
}).listen(PORT, '0.0.0.0', () => console.log(`emulator images on http://localhost:${PORT}/base64?url=…`));
