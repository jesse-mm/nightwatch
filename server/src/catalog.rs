//! The catalog: SQLite, written by the generator, read by the server.
//!
//! - `catalog.sqlite` is the generator's working database: what we know about
//!   each painting (metadata, license, era, links) and every file on disk with
//!   the input hash it was made from, so a re-run only redoes work whose inputs
//!   changed. ~40k crop rows when complete, so it stays on disk.
//! - `serve.sqlite` is a small snapshot for the server (paintings, eras, links,
//!   crop plans, "fully rendered" flag; a few MB). The generator publishes it
//!   with an atomic rename, so the server never sees a half-written file. The
//!   server reads it into plain maps (see snapshot.rs).
//!
//! ```text
//! <data>/catalog.sqlite
//! <data>/serve.sqlite
//! <data>/art/<key>/source.jpg              master image (longest side ≈ 1200 px)
//! <data>/art/<key>/c/<crop>.png            8 per painting, toned RGB (lossless)
//! ```

use std::{
    collections::HashMap,
    io::Write,
    path::{Path, PathBuf},
};

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::{era::Era, featured::Candidate, imaging::CropPlan, rijks::ArtMeta, wiki::WikiLinks};

const SCHEMA: &str = r"
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Ids the Search API currently lists (paintings with an image).
CREATE TABLE IF NOT EXISTS pool (
  key TEXT PRIMARY KEY,
  id  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS painting_eras (
  key TEXT NOT NULL,
  era TEXT NOT NULL,
  PRIMARY KEY (key, era)
);
CREATE INDEX IF NOT EXISTS painting_eras_era ON painting_eras (era);
CREATE TABLE IF NOT EXISTS paintings (
  key           TEXT PRIMARY KEY,
  id            TEXT NOT NULL,
  object_number TEXT,
  eligible      INTEGER NOT NULL,
  meta          TEXT NOT NULL,        -- ArtMeta as JSON
  meta_hash     TEXT NOT NULL,
  source_url    TEXT,                 -- IIIF URL the master image came from
  source_sha256 TEXT,
  fetched_at    INTEGER NOT NULL,     -- last time the metadata was checked
  changed_at    INTEGER NOT NULL,     -- last time the metadata actually changed
  plans         TEXT,                 -- {crop name: CropPlan} once rendered
  ready         INTEGER NOT NULL DEFAULT 0  -- all crops exist on disk
);
CREATE TABLE IF NOT EXISTS crops (
  key        TEXT NOT NULL,
  name       TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  plan       TEXT NOT NULL,           -- CropPlan as JSON
  path       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  PRIMARY KEY (key, name)
);
-- Variants (dithered per tuning/frame) are made on the phone now; drop the
-- table older catalogs have.
DROP TABLE IF EXISTS variants;
CREATE TABLE IF NOT EXISTS wiki (
  object_number TEXT PRIMARY KEY,
  links         TEXT NOT NULL          -- WikiLinks as JSON
);
";

pub struct Catalog {
    conn: Connection,
    root: PathBuf,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub pool: i64,
    pub paintings: i64,
    pub eligible: i64,
    pub with_source: i64,
    /// Eligible paintings with every crop rendered (what the server offers).
    pub ready: i64,
    pub crops: i64,
    pub crop_bytes: i64,
}

/// One painting's stored state, as the generator sees it.
pub struct PaintingState {
    pub meta_hash: String,
    pub source_url: Option<String>,
    pub source_sha256: Option<String>,
}

impl Catalog {
    pub fn open(root: &Path) -> Result<Self> {
        std::fs::create_dir_all(root)?;
        let conn = Connection::open(Self::path(root))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn,
            root: root.to_path_buf(),
        })
    }

    pub fn path(root: &Path) -> PathBuf {
        root.join("catalog.sqlite")
    }

    pub fn serve_path(root: &Path) -> PathBuf {
        root.join("serve.sqlite")
    }

    /// Write the server's snapshot: only the tables it reads, then an atomic
    /// rename over the previous one.
    /// `featured`: Featured keys in day-of-year order (see featured.rs).
    pub fn publish(&self, featured: &[String]) -> Result<()> {
        let dest = Self::serve_path(&self.root);
        let tmp = dest.with_extension("sqlite.tmp");
        let _ = std::fs::remove_file(&tmp);
        self.conn
            .execute("ATTACH DATABASE ?1 AS snap", [tmp.to_string_lossy()])?;
        let copy = self
            .conn
            .execute_batch(
                "CREATE TABLE snap.pool AS SELECT * FROM main.pool;
             CREATE TABLE snap.painting_eras AS SELECT * FROM main.painting_eras;
             CREATE TABLE snap.paintings AS SELECT * FROM main.paintings;
             CREATE TABLE snap.wiki AS SELECT * FROM main.wiki;
             CREATE UNIQUE INDEX snap.pool_key ON pool (key);
             CREATE INDEX snap.painting_eras_era ON painting_eras (era, key);
             CREATE UNIQUE INDEX snap.paintings_key ON paintings (key);
             CREATE INDEX snap.paintings_ready ON paintings (ready, eligible);
             CREATE UNIQUE INDEX snap.wiki_num ON wiki (object_number);
             CREATE TABLE snap.featured (day INTEGER PRIMARY KEY, key TEXT NOT NULL);",
            )
            .and_then(|()| {
                let mut add = self
                    .conn
                    .prepare("INSERT INTO snap.featured (day, key) VALUES (?1, ?2)")?;
                for (day, key) in featured.iter().enumerate() {
                    add.execute(params![day as i64, key])?;
                }
                Ok(())
            });
        self.conn.execute_batch("DETACH DATABASE snap")?;
        copy?;
        std::fs::rename(&tmp, &dest)?;
        Ok(())
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    // ---------------- kv ----------------

    pub fn get_kv(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM kv WHERE key = ?1", [key], |r| r.get(0))
            .optional()?)
    }

    pub fn set_kv(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }

    // ---------------- pool + eras ----------------

    /// Replace the pool and era membership in one transaction.
    pub fn set_pool(&mut self, ids: &[String], eras: &[(Era, Vec<String>)]) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM pool", [])?;
        tx.execute("DELETE FROM painting_eras", [])?;
        {
            let mut add = tx.prepare("INSERT OR IGNORE INTO pool (key, id) VALUES (?1, ?2)")?;
            for id in ids {
                add.execute([key_of(id), id.as_str()])?;
            }
            let mut era_add =
                tx.prepare("INSERT OR IGNORE INTO painting_eras (key, era) VALUES (?1, ?2)")?;
            for (era, era_ids) in eras {
                for id in era_ids {
                    era_add.execute([key_of(id), era.name()])?;
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Pool ids whose metadata wasn't checked since `checked_after` (unix secs).
    pub fn due_for_fetch(&self, checked_after: u64) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT pool.id FROM pool LEFT JOIN paintings p ON p.key = pool.key
             WHERE p.key IS NULL OR p.fetched_at < ?1 ORDER BY pool.key",
        )?;
        let ids = stmt
            .query_map([checked_after as i64], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        Ok(ids)
    }

    // ---------------- paintings ----------------

    pub fn painting_state(&self, key: &str) -> Result<Option<PaintingState>> {
        Ok(self
            .conn
            .query_row(
                "SELECT meta_hash, source_url, source_sha256 FROM paintings WHERE key = ?1",
                [key],
                |r| {
                    Ok(PaintingState {
                        meta_hash: r.get(0)?,
                        source_url: r.get(1)?,
                        source_sha256: r.get(2)?,
                    })
                },
            )
            .optional()?)
    }

    /// Store freshly fetched metadata. Returns true when it differs from before.
    pub fn upsert_painting(&self, meta: &ArtMeta, now: u64) -> Result<bool> {
        let json = serde_json::to_string(meta)?;
        let hash = crate::variants::sha256_hex(json.as_bytes());
        let changed = self
            .painting_state(&meta.key)?
            .is_none_or(|s| s.meta_hash != hash);
        self.conn.execute(
            "INSERT INTO paintings (key, id, object_number, eligible, meta, meta_hash, fetched_at, changed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(key) DO UPDATE SET
               id = excluded.id, object_number = excluded.object_number, eligible = excluded.eligible,
               meta = excluded.meta, fetched_at = excluded.fetched_at,
               changed_at = CASE WHEN paintings.meta_hash = excluded.meta_hash THEN paintings.changed_at ELSE excluded.changed_at END,
               meta_hash = excluded.meta_hash",
            params![meta.key, meta.id, meta.object_number, meta.eligible, json, hash, now as i64],
        )?;
        Ok(changed)
    }

    pub fn set_source(&self, key: &str, url: &str, sha256: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE paintings SET source_url = ?2, source_sha256 = ?3 WHERE key = ?1",
            params![key, url, sha256],
        )?;
        Ok(())
    }

    /// (key, source sha) for eligible pool paintings that have a master image,
    /// unfinished ones first (so `--limit` makes progress).
    pub fn renderable(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT p.key, p.source_sha256 FROM paintings p JOIN pool ON pool.key = p.key
             WHERE p.eligible = 1 AND p.source_sha256 IS NOT NULL ORDER BY p.ready, p.key",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    // ---------------- crops ----------------

    /// name → input hash for a painting's existing crops.
    pub fn crop_hashes(&self, key: &str) -> Result<HashMap<String, String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT name, input_hash FROM crops WHERE key = ?1")?;
        let rows = stmt
            .query_map([key], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    pub fn put_crop(
        &self,
        key: &str,
        name: &str,
        input_hash: &str,
        plan: &CropPlan,
        path: &str,
        bytes: usize,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO crops (key, name, input_hash, plan, path, bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![key, name, input_hash, serde_json::to_string(plan)?, path, bytes as i64],
        )?;
        Ok(())
    }

    /// After rendering a painting: forget crops that aren't in the current set
    /// (`names`, e.g. after a layout change), collect the crop plans, and mark it
    /// ready when every crop exists.
    pub fn finish_painting(&self, key: &str, names: &[String]) -> Result<()> {
        let keep = serde_json::to_string(names)?;
        self.conn.execute(
            "DELETE FROM crops WHERE key = ?1 AND name NOT IN (SELECT value FROM json_each(?2))",
            params![key, keep],
        )?;
        self.conn.execute(
            "UPDATE paintings SET
               plans = (SELECT json_group_object(name, json(plan)) FROM crops WHERE key = ?1),
               ready = ((SELECT count(*) FROM crops WHERE key = ?1) >= ?2)
             WHERE key = ?1",
            params![key, names.len() as i64],
        )?;
        Ok(())
    }

    pub fn transaction<T>(&mut self, f: impl FnOnce(&Catalog) -> Result<T>) -> Result<T> {
        self.conn.execute_batch("BEGIN")?;
        match f(self) {
            Ok(v) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    // ---------------- wiki ----------------

    pub fn set_wiki(&mut self, links: &HashMap<String, WikiLinks>) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM wiki", [])?;
        {
            let mut add = tx.prepare("INSERT INTO wiki (object_number, links) VALUES (?1, ?2)")?;
            for (num, l) in links {
                add.execute(params![num, serde_json::to_string(l)?])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    // ---------------- featured ----------------

    /// Paintings that may be Featured: eligible, in the pool, with an object
    /// number (to match Wikipedia articles).
    pub fn featured_candidates(&self) -> Result<Vec<Candidate>> {
        let mut stmt = self.conn.prepare(
            "SELECT p.key, p.object_number, p.meta FROM paintings p JOIN pool ON pool.key = p.key
             WHERE p.eligible = 1 AND p.object_number IS NOT NULL ORDER BY p.key",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (key, object_number, meta) = row?;
            let meta: ArtMeta = serde_json::from_str(&meta)?;
            out.push(Candidate {
                key,
                object_number,
                title: meta.title,
                artist: meta.artist,
            });
        }
        Ok(out)
    }

    pub fn stats(&self) -> Result<Stats> {
        let n = |sql: &str| -> Result<i64> { Ok(self.conn.query_row(sql, [], |r| r.get(0))?) };
        Ok(Stats {
            pool: n("SELECT count(*) FROM pool")?,
            paintings: n("SELECT count(*) FROM paintings")?,
            eligible: n("SELECT count(*) FROM paintings WHERE eligible = 1")?,
            with_source: n("SELECT count(*) FROM paintings WHERE source_sha256 IS NOT NULL")?,
            ready: n("SELECT count(*) FROM paintings WHERE ready = 1 AND eligible = 1")?,
            crops: n("SELECT count(*) FROM crops")?,
            crop_bytes: n("SELECT coalesce(sum(bytes), 0) FROM crops")?,
        })
    }

    // ---------------- export for git ----------------

    /// One JSON object per line, sorted by key: small, readable diffs in git.
    /// Contains metadata, eras, links and content hashes, no file paths.
    pub fn export_jsonl(&self, path: &Path) -> Result<usize> {
        let mut stmt = self.conn.prepare(
            "SELECT p.key, p.meta, p.meta_hash, p.source_sha256,
                    (SELECT group_concat(era, ',') FROM (SELECT era FROM painting_eras e WHERE e.key = p.key ORDER BY era)),
                    w.links, pool.key IS NOT NULL
             FROM paintings p
             LEFT JOIN wiki w ON w.object_number = p.object_number
             LEFT JOIN pool ON pool.key = p.key
             ORDER BY p.key",
        )?;
        let tmp = path.with_extension("jsonl.tmp");
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut out = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
        let mut count = 0;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            let meta: serde_json::Value = serde_json::from_str(&r.get::<_, String>(1)?)?;
            let eras: Option<String> = r.get(4)?;
            let wiki: Option<String> = r.get(5)?;
            let line = serde_json::json!({
                "key": r.get::<_, String>(0)?,
                "inPool": r.get::<_, bool>(6)?,
                "eras": eras.map(|e| e.split(',').map(str::to_string).collect::<Vec<_>>()).unwrap_or_default(),
                "meta": meta,
                "wiki": wiki.and_then(|w| serde_json::from_str::<serde_json::Value>(&w).ok()),
                "metaSha256": r.get::<_, String>(2)?,
                "sourceSha256": r.get::<_, Option<String>>(3)?,
            });
            serde_json::to_writer(&mut out, &line)?;
            out.write_all(b"\n")?;
            count += 1;
        }
        out.flush()?;
        drop(out);
        std::fs::rename(&tmp, path)?;
        Ok(count)
    }
}

/// `https://id.rijksmuseum.nl/200107928` → `200107928`
pub fn key_of(id: &str) -> &str {
    id.rsplit('/').next().unwrap_or(id)
}

/// Shared setup for catalog and snapshot tests.
#[cfg(test)]
pub(crate) mod testing {
    use std::path::{Path, PathBuf};

    use super::Catalog;
    use crate::{
        era::Era,
        imaging::{CropMode, CropPlan},
        rijks::ArtMeta,
    };

    /// A temporary data directory, removed when dropped.
    pub struct TempDir(PathBuf);

    impl TempDir {
        pub fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("tt-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            Self(dir)
        }

        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    pub const CROP: &str = "144x168-rect-fill";

    pub fn meta(key: &str, title: &str) -> ArtMeta {
        ArtMeta {
            key: key.into(),
            id: format!("https://id.rijksmuseum.nl/{key}"),
            title: title.into(),
            artist: "A".into(),
            date: Some("1642".into()),
            object_number: Some("SK-C-5".into()),
            web_url: "https://example.org".into(),
            iiif_base: Some("https://iiif.micr.io/x".into()),
            image_url: None,
            license: "Public domain".into(),
            license_url: None,
            eligible: true,
            reason: None,
        }
    }

    /// Painting "1" in the pool (1600s), fetched at t=100, with no files yet.
    pub fn fetched(dir: &TempDir) -> Catalog {
        let mut c = Catalog::open(dir.path()).unwrap();
        let ids = vec!["https://id.rijksmuseum.nl/1".to_string()];
        c.set_pool(&ids, &[(Era::C17, ids.clone())]).unwrap();
        c.upsert_painting(&meta("1", "The Night Watch"), 100)
            .unwrap();
        c.set_source("1", "https://iiif/x", "abc").unwrap();
        c
    }

    /// Like `fetched`, plus one crop on record, finished with `expected` crops
    /// (1 = complete) and published.
    pub fn published(dir: &TempDir, expected: usize) -> Catalog {
        let c = fetched(dir);
        let plan = CropPlan {
            mode: CropMode::None,
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
            inner_w: 144,
            inner_h: 168,
        };
        c.put_crop("1", CROP, "h1", &plan, "art/1/c/a.png", 10)
            .unwrap();
        // Crop names to keep: the fixture's crop plus placeholders up to `expected`.
        let names: Vec<String> = std::iter::once(CROP.to_string())
            .chain((1..expected).map(|i| format!("missing-{i}")))
            .collect();
        c.finish_painting("1", &names).unwrap();
        c.publish(&[]).unwrap();
        c
    }
}

#[cfg(test)]
mod tests {
    use super::{testing::*, *};

    #[test]
    fn due_for_fetch_lists_pool_paintings_never_fetched() {
        let dir = TempDir::new("due-new");
        let mut c = Catalog::open(dir.path()).unwrap();
        c.set_pool(&["https://id.rijksmuseum.nl/1".into()], &[])
            .unwrap();

        assert_eq!(
            c.due_for_fetch(100).unwrap(),
            vec!["https://id.rijksmuseum.nl/1".to_string()]
        );
    }

    #[test]
    fn due_for_fetch_skips_paintings_checked_after_the_cutoff() {
        let dir = TempDir::new("due-recent");
        let c = fetched(&dir);

        assert!(c.due_for_fetch(50).unwrap().is_empty());
    }

    #[test]
    fn upsert_painting_reports_a_new_painting_as_changed() {
        let dir = TempDir::new("upsert-new");
        let c = Catalog::open(dir.path()).unwrap();

        assert!(c
            .upsert_painting(&meta("1", "The Night Watch"), 100)
            .unwrap());
    }

    #[test]
    fn upsert_painting_reports_identical_metadata_as_unchanged() {
        let dir = TempDir::new("upsert-same");
        let c = fetched(&dir);

        assert!(!c
            .upsert_painting(&meta("1", "The Night Watch"), 200)
            .unwrap());
    }

    #[test]
    fn upsert_painting_reports_edited_metadata_as_changed() {
        let dir = TempDir::new("upsert-edit");
        let c = fetched(&dir);

        assert!(c
            .upsert_painting(&meta("1", "Night Watch (detail)"), 200)
            .unwrap());
    }

    #[test]
    fn renderable_lists_eligible_paintings_with_a_source() {
        let dir = TempDir::new("renderable");
        let c = fetched(&dir);

        assert_eq!(
            c.renderable().unwrap(),
            vec![("1".to_string(), "abc".to_string())]
        );
    }

    #[test]
    fn crop_hashes_returns_the_stored_input_hash_per_crop() {
        let dir = TempDir::new("hashes");
        let c = published(&dir, 1);

        assert_eq!(
            c.crop_hashes("1").unwrap().get(CROP).map(String::as_str),
            Some("h1")
        );
    }

    #[test]
    fn finish_painting_forgets_crops_outside_the_current_set() {
        let dir = TempDir::new("prune");
        let c = published(&dir, 1);

        c.finish_painting("1", &["other".to_string()]).unwrap();

        assert!(c.crop_hashes("1").unwrap().is_empty());
    }

    #[test]
    fn stats_counts_a_painting_with_all_crops_as_ready() {
        let dir = TempDir::new("stats-ready");
        let c = published(&dir, 1);

        assert_eq!(c.stats().unwrap().ready, 1);
    }

    #[test]
    fn featured_candidates_lists_eligible_paintings_with_title() {
        let dir = TempDir::new("featured-candidates");
        let c = fetched(&dir);

        let candidates = c.featured_candidates().unwrap();

        assert_eq!(
            candidates
                .iter()
                .map(|c| (c.object_number.as_str(), c.title.as_str()))
                .collect::<Vec<_>>(),
            [("SK-C-5", "The Night Watch")]
        );
    }

    #[test]
    fn export_jsonl_writes_eras_for_each_painting() {
        let dir = TempDir::new("export");
        let c = published(&dir, 1);
        let out = dir.path().join("paintings.jsonl");

        c.export_jsonl(&out).unwrap();

        let text = std::fs::read_to_string(&out).unwrap();
        assert!(text.contains("\"eras\":[\"1600s\"]"), "export was: {text}");
    }
}
