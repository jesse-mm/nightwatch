# Deploying on a home server (Proxmox + Tailscale)

The phone fetches paintings from the server, so the phone must be able to reach
it, including when you're away from home. Tailscale Funnel gives the server a
public HTTPS address (`https://treasure-trove.<tailnet>.ts.net`) without opening
ports on your router. HTTPS also matters because phone webviews and PebbleKit JS
may block plain HTTP.

## 1. A place to run Docker

On Proxmox, an unprivileged Debian 12 LXC container is enough (1 vCPU, 512 MB
RAM, 4 GB disk). Enable **nesting** in the container's options so Docker can run,
then install Docker:

```sh
apt update && apt install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sh
```

The Tailscale sidecar uses *userspace networking*, so you don't need to pass
`/dev/net/tun` into the LXC.

## 2. Tailscale auth key and Funnel

1. In the Tailscale admin console → **Settings → Keys**, generate an auth key
   (reusable off, tag e.g. `tag:container` if you use ACL tags).
2. Make sure **HTTPS certificates** and **Funnel** are enabled for your tailnet,
   and that your ACL policy grants the `funnel` node attribute to that tag or
   device.

## 3. Start it

```sh
git clone <your repo> treasure-trove && cd treasure-trove
cp .env.example .env        # set TS_AUTHKEY (and TS_HOSTNAME if you like)
docker compose run --rm generator     # first time: most of a day, see GENERATOR.md
docker compose --profile tailscale up -d --build
docker compose logs -f server
```

Check:

```sh
curl http://localhost:8080/healthz
curl https://treasure-trove.<tailnet>.ts.net/healthz
```

The first build of the Rust image takes a few minutes; later builds reuse the
cached dependency layer.

## 4. Point the watchface at it

Set `SERVER_URL` in `watchface/src/pkjs/config.js` to the Funnel URL, rebuild,
reinstall.

## LAN only

Skip Tailscale with `docker compose up -d --build` and use
`http://<server-ip>:8080`. The face then only updates on your home network (the
phone keeps showing its cached painting elsewhere).

## Updating and data

```sh
git pull && docker compose --profile tailscale up -d --build
```

Everything the server serves lives in `./data` (`DATA_DIR`), made by the
generator; the server mounts it read-only and reloads `serve.sqlite` within a
minute of the generator publishing a new one. Re-run the generator monthly:

```sh
docker compose run --rm generator
```

**Generating on another machine** (e.g. a laptop) and serving from Proxmox: copy
`data/` across with rsync. It only sends changed files, and writes each file
under a temporary name before renaming it, so the server never reads a
half-copied snapshot:

```sh
rsync -a --delete data/ proxmox-host:/path/to/treasure-trove/data/
```

## Load test

`scripts/loadtest.js` ([k6](https://k6.io)) has many watches ask for their
painting at the same moment: each client fetches the painting info (Featured,
random or pinned) for one of the four screens and then its pixels, with gzip
like a phone. Run it against a running server:

```sh
docker run --rm -i -v "$PWD/scripts:/scripts" grafana/k6:0.57.0 run \
  -e BASE_URL=http://host.docker.internal:8080 /scripts/loadtest.js
```

`CLIENTS` (default 100) and `ROUNDS` (fetches per client, default 10) change
the size. On a laptop (Docker on macOS, 55 paintings):

| Clients at once | Fetches | Errors | Median | p95 |
|---|---|---|---|---|
| 100 | 1,000 | 0 | 34 ms | 244 ms |
| 1,000 | 3,000 | 0 | 532 ms | 1.65 s |

A fetch is about 86 KB, so a 1 Gbps uplink carries roughly 1,400 watches per
second. Each watch fetches about once a day, so a home server has plenty of
headroom. At 1,000 at once the limit is most likely CPU (decoding and gzipping
pixels), not the network.

## Settings reference (.env)

| Variable | Default | Meaning |
|---|---|---|
| `DATA_DIR` | ./data | Generator output, served read-only by the server |
| `REQUESTS_PER_SECOND` | 1 | Generator: pace of all outside requests |
| `REFRESH_DAYS` | 25 | Generator: re-check metadata/pools older than this |
| `CONTACT` | (empty) | Generator: your email or URL for the User-Agent; needed for Wikipedia pageviews |
| `FEATURED_PATH` | ./catalog/featured.json | Generator: the Featured list (compose passes `/catalog/featured.json`) |
| `SAFE_CROP_PX` | 20 | Max pixels trimmed by a plain center crop before smart crop takes over |
| `PD_FALLBACK_YEAR` | 1850 | Accept records without license info only if made by this year; 0 = never |
| `POOL_MAX_PAGES` | 80 | Search pages crawled per pool |
| `RIJKS_SEARCH_URL` | paintings with images | Change to widen/narrow the collection |
| `SOURCE_SIZE` | 1200 | Longest side of the master image |
| `RUST_LOG` | info | Log level (`debug` for more) |
