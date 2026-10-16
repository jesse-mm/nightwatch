//! Popularity, for the "Featured" year: how often a painting's Wikipedia
//! articles were read.
//!
//! The Rijksmuseum publishes no popularity data. Wikipedia does: one SPARQL
//! query lists every Wikipedia article (all languages) about a Rijksmuseum
//! painting (~415 paintings, ~1,200 articles), and the Wikimedia pageviews API gives each
//! article's views. The sum over the last 12 full months ranks the paintings;
//! the number of articles breaks ties.

use std::collections::HashMap;

use anyhow::{Context, Result};
use serde_json::Value;

use crate::rijks::Rijks;

/// Every Wikipedia article about a Rijksmuseum painting (SK-… numbers).
/// Filtering on the URL is much cheaper than joining on `wikibase:wikiGroup`,
/// which runs into the query service's 60 s limit (~3 s vs. a 504).
const QUERY: &str = r#"SELECT ?inv ?article WHERE {
  ?item p:P217 ?st . ?st ps:P217 ?inv ; pq:P195 wd:Q190804 .
  FILTER(STRSTARTS(?inv, "SK-"))
  ?article schema:about ?item .
  FILTER(CONTAINS(STR(?article), ".wikipedia.org/"))
}"#;

/// Object number → Wikipedia article URLs.
pub async fn articles(rijks: &Rijks) -> Result<HashMap<String, Vec<String>>> {
    Ok(parse_articles(&rijks.sparql(QUERY).await?))
}

fn parse_articles(body: &Value) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    let rows = body.pointer("/results/bindings").and_then(Value::as_array);
    for row in rows.into_iter().flatten() {
        let field = |k: &str| row.pointer(&format!("/{k}/value")).and_then(Value::as_str);
        if let (Some(inv), Some(article)) = (field("inv"), field("article")) {
            out.entry(inv.to_string())
                .or_default()
                .push(article.to_string());
        }
    }
    for list in out.values_mut() {
        list.sort();
        list.dedup();
    }
    out
}

/// `https://nl.wikipedia.org/wiki/De_Nachtwacht` → `("nl.wikipedia.org", "De_Nachtwacht")`.
/// The title stays percent-encoded, as the pageviews API expects.
fn project_and_title(article: &str) -> Option<(&str, &str)> {
    let rest = article.strip_prefix("https://")?;
    let (host, path) = rest.split_once('/')?;
    let title = path.strip_prefix("wiki/")?;
    (!title.is_empty()).then_some((host, title))
}

/// Views of one article over `[start, end)` months, e.g. ("2025100100", "2026100100").
/// An article the API has no data for counts as 0.
pub async fn views(rijks: &Rijks, article: &str, range: &(String, String)) -> Result<u64> {
    let Some((project, title)) = project_and_title(article) else {
        return Ok(0);
    };
    let (start, end) = range;
    let url = format!(
        "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/{project}/all-access/user/{title}/monthly/{start}/{end}"
    );
    let body = match rijks.download(&url).await {
        Ok(bytes) => bytes,
        // 404 = no views recorded for that article in the range.
        Err(e) if e.to_string().starts_with("404") => return Ok(0),
        Err(e) => return Err(e),
    };
    let json: Value = serde_json::from_slice(&body).context("invalid pageviews JSON")?;
    Ok(sum_views(&json))
}

fn sum_views(json: &Value) -> u64 {
    json.get("items")
        .and_then(Value::as_array)
        .map_or(0, |items| {
            items
                .iter()
                .filter_map(|i| i.get("views").and_then(Value::as_u64))
                .sum()
        })
}

/// The last 12 full months before `now` (unix seconds), as pageviews API
/// timestamps: from the first of this month a year ago up to the first of this
/// month. Monthly data only covers complete months, so this month is excluded.
pub fn last_twelve_months(now: u64) -> (String, String) {
    let (year, month) = year_month(now);
    (
        format!("{:04}{month:02}0100", year - 1),
        format!("{year:04}{month:02}0100"),
    )
}

/// Calendar (year, month) of a unix time in UTC.
pub fn year_month(unix: u64) -> (i64, u32) {
    // Howard Hinnant's civil_from_days.
    let days = (unix / 86_400) as i64 + 719_468;
    let era = days.div_euclid(146_097);
    let doe = days - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_articles_groups_by_object_number() {
        let body = json!({"results": {"bindings": [
            {"inv": {"value": "SK-C-5"}, "article": {"value": "https://en.wikipedia.org/wiki/The_Night_Watch"}},
            {"inv": {"value": "SK-C-5"}, "article": {"value": "https://nl.wikipedia.org/wiki/De_Nachtwacht"}},
        ]}});
        assert_eq!(parse_articles(&body)["SK-C-5"].len(), 2);
    }

    #[test]
    fn project_and_title_keeps_the_encoded_title() {
        assert_eq!(
            project_and_title("https://fr.wikipedia.org/wiki/La_Ronde_de_nuit_%28Rembrandt%29"),
            Some(("fr.wikipedia.org", "La_Ronde_de_nuit_%28Rembrandt%29"))
        );
    }

    #[test]
    fn sum_views_adds_every_month() {
        let json = json!({"items": [{"views": 10}, {"views": 32}]});
        assert_eq!(sum_views(&json), 42);
    }

    #[test]
    fn year_month_reads_a_known_date() {
        // 2026-10-16T00:00:00Z
        assert_eq!(year_month(1_792_108_800), (2026, 10));
    }

    #[test]
    fn last_twelve_months_ends_at_the_start_of_this_month() {
        assert_eq!(
            last_twelve_months(1_792_108_800),
            ("2025100100".to_string(), "2026100100".to_string())
        );
    }

    #[test]
    fn last_twelve_months_in_december_covers_this_year() {
        // 2026-12-05
        assert_eq!(
            last_twelve_months(1_796_428_800),
            ("2025120100".to_string(), "2026120100".to_string())
        );
    }
}
