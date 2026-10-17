# Rust for TypeScript developers (just enough for the generator)

You don't need to learn all of Rust to work on the generator. This page maps
what's in `generator/src` to things you already know. Read the code in this
order: `generate.rs` → `catalog.rs` → `imaging.rs` → `saliency.rs` →
`bundle.rs`.

## Tooling

| You know | Rust |
|---|---|
| `npm install` / `package.json` | `cargo build` / `Cargo.toml` (deps are "crates") |
| `package-lock.json` | `Cargo.lock` (commit it) |
| `npm test` | `cargo test` (tests live next to the code in `mod tests`) |
| `node index.js` | `cargo run` |
| `tsc --noEmit` | `cargo check` (fast type-check without building) |
| ESLint / Prettier | `cargo clippy` / `cargo fmt` |

Install the toolchain with [rustup](https://rustup.rs). The compiler's error
messages are long but usually say exactly what to change. Read them top to bottom.

The crate is a library (`treasure_trove`, `src/lib.rs`) plus one binary
(`treasure-trove-generator`, `src/bin/generator.rs`), which only parses the
options and calls `generate::run`.

## Reading the code

**Modules.** `pub mod rijks;` in `lib.rs` is like `export * as rijks from './rijks'`.
`pub` = `export`. `use crate::imaging::Target;` = `import { Target } from './imaging'`.

**Structs and enums.**
```rust
pub struct Target { pub w: u32, pub h: u32, pub round: bool, pub fit: Fit }  // interface Target { w: number; … }
pub enum Fit { Fill, Whole }                                                 // type Fit = 'fill' | 'whole'
```
`#[derive(Serialize, Deserialize)]` auto-generates JSON conversion (like zod +
JSON.stringify in one). `#[serde(rename_all = "camelCase")]` maps `window_x`
to `windowX` in JSON.

**No null, no exceptions.**
```rust
Option<String>        // string | undefined
Result<ArtMeta>       // either the value or an error (like a typed Promise rejection)
meta.date.unwrap_or_default()   // meta.date ?? ''
let meta = rijks.resolve(id, year).await?; // the ? means: if this failed, return the error now
```
`?` is the most important symbol in this codebase: it's how errors bubble up,
like an `await` that rethrows.

**`if let` / `match`** are pattern matching, roughly a `switch` that can also
unwrap values:
```rust
match plan.mode {
    CropMode::Smart => …,
    _ => …,             // default:
}
if let Some(name) = name_of(doc) { … }   // if (name !== undefined) { … }
```

**Borrowing (`&`).** `fn plan_crop(src: &RgbImage, …)` takes a *reference*: the
function can read `src` but doesn't own it. `&mut` means it may modify it. If
the compiler complains about borrowing, the usual fix is to `.clone()` the
value (fine here; the data is small).

**Async.** Same model as JS: `async fn` + `.await`. Tokio is the event loop,
used for the network requests. All of them go through one shared pacer,
`Arc<Throttle>` (`throttle.rs`): `Arc` is a reference-counted pointer you can
hand to everything that makes requests, and its `Mutex` makes them take turns.

**Parallel work.** Planning crops is CPU work, so it runs on all cores with
[rayon](https://docs.rs/rayon): `chunk.par_iter().map(…)` is like
`Promise.all(chunk.map(…))` over worker threads. The results are written to
SQLite afterwards, one transaction per chunk.

## Where to change things

| I want to… | File |
|---|---|
| Change the "almost fits" threshold | `.env` → `SAFE_CROP_PX` |
| Make crops favor faces more/less | `saliency.rs`, weights in `energy_map` (`edge`, `sat`, `skin`) |
| Change how portraits are detected | `imaging.rs` `is_portrait_title`, `saliency.rs` `looks_like_portrait` |
| Change which licenses are allowed | `rijks.rs`, `judge_license()` (and its tests) |
| Change what goes into the catalog files (`catalog/web/`) | `bundle.rs` (and `docs/schema/catalog.schema.json`, `site/catalog.js`) |
| Change how a painting's era is found | `era.rs` (`Era::from_date` for dates the search pools miss) |
| Change brightness/contrast/saturation | `site/render.js`, `tone` (JavaScript, not the generator) |
| Change the settings page | `site/` (plain HTML/CSS/JS, no build step) |

After changing the planning code, bump `PIPELINE_VERSION` in `variants.rs` so
the next run re-plans every painting from its master image.

## A typical edit loop

```sh
cd generator
cargo test                       # make sure everything passes first
# edit…
cargo check                      # fast feedback on types
cargo test
cargo clippy --all-targets --locked -- -D warnings
cd ..
RUST_LOG=debug cargo run --manifest-path generator/Cargo.toml -- --skip-fetch --only 200107928
```

The last line re-plans one painting from what's in `data/` (no network) and
rewrites the catalog folder `catalog/web/`.
