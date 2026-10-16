# Rust for TypeScript developers (just enough for this server)

You don't need to learn all of Rust to work on this server. This page maps what's
in `server/src` to things you already know.

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

## Reading the code

**Modules.** `mod rijks;` in `main.rs` is like `import * as rijks from './rijks'`.
`pub` = `export`. `use crate::imaging::Target;` = `import { Target } from './imaging'`.

**Structs and enums.**
```rust
pub struct Target { pub w: u32, pub h: u32, pub color: bool }   // interface Target { w: number; … }
pub enum Fit { Fill, Whole }                                     // type Fit = 'fill' | 'whole'
```
`#[derive(Serialize, Deserialize)]` auto-generates JSON conversion (like zod +
JSON.stringify in one). `#[serde(rename_all = "camelCase")]` maps `object_number`
to `objectNumber` in JSON.

**No null, no exceptions.**
```rust
Option<String>        // string | undefined
Result<ArtMeta>       // either the value or an error (like a typed Promise rejection)
meta.date.unwrap_or_default()   // meta.date ?? ''
let m = self.resolve(id).await?; // the ? means: if this failed, return the error now
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

**Borrowing (`&`).** `fn render(art: &RgbImage)` takes a *reference*: the function
can read `art` but doesn't own it. `&mut` means it may modify it. If the compiler
complains about borrowing, the usual fix is to `.clone()` the value (fine here;
the data is small).

**Async.** Same model as JS: `async fn` + `.await`. Tokio is the event loop.
CPU-heavy work (decoding, dithering) is wrapped in `spawn_blocking` /
`block_in_place` so it doesn't stall other requests, the equivalent of moving work
to a worker thread.

**Shared state.** `Arc<AppState>` is a reference-counted pointer you can hand to
every request handler (like a singleton). `RwLock` guards the painting pool
because a background task writes it while requests read it.

## Where to change things

| I want to… | File |
|---|---|
| Change the "almost fits" threshold | `.env` → `SAFE_CROP_PX` |
| Make crops favor faces more/less | `saliency.rs`, weights in `energy_map` (`edge`, `sat`, `skin`) |
| Change brightness/contrast/saturation | `imaging.rs`, `tone()` and `SHADOW_GAMMA` |
| Change which licenses are allowed | `rijks.rs`, `judge_license()` (and its tests) |
| Add a new endpoint | `routes.rs`, add a `.route(...)` and a handler function |
| Change the settings page | `static/config/` (plain HTML/CSS/JS, no build step) |

After changing the image pipeline, bump `RENDER_VERSION` in `store.rs` so cached
renders are regenerated.

## A typical edit loop

```sh
cd server
cargo test                       # make sure everything passes first
# edit…
cargo check                      # fast feedback on types
cargo test
RUST_LOG=debug cargo run         # then open http://localhost:8080/config/
curl "http://localhost:8080/api/art/random?w=144&h=168&color=1" | jq
```
