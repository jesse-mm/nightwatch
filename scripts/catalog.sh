#!/bin/sh
# Pack or fetch the catalog artifact: catalog/featured.json + catalog/paintings.jsonl.
#
# The catalog is generated (see docs/GENERATOR.md), so it isn't kept in git.
# Instead it's published as a release asset, e.g. on GitHub, and fetched here.
#
#   scripts/catalog.sh pack    -> catalog.tar.gz + catalog.tar.gz.sha256 (upload both)
#   scripts/catalog.sh fetch   -> downloads $CATALOG_URL (+ .sha256), checks, unpacks
#
# CATALOG_URL comes from the environment or .env, e.g.
#   https://github.com/<owner>/<repo>/releases/latest/download/catalog.tar.gz
#
# Needs only standard tools: tar, curl or wget, sha256sum or shasum.

set -eu

cd "$(dirname "$0")/.."
NAME=catalog.tar.gz

die() {
    echo "catalog.sh: $*" >&2
    exit 1
}

# CATALOG_URL from the environment, else from .env (without running .env).
catalog_url() {
    if [ -n "${CATALOG_URL:-}" ]; then
        echo "$CATALOG_URL"
    elif [ -f .env ]; then
        sed -n 's/^CATALOG_URL=\([^ #]*\).*/\1/p' .env | tail -n 1
    fi
}

download() { # url file
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL -o "$2" "$1"
    elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$2" "$1"
    else
        die "needs curl or wget"
    fi
}

sha256() { # file -> "hash  name"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1"
    else
        shasum -a 256 "$1"
    fi
}

check_sha256() { # checksum-file (run in the directory holding the archive)
    # Plain -c with output discarded: BusyBox sha256sum has no --quiet.
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum -c "$1" >/dev/null
    else
        shasum -a 256 -c "$1" >/dev/null
    fi
}

pack() {
    [ -f catalog/featured.json ] || die "catalog/featured.json not found: run the generator first"
    files="catalog/featured.json"
    [ -f catalog/paintings.jsonl ] && files="$files catalog/paintings.jsonl"
    # shellcheck disable=SC2086 # word splitting of the file list is intended
    tar -czf "$NAME" $files
    sha256 "$NAME" >"$NAME.sha256"
    echo "Packed $files"
    echo "Upload $NAME and $NAME.sha256 to a release (keep these names)."
}

fetch() {
    url=$(catalog_url)
    [ -n "$url" ] || die "set CATALOG_URL (in .env), e.g. https://github.com/<owner>/<repo>/releases/latest/download/$NAME"
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    download "$url" "$tmp/$NAME" || die "download failed: $url"
    download "$url.sha256" "$tmp/$NAME.sha256" || die "download failed: $url.sha256"
    (cd "$tmp" && check_sha256 "$NAME.sha256") || die "checksum mismatch: not unpacking"
    mkdir -p catalog
    tar -xzf "$tmp/$NAME"
    echo "Unpacked into catalog/:"
    ls -l catalog
}

case "${1:-}" in
pack) pack ;;
fetch) fetch ;;
*)
    echo "usage: $0 pack|fetch" >&2
    exit 2
    ;;
esac
