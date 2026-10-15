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
docker compose --profile tailscale up -d --build
docker compose logs -f server   # watch the pool being built
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

Everything lives in the `art-data` volume: the pool, metadata and rendered
images. Deleting it is safe; it's rebuilt on demand.

## Settings reference (.env)

| Variable | Default | Meaning |
|---|---|---|
| `SAFE_CROP_PX` | 20 | Max pixels trimmed by a plain centre crop before smart crop takes over |
| `PD_FALLBACK_YEAR` | 1850 | Accept records without licence info only if made by this year; 0 = never |
| `PALETTE_REFERENCE` | defined | Default colour tuning: defined, sun, room, backlight |
| `POOL_MAX_PAGES` | 80 | Search pages crawled for the pool |
| `RIJKS_SEARCH_URL` | paintings with images | Change to widen/narrow the collection |
| `SOURCE_SIZE` | 1200 | Longest side of the analysis image |
| `RUST_LOG` | info | Log level (`debug` for more) |
