//! The Featured list: 365 paintings, one per day of the year, kept in
//! `catalog/featured.json` (in git).
//!
//! Wikipedia readership barely changes month to month, so the list is built
//! once (or with `--refresh-featured`, e.g. yearly) and then simply read: no
//! popularity requests on normal runs. The file lists paintings in rank order
//! with title, artist and the numbers behind the rank, so a diff shows what
//! changed and it can be edited by hand. The day-of-year order is a fixed
//! shuffle per year (`day_order`), so famous works are spread over the year.

use std::{collections::HashMap, path::Path};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::variants;

/// One painting per day of the year.
pub const SIZE: usize = 365;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeaturedFile {
    /// Date the list was built (YYYY-MM-DD).
    pub generated: String,
    /// How the list was ranked, for people reading the file.
    pub ranking: String,
    pub paintings: Vec<Entry>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub key: String,
    pub object_number: String,
    pub title: String,
    pub artist: String,
    /// Wikipedia articles about the painting (all languages).
    pub articles: usize,
    /// Their views over the ranking period, when pageviews were fetched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub views: Option<u64>,
}

/// A painting that may be featured: eligible and in the pool.
#[derive(Clone, Debug)]
pub struct Candidate {
    pub key: String,
    pub object_number: String,
    pub title: String,
    pub artist: String,
}

pub fn load(path: &Path) -> Result<Option<FeaturedFile>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(
            serde_json::from_slice(&bytes)
                .with_context(|| format!("invalid {}", path.display()))?,
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("read {}", path.display())),
    }
}

/// Pretty-printed, one painting per block, written atomically.
pub fn save(path: &Path, file: &FeaturedFile) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let mut json = serde_json::to_vec_pretty(file)?;
    json.push(b'\n');
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Rank candidates: most-read first (views, then number of articles), then
/// paintings without a Wikipedia article in a stable pseudo-random order, to
/// fill the year. Returns at most `SIZE` entries.
pub fn rank(
    candidates: Vec<Candidate>,
    articles: &HashMap<String, Vec<String>>,
    views: &HashMap<String, u64>,
) -> Vec<Entry> {
    let (mut known, mut others): (Vec<Entry>, Vec<Entry>) = candidates
        .into_iter()
        .map(|c| Entry {
            articles: articles.get(&c.object_number).map_or(0, Vec::len),
            views: views.get(&c.object_number).copied(),
            key: c.key,
            object_number: c.object_number,
            title: c.title,
            artist: c.artist,
        })
        .partition(|e| e.articles > 0);
    known.sort_by(|a, b| {
        b.views
            .cmp(&a.views)
            .then(b.articles.cmp(&a.articles))
            .then_with(|| a.key.cmp(&b.key))
    });
    others.sort_by_cached_key(|e| variants::hash(&["featured-fill", &e.key]));
    known.extend(others);
    known.truncate(SIZE);
    known
}

/// The day-of-year order for `year`: a fixed shuffle, so day N is the same
/// painting all year and famous works aren't all in January.
pub fn day_order(keys: &[String], year: i64) -> Vec<String> {
    let seed = year.to_string();
    let mut out = keys.to_vec();
    out.sort_by_cached_key(|k| variants::hash(&[&seed, k]));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(key: &str, num: &str) -> Candidate {
        Candidate {
            key: key.into(),
            object_number: num.into(),
            title: format!("Painting {key}"),
            artist: "A".into(),
        }
    }

    fn articles(pairs: &[(&str, usize)]) -> HashMap<String, Vec<String>> {
        pairs
            .iter()
            .map(|(n, count)| (n.to_string(), vec![String::new(); *count]))
            .collect()
    }

    #[test]
    fn rank_puts_the_most_viewed_painting_first() {
        let views = HashMap::from([("A".to_string(), 10), ("B".to_string(), 500)]);
        let ranked = rank(
            vec![candidate("1", "A"), candidate("2", "B")],
            &articles(&[("A", 1), ("B", 1)]),
            &views,
        );
        assert_eq!(ranked[0].key, "2");
    }

    #[test]
    fn rank_uses_article_counts_without_views() {
        let ranked = rank(
            vec![candidate("1", "A"), candidate("2", "B")],
            &articles(&[("A", 3), ("B", 40)]),
            &HashMap::new(),
        );
        assert_eq!(ranked[0].key, "2");
    }

    #[test]
    fn rank_fills_up_with_paintings_without_articles() {
        let ranked = rank(
            vec![candidate("1", "A"), candidate("2", "B")],
            &articles(&[("A", 1)]),
            &HashMap::new(),
        );
        assert_eq!(
            ranked.iter().map(|e| e.key.as_str()).collect::<Vec<_>>(),
            ["1", "2"]
        );
    }

    #[test]
    fn rank_keeps_at_most_a_year_of_paintings() {
        let many = (0..400)
            .map(|i| candidate(&i.to_string(), &format!("N{i}")))
            .collect();
        assert_eq!(rank(many, &HashMap::new(), &HashMap::new()).len(), SIZE);
    }

    #[test]
    fn day_order_is_the_same_within_a_year() {
        let keys: Vec<String> = (0..20).map(|i| i.to_string()).collect();
        assert_eq!(day_order(&keys, 2026), day_order(&keys, 2026));
    }

    #[test]
    fn day_order_changes_between_years() {
        let keys: Vec<String> = (0..20).map(|i| i.to_string()).collect();
        assert_ne!(day_order(&keys, 2026), day_order(&keys, 2027));
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = std::env::temp_dir().join(format!("tt-featured-{}", std::process::id()));
        let path = dir.join("featured.json");
        let file = FeaturedFile {
            generated: "2026-10-16".into(),
            ranking: "test".into(),
            paintings: vec![Entry {
                key: "1".into(),
                object_number: "SK-C-5".into(),
                title: "The Night Watch".into(),
                artist: "Rembrandt".into(),
                articles: 56,
                views: Some(263_901),
            }],
        };
        save(&path, &file).unwrap();
        let loaded = load(&path).unwrap().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(loaded.paintings, file.paintings);
    }

    #[test]
    fn load_returns_none_when_the_file_is_missing() {
        assert!(load(Path::new("/nonexistent/featured.json"))
            .unwrap()
            .is_none());
    }
}
