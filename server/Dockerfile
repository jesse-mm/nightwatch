# syntax=docker/dockerfile:1
# ---- build stage: compile a small, optimised binary ----
FROM rust:1.91-slim-bookworm AS build
WORKDIR /app

# Build dependencies first so they are cached between code changes
# (TS analogy: copying package.json + `npm ci` before copying src/).
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs \
    && cargo build --release --locked \
    && rm -rf src target/release/deps/treasure_trove_server*

COPY src ./src
RUN cargo build --release --locked

# ---- runtime stage: just the binary + the settings page ----
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home /app trove \
    && mkdir -p /data && chown trove /data
WORKDIR /app
COPY --from=build /app/target/release/treasure-trove-server /usr/local/bin/treasure-trove-server
COPY static ./static

ENV BIND_ADDR=0.0.0.0:8080 \
    DATA_DIR=/data \
    STATIC_DIR=/app/static \
    RUST_LOG=info
USER trove
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD ["treasure-trove-server", "healthcheck"]
CMD ["treasure-trove-server"]
