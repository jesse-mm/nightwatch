// Load test: many watches asking for their painting at the same moment.
//
// Each virtual client does what the phone app does when a new painting is due:
// ask for the painting (Featured, a random one, or a pinned one) for one of the
// four color screens, then download its pixels (`rgb?format=b64`).
//
//   docker run --rm -i -v "$PWD/scripts:/scripts" grafana/k6:0.57.0 run \
//     -e BASE_URL=http://host.docker.internal:8080 /scripts/loadtest.js
//
// Options (with -e): BASE_URL, CLIENTS (default 100), ROUNDS (requests per
// client, default 10).

import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const CLIENTS = Number(__ENV.CLIENTS || 100);
const ROUNDS = Number(__ENV.ROUNDS || 10);

// The four color Pebbles (docs/DEVICES.md).
const SCREENS = [
  { w: 144, h: 168, round: 0 },
  { w: 180, h: 180, round: 1 },
  { w: 200, h: 228, round: 0 },
  { w: 260, h: 260, round: 1 },
];

const paintingTime = new Trend('painting_json_ms', true);
const pixelsTime = new Trend('pixels_ms', true);
const fullTime = new Trend('full_fetch_ms', true);

export const options = {
  scenarios: {
    // All clients start together and each fetches ROUNDS paintings back to back.
    burst: { executor: 'per-vu-iterations', vus: CLIENTS, iterations: ROUNDS, maxDuration: '5m' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    full_fetch_ms: ['p(95)<1000'],
  },
};

// Phones ask for compressed responses; the server gzips JSON and pixels.
const params = (name) => ({ tags: { name }, headers: { 'Accept-Encoding': 'gzip' } });

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

export function setup() {
  // A few real keys for the "pinned" path.
  const keys = [];
  for (let i = 0; i < 5; i++) {
    const res = http.get(`${BASE_URL}/api/art/random?w=144&h=168&round=0&fit=fill`);
    if (res.status === 200) keys.push(res.json('key'));
  }
  if (!keys.length) throw new Error(`No paintings at ${BASE_URL}; is the server running?`);
  return { keys };
}

export default function ({ keys }) {
  const s = pick(SCREENS);
  const query = `w=${s.w}&h=${s.h}&round=${s.round}&fit=${pick(['fill', 'whole'])}`;
  const roll = Math.random();
  let path;
  if (roll < 0.6) path = `/api/art/featured?${query}&day=${Math.floor(Math.random() * 365)}`;
  else if (roll < 0.9) path = `/api/art/random?${query}`;
  else path = `/api/art/${pick(keys)}?${query}`;

  const started = Date.now();
  const meta = http.get(`${BASE_URL}${path}`, params('painting'));
  paintingTime.add(meta.timings.duration);
  if (!check(meta, { 'painting 200': (r) => r.status === 200 })) return;

  const pixels = http.get(`${BASE_URL}${meta.json('rgbUrl')}&format=b64`, params('pixels'));
  pixelsTime.add(pixels.timings.duration);
  check(pixels, { 'pixels 200': (r) => r.status === 200 && r.body.length > 0 });
  fullTime.add(Date.now() - started);
}
