//! Wikidata and Wikipedia links for paintings.
//!
//! The Rijksmuseum records don't link to Wikidata, but Wikidata stores each
//! painting's inventory number (P217) qualified by collection = Rijksmuseum
//! (P195 = Q190804). One SPARQL query returns all of them (≈6,000 rows, ~1 MB),
//! so we fetch the whole table now and then and look paintings up by object
//! number locally, instead of one rate-limited API call per painting.

use std::{collections::HashMap, time::Duration};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const ENDPOINT: &str = "https://query.wikidata.org/sparql";

/// Paintings (SK-… inventory numbers) in the Rijksmuseum, with their English and
/// Dutch Wikipedia articles when they have one.
const QUERY: &str = r#"SELECT ?item ?inv ?en ?nl WHERE {
  ?item p:P217 ?st . ?st ps:P217 ?inv ; pq:P195 wd:Q190804 .
  FILTER(STRSTARTS(?inv, "SK-"))
  OPTIONAL { ?en schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }
  OPTIONAL { ?nl schema:about ?item ; schema:isPartOf <https://nl.wikipedia.org/> . }
}"#;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiLinks {
    pub wikidata: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wikipedia_en: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wikipedia_nl: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
pub struct WikiTable {
    /// Unix seconds.
    pub built_at: u64,
    /// Keyed by Rijksmuseum object number, e.g. "SK-C-5".
    pub links: HashMap<String, WikiLinks>,
}

pub async fn fetch(http: &reqwest::Client) -> Result<HashMap<String, WikiLinks>> {
    let body: Value = http
        .get(ENDPOINT)
        .query(&[("query", QUERY)])
        .header("Accept", "application/sparql-results+json")
        .timeout(Duration::from_secs(90))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
        .context("invalid JSON from Wikidata")?;
    Ok(parse(&body))
}

fn parse(body: &Value) -> HashMap<String, WikiLinks> {
    let value = |row: &Value, key: &str| {
        row.get(key).and_then(|v| v.get("value")).and_then(Value::as_str).map(str::to_string)
    };
    let mut out: HashMap<String, WikiLinks> = HashMap::new();
    let rows = body.pointer("/results/bindings").and_then(Value::as_array);
    for row in rows.into_iter().flatten() {
        let (Some(inv), Some(item)) = (value(row, "inv"), value(row, "item")) else { continue };
        // A few numbers appear twice (duplicate items); keep the first item and
        // any article either row has.
        let entry = out.entry(inv).or_insert_with(|| WikiLinks {
            wikidata: item.replace("http://www.wikidata.org/entity/", "https://www.wikidata.org/wiki/"),
            ..Default::default()
        });
        entry.wikipedia_en = entry.wikipedia_en.take().or_else(|| value(row, "en"));
        entry.wikipedia_nl = entry.wikipedia_nl.take().or_else(|| value(row, "nl"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_sparql_rows() {
        let body = json!({"results": {"bindings": [
            {"item": {"value": "http://www.wikidata.org/entity/Q219831"}, "inv": {"value": "SK-C-5"},
             "en": {"value": "https://en.wikipedia.org/wiki/The_Night_Watch"}},
            {"item": {"value": "http://www.wikidata.org/entity/Q219831"}, "inv": {"value": "SK-C-5"},
             "nl": {"value": "https://nl.wikipedia.org/wiki/De_Nachtwacht"}},
            {"item": {"value": "http://www.wikidata.org/entity/Q17342494"}, "inv": {"value": "SK-C-302"}}
        ]}});
        let t = parse(&body);
        let nw = &t["SK-C-5"];
        assert_eq!(nw.wikidata, "https://www.wikidata.org/wiki/Q219831");
        assert_eq!(nw.wikipedia_en.as_deref(), Some("https://en.wikipedia.org/wiki/The_Night_Watch"));
        assert_eq!(nw.wikipedia_nl.as_deref(), Some("https://nl.wikipedia.org/wiki/De_Nachtwacht"));
        assert_eq!(t["SK-C-302"].wikipedia_en, None);
    }
}
