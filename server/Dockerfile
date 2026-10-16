# syntax=docker/dockerfile:1
# ---- build stage: compile a small, optimized binary ----
FROM rust:1.91-slim-bookworm AS build
WORKDIR /app

# Build dependencies first so they are cached between code changes
# (TS analogy: copying package.json + `npm ci` before copying src/).
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src/bin && echo "fn main() {}" > src/main.rs && echo "fn main() {}" > src/bin/generator.rs \
    && touch src/lib.rs \
    && cargo build --release --locked \
    && rm -rf src target/release/deps/treasure_trove* target/release/deps/libtreasure_trove* \
       target/release/.fingerprint/treasure-trove*

COPY src ./src
RUN cargo build --release --locked

# ---- runtime stage: the two binaries + the settings page ----
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home /app trove \
    && mkdir -p /data && chown trove /data
WORKDIR /app
COPY --from=build /app/target/release/treasure-trove-server /usr/local/bin/treasure-trove-server
COPY --from=build /app/target/release/treasure-trove-generator /usr/local/bin/treasure-trove-generator
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
