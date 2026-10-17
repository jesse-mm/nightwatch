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
    /// Some are still in copyright and get skipped by the license check.
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

impl Era {
    /// The era of a date as the Rijksmuseum writes it ("1642", "c. 1650",
    /// "c. 1880 - c. 1923"): its first year. The search API's `creationDate`
    /// wildcards miss approximate dates, so paintings it doesn't place in an
    /// era pool get one from their date this way.
    pub fn from_date(date: &str) -> Option<Era> {
        let bytes = date.as_bytes();
        let year = (0..bytes.len().saturating_sub(3)).find_map(|i| {
            let digits = &date[i..i + 4];
            let starts_word = i == 0 || !bytes[i - 1].is_ascii_digit();
            let ends_word = bytes.get(i + 4).is_none_or(|b| !b.is_ascii_digit());
            (starts_word && ends_word && digits.bytes().all(|b| b.is_ascii_digit()))
                .then(|| digits.parse::<u32>().ok())
                .flatten()
        })?;
        match year {
            0..=1599 => Some(Era::Before1600),
            1600..=1699 => Some(Era::C17),
            1700..=1799 => Some(Era::C18),
            1800..=1899 => Some(Era::C19),
            1900..=1999 => Some(Era::C20),
            _ => None,
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
        assert_eq!(
            serde_json::from_str::<Era>("\"pre1600\"").unwrap(),
            Era::Before1600
        );
        for e in Era::FILTERED {
            assert_eq!(
                serde_json::from_str::<Era>(&format!("\"{}\"", e.name())).unwrap(),
                e
            );
        }
    }

    #[test]
    fn takes_the_era_from_the_first_year_of_a_date() {
        assert_eq!(Era::from_date("1642"), Some(Era::C17));
        assert_eq!(Era::from_date("c. 1650"), Some(Era::C17));
        assert_eq!(Era::from_date("c. 1880 - c. 1923"), Some(Era::C19));
        assert_eq!(Era::from_date("c. 1465"), Some(Era::Before1600));
        assert_eq!(Era::from_date("1905-1910"), Some(Era::C20));
        assert_eq!(Era::from_date("2012"), None);
        assert_eq!(Era::from_date("undated"), None);
        assert_eq!(Era::from_date("16th century"), None);
    }

    #[test]
    fn appends_date_filter() {
        assert_eq!(
            with_date("https://x/search?type=painting", "16*"),
            "https://x/search?type=painting&creationDate=16*"
        );
        assert_eq!(
            with_date("https://x/search", "16*"),
            "https://x/search?creationDate=16*"
        );
    }
}
