//! "Paintings from" filter: a century of creation.
//!
//! The Rijksmuseum Search API has no date range, but `creationDate` accepts
//! wildcards (`16*` = any date string starting with 16), so each era is one or
//! more wildcard searches. Paintings whose date doesn't parse that way are only in
//! the "any" pool.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Deserialize, Serialize)]
pub enum Era {
    #[default]
    #[serde(rename = "any")]
    Any,
    /// 1300s–1500s are small collections (≈250 paintings together), so one group.
    #[serde(rename = "pre1600")]
    Before1600,
    #[serde(rename = "1600s")]
    C17,
    #[serde(rename = "1700s")]
    C18,
    #[serde(rename = "1800s")]
    C19,
    /// Some are still in copyright and get skipped by the licence check.
    #[serde(rename = "1900s")]
    C20,
}

impl Era {
    pub const FILTERED: [Era; 5] = [Era::Before1600, Era::C17, Era::C18, Era::C19, Era::C20];

    pub fn name(self) -> &'static str {
        match self {
            Era::Any => "any",
            Era::Before1600 => "pre1600",
            Era::C17 => "1600s",
            Era::C18 => "1700s",
            Era::C19 => "1800s",
            Era::C20 => "1900s",
        }
    }

    /// `creationDate` wildcard patterns for the Search API.
    pub fn patterns(self) -> &'static [&'static str] {
        match self {
            Era::Any => &[],
            Era::Before1600 => &["13*", "14*", "15*"],
            Era::C17 => &["16*"],
            Era::C18 => &["17*"],
            Era::C19 => &["18*"],
            Era::C20 => &["19*"],
        }
    }
}

/// Add a creationDate filter to a search URL that may already have a query.
pub fn with_date(search_url: &str, pattern: &str) -> String {
    let sep = if search_url.contains('?') { '&' } else { '?' };
    format!("{search_url}{sep}creationDate={pattern}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_query_values() {
        let e: Era = serde_json::from_str("\"1600s\"").unwrap();
        assert_eq!(e, Era::C17);
        assert_eq!(serde_json::from_str::<Era>("\"pre1600\"").unwrap(), Era::Before1600);
        for e in Era::FILTERED {
            assert_eq!(serde_json::from_str::<Era>(&format!("\"{}\"", e.name())).unwrap(), e);
        }
    }

    #[test]
    fn appends_date_filter() {
        assert_eq!(
            with_date("https://x/search?type=painting", "16*"),
            "https://x/search?type=painting&creationDate=16*"
        );
        assert_eq!(with_date("https://x/search", "16*"), "https://x/search?creationDate=16*");
    }
}
