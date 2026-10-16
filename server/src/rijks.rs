//! Talking to the Rijksmuseum data services (<https://data.rijksmuseum.nl/docs>/).
//!
//! Two services are used:
//!
//! 1. **Search API** – returns pages of object ids (`https://id.rijksmuseum.nl/…`)
//!    matching our filter (paintings that have an image). We crawl it once to
//!    build a pool to pick random paintings from.
//! 2. **Linked Art records** – each id resolves to JSON-LD describing the object.
//!    The image is not on the object itself but a couple of links away:
//!    `object → shows (VisualItem) → digitally_shown_by (DigitalObject) →
//!    access_point` which is a IIIF Image API URL.
//!
//! The JSON-LD is large and nested, so instead of modeling every type we read
//! it as untyped `serde_json::Value` and pick out what we need with small,
//! forgiving helpers. If the museum adds or moves a field, we degrade instead of
//! failing (TS analogy: optional chaining everywhere).

use std::{sync::Arc, time::Duration};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::throttle::Throttle;

/// Linked Art is the default JSON-LD profile. Don't send `profile=` here: the
/// Rijks resolver answers 400 "Unsupported mediatype" when it's present.
const LA_ACCEPT: &str = "application/ld+json, application/json;q=0.8";
/// Getty AAT concept for "English" — preferred language for titles.
const AAT_ENGLISH: &str = "300388277";

/// Client for the Rijksmuseum services. Every request (metadata, search pages,
/// IIIF images) waits for the shared throttle, so the generator never sends more
/// than its configured rate however it's used.
#[derive(Clone)]
pub struct Rijks {
    http: reqwest::Client,
    throttle: Arc<Throttle>,
}

/// Everything the watch/settings page needs to know about a painting.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtMeta {
    /// Short id used in our URLs (last path segment of the Rijks id).
    pub key: String,
    /// Full persistent identifier, e.g. <https://id.rijksmuseum.nl/200107928>
    pub id: String,
    pub title: String,
    pub artist: String,
    pub date: Option<String>,
    pub object_number: Option<String>,
    /// Public page for this object on rijksmuseum.nl.
    pub web_url: String,
    /// IIIF Image API base (without region/size/...), when found.
    pub iiif_base: Option<String>,
    /// A full-size image link people can open.
    pub image_url: Option<String>,
    pub license: String,
    pub license_url: Option<String>,
    /// Whether this painting may be shown (public domain / open license).
    pub eligible: bool,
    pub reason: Option<String>,
}

pub struct SearchPage {
    pub ids: Vec<String>,
    pub next: Option<String>,
}

impl Rijks {
    pub fn new(user_agent: &str, throttle: Arc<Throttle>) -> Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent(user_agent)
            .timeout(Duration::from_secs(60))
            .build()?;
        Ok(Self { http, throttle })
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    pub fn throttle(&self) -> &Throttle {
        &self.throttle
    }

    /// GET with the throttle, retries and back-off. "Too many requests" and
    /// server errors pause *all* requests (Retry-After when given), other 4xx fail.
    async fn send(&self, url: &str, accept: Option<&str>) -> Result<reqwest::Response> {
        let mut last_err = anyhow!("no attempt");
        for attempt in 1..=5u64 {
            self.throttle.wait().await;
            let mut req = self.http.get(url);
            if let Some(a) = accept {
                req = req.header("Accept", a);
            }
            let pause = match req.send().await {
                Ok(r) if r.status().is_success() => return Ok(r),
                Ok(r) if r.status().as_u16() == 429 || r.status().is_server_error() => {
                    let pause = retry_after(&r).unwrap_or(Duration::from_secs(30 * attempt));
                    tracing::warn!(status = %r.status(), url, pause_s = pause.as_secs(), "backing off");
                    last_err = anyhow!("{} from {url}", r.status());
                    pause
                }
                Ok(r) => return Err(anyhow!("{} from {url}", r.status())),
                Err(e) => {
                    last_err = e.into();
                    Duration::from_secs(5 * attempt)
                }
            };
            self.throttle.pause(pause).await;
        }
        Err(last_err)
    }

    async fn get_json(&self, url: &str) -> Result<Value> {
        let r = self.send(url, Some(LA_ACCEPT)).await?;
        r.json::<Value>()
            .await
            .with_context(|| format!("invalid JSON from {url}"))
    }

    /// Download a file (e.g. a IIIF image), throttled like everything else.
    pub async fn download(&self, url: &str) -> Result<Vec<u8>> {
        Ok(self.send(url, None).await?.bytes().await?.to_vec())
    }

    /// Run a Wikidata SPARQL query through the same throttle and back-off
    /// (the query service answers 429 when it's busy).
    pub async fn sparql(&self, query: &str) -> Result<Value> {
        let url = reqwest::Url::parse_with_params(
            "https://query.wikidata.org/sparql",
            [("query", query)],
        )?;
        let r = self
            .send(url.as_str(), Some("application/sparql-results+json"))
            .await?;
        r.json::<Value>()
            .await
            .context("invalid JSON from Wikidata")
    }

    pub async fn search_page(&self, url: &str) -> Result<SearchPage> {
        let v = self.get_json(url).await?;
        let ids = v
            .get("orderedItems")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|i| id_of(i).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let next = v.get("next").and_then(id_of).map(str::to_string);
        Ok(SearchPage { ids, next })
    }

    /// Resolve an object id to its metadata, following links to find the image.
    pub async fn resolve(&self, id: &str, pd_fallback_year: i32) -> Result<ArtMeta> {
        let obj = self.get_json(id).await?;

        // Follow object → VisualItem(s) → DigitalObject(s).
        let mut visual_items = Vec::new();
        let mut digital_docs = Vec::new();
        for vi_id in link_ids(&obj, "shows").into_iter().take(3) {
            let Ok(vi) = self.get_json(&vi_id).await else {
                continue;
            };
            for do_id in link_ids(&vi, "digitally_shown_by").into_iter().take(3) {
                if let Ok(d) = self.get_json(&do_id).await {
                    digital_docs.push(d);
                }
            }
            visual_items.push(vi);
        }

        // Image: look in the digital objects first, then the visual items (some
        // records embed the digital object instead of linking it), then anywhere.
        let iiif = digital_docs
            .iter()
            .chain(visual_items.iter())
            .chain(std::iter::once(&obj))
            .find_map(|d| find_string(d, &|s| is_iiif(s)))
            .map(str::to_string);
        let iiif_base = iiif.as_deref().map(iiif_base_of);
        let image_url = iiif_base
            .as_ref()
            .map(|b| format!("{b}/full/max/0/default.jpg"));

        let title = title_of(&obj).unwrap_or_else(|| "Untitled".into());
        let artist = self
            .artist_of(&obj)
            .await
            .unwrap_or_else(|| "Unknown artist".into());
        let (date, year) = date_of(&obj);
        let object_number = object_number_of(&obj);
        let key = id.rsplit('/').next().unwrap_or(id).to_string();
        let web_url = match &object_number {
            Some(n) => format!("https://www.rijksmuseum.nl/en/collection/{n}"),
            None => id.to_string(),
        };

        // License: the image's rights live in `subject_to` on the VisualItem (or
        // its DigitalObject). Records also carry a CC0 under `subject_of →
        // subject_to`, but that covers the *metadata text*, not the artwork.
        let licenses: Vec<String> = visual_items
            .iter()
            .chain(digital_docs.iter())
            .flat_map(image_rights)
            .map(str::to_string)
            .collect();

        let (license, license_url, mut eligible, mut reason) =
            judge_license(&licenses, year, pd_fallback_year);
        if iiif_base.is_none() {
            eligible = false;
            reason = Some("no IIIF image found".into());
        }

        Ok(ArtMeta {
            key,
            id: id.to_string(),
            title,
            artist,
            date,
            object_number,
            web_url,
            iiif_base,
            image_url,
            license,
            license_url,
            eligible,
            reason,
        })
    }

    async fn artist_of(&self, obj: &Value) -> Option<String> {
        let prod = obj.get("produced_by")?;
        let mut actors: Vec<&Value> = Vec::new();
        collect_key(prod, "carried_out_by", &mut actors);
        for a in actors.iter().flat_map(|a| as_list(a)) {
            if let Some(name) = name_of(a) {
                return Some(name);
            }
            if let Some(aid) = id_of(a) {
                if let Ok(doc) = self.get_json(aid).await {
                    if let Some(name) = name_of(&doc) {
                        return Some(name);
                    }
                }
            }
        }
        // Fall back to a free-text statement like "painter: Rembrandt van Rijn".
        let mut statements = Vec::new();
        collect_key(prod, "referred_to_by", &mut statements);
        statements
            .iter()
            .flat_map(|s| as_list(s))
            .find_map(|s| s.get("content").and_then(Value::as_str))
            .map(|s| s.rsplit(':').next().unwrap_or(s).trim().to_string())
    }
}

fn retry_after(r: &reqwest::Response) -> Option<Duration> {
    let secs: u64 = r
        .headers()
        .get("retry-after")?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()?;
    Some(Duration::from_secs(secs.min(3600)))
}

// ---------- license rules ----------

fn is_license(s: &str) -> bool {
    s.contains("creativecommons.org/") || s.contains("rightsstatements.org/")
}

/// License URLs from a record's own `subject_to` (not nested `subject_of`).
fn image_rights(doc: &Value) -> Vec<&str> {
    doc.get("subject_to")
        .map(|r| all_strings(r, &|s| is_license(s)))
        .unwrap_or_default()
}

/// Returns (label, url, eligible, reason).
pub fn judge_license(
    licenses: &[String],
    year: Option<i32>,
    pd_fallback_year: i32,
) -> (String, Option<String>, bool, Option<String>) {
    let pick = |needle: &str| licenses.iter().find(|l| l.contains(needle)).cloned();
    if let Some(u) = pick("publicdomain/zero") {
        return ("Public domain (CC0 1.0)".into(), Some(u), true, None);
    }
    if let Some(u) = pick("publicdomain/mark") {
        return ("Public domain".into(), Some(u), true, None);
    }
    if let Some(u) = pick("licenses/by-sa/") {
        return ("CC BY-SA".into(), Some(u), true, None);
    }
    if let Some(u) = pick("licenses/by/") {
        return ("CC BY".into(), Some(u), true, None);
    }
    if let Some(u) = licenses.first() {
        return (
            "Restricted".into(),
            Some(u.clone()),
            false,
            Some(format!("license not open: {u}")),
        );
    }
    match year {
        Some(y) if pd_fallback_year > 0 && y <= pd_fallback_year => {
            ("Public domain (made before 1850)".into(), None, true, None)
        }
        _ => (
            "Unknown".into(),
            None,
            false,
            Some("no license statement".into()),
        ),
    }
}

// ---------- small JSON helpers ----------

fn as_list(v: &Value) -> Vec<&Value> {
    match v {
        Value::Array(a) => a.iter().collect(),
        other => vec![other],
    }
}

fn id_of(v: &Value) -> Option<&str> {
    match v {
        Value::String(s) => Some(s),
        Value::Object(o) => o.get("id").or_else(|| o.get("@id")).and_then(Value::as_str),
        _ => None,
    }
}

fn link_ids(doc: &Value, key: &str) -> Vec<String> {
    let mut found = Vec::new();
    collect_key(doc, key, &mut found);
    found
        .iter()
        .flat_map(|v| as_list(v))
        .filter_map(id_of)
        .filter(|s| s.starts_with("http"))
        .map(str::to_string)
        .collect()
}

/// Collect every value stored under `key`, at any depth.
fn collect_key<'a>(v: &'a Value, key: &str, out: &mut Vec<&'a Value>) {
    match v {
        Value::Object(o) => {
            for (k, child) in o {
                if k == key {
                    out.push(child);
                }
                collect_key(child, key, out);
            }
        }
        Value::Array(a) => a.iter().for_each(|c| collect_key(c, key, out)),
        _ => {}
    }
}

fn find_string<'a>(v: &'a Value, pred: &dyn Fn(&str) -> bool) -> Option<&'a str> {
    match v {
        Value::String(s) if pred(s) => Some(s),
        Value::Object(o) => o.values().find_map(|c| find_string(c, pred)),
        Value::Array(a) => a.iter().find_map(|c| find_string(c, pred)),
        _ => None,
    }
}

fn all_strings<'a>(v: &'a Value, pred: &dyn Fn(&str) -> bool) -> Vec<&'a str> {
    fn walk<'a>(v: &'a Value, pred: &dyn Fn(&str) -> bool, out: &mut Vec<&'a str>) {
        match v {
            Value::String(s) if pred(s) => out.push(s),
            Value::Object(o) => o.values().for_each(|c| walk(c, pred, out)),
            Value::Array(a) => a.iter().for_each(|c| walk(c, pred, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(v, pred, &mut out);
    out
}

fn is_iiif(s: &str) -> bool {
    s.starts_with("http")
        && (s.contains("iiif.micr.io/") || (s.contains("/iiif/") && s.contains("/full/")))
}

/// `https://iiif.micr.io/AbCd/full/max/0/default.jpg` → `https://iiif.micr.io/AbCd`
pub fn iiif_base_of(url: &str) -> String {
    let url = url.trim_end_matches("/info.json");
    match url.find("/full/") {
        Some(i) => url[..i].to_string(),
        None => url.trim_end_matches('/').to_string(),
    }
}

fn is_type(v: &Value, t: &str) -> bool {
    v.get("type").and_then(Value::as_str) == Some(t)
}

fn is_english(v: &Value) -> bool {
    v.get("language").is_some_and(|l| {
        as_list(l)
            .iter()
            .filter_map(|x| id_of(x))
            .any(|id| id.ends_with(AAT_ENGLISH))
    })
}

fn names(doc: &Value) -> Vec<&Value> {
    doc.get("identified_by")
        .map(|v| {
            as_list(v)
                .into_iter()
                .filter(|n| is_type(n, "Name"))
                .collect()
        })
        .unwrap_or_default()
}

fn title_of(obj: &Value) -> Option<String> {
    let ns = names(obj);
    ns.iter()
        .find(|n| is_english(n))
        .or_else(|| ns.first())
        .and_then(|n| n.get("content").and_then(Value::as_str))
        .or_else(|| obj.get("_label").and_then(Value::as_str))
        .map(|s| s.trim().to_string())
}

fn name_of(doc: &Value) -> Option<String> {
    title_of(doc).or_else(|| {
        doc.get("_label")
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

fn object_number_of(obj: &Value) -> Option<String> {
    obj.get("identified_by").and_then(|v| {
        as_list(v)
            .into_iter()
            .filter(|n| is_type(n, "Identifier"))
            .find_map(|n| n.get("content").and_then(Value::as_str))
            .map(str::to_string)
    })
}

/// (display date, latest year for license fallback)
fn date_of(obj: &Value) -> (Option<String>, Option<i32>) {
    let Some(prod) = obj.get("produced_by") else {
        return (None, None);
    };
    let mut spans = Vec::new();
    collect_key(prod, "timespan", &mut spans);
    let mut display = None;
    let mut year = None;
    for span in spans.iter().flat_map(|s| as_list(s)) {
        if display.is_none() {
            display = span
                .get("identified_by")
                .and_then(|v| {
                    as_list(v)
                        .into_iter()
                        .find_map(|n| n.get("content").and_then(Value::as_str))
                })
                .map(str::to_string);
        }
        for key in ["end_of_the_end", "begin_of_the_end", "begin_of_the_begin"] {
            if let Some(y) = span.get(key).and_then(Value::as_str).and_then(parse_year) {
                year = Some(year.map_or(y, |old: i32| old.max(y)));
                break;
            }
        }
    }
    if display.is_none() {
        display = year.map(|y| y.to_string());
    }
    (display, year)
}

fn parse_year(s: &str) -> Option<i32> {
    let s = s.trim_start_matches('+');
    let neg = s.starts_with('-');
    let digits: String = s
        .trim_start_matches('-')
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    let y: i32 = digits.parse().ok()?;
    Some(if neg { -y } else { y })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn iiif_base_of_strips_region_and_info_json() {
        assert_eq!(
            iiif_base_of("https://iiif.micr.io/AbCd/full/max/0/default.jpg"),
            "https://iiif.micr.io/AbCd"
        );
        assert_eq!(
            iiif_base_of("https://iiif.micr.io/AbCd/info.json"),
            "https://iiif.micr.io/AbCd"
        );
    }

    #[test]
    fn judge_license_allows_cc0_whatever_the_date() {
        let cc0 = ["https://creativecommons.org/publicdomain/zero/1.0/".to_string()];
        assert!(judge_license(&cc0, Some(1990), 1850).2);
    }

    #[test]
    fn judge_license_rejects_in_copyright_even_for_old_works() {
        let inc = ["http://rightsstatements.org/vocab/InC/1.0/".to_string()];
        assert!(!judge_license(&inc, Some(1600), 1850).2);
    }

    #[test]
    fn judge_license_allows_unlicensed_works_made_before_the_fallback_year() {
        assert!(judge_license(&[], Some(1642), 1850).2);
    }

    #[test]
    fn judge_license_rejects_unlicensed_works_made_after_the_fallback_year() {
        assert!(!judge_license(&[], Some(1920), 1850).2);
    }

    #[test]
    fn judge_license_rejects_unlicensed_works_when_the_fallback_is_off() {
        assert!(!judge_license(&[], Some(1642), 0).2);
    }

    #[test]
    fn image_rights_ignores_the_metadata_license() {
        // Shape of a real VisualItem (https://id.rijksmuseum.nl/202109207).
        let vi = json!({
            "type": "VisualItem",
            "subject_to": [{"type": "Right", "classified_as": [
                {"id": "https://creativecommons.org/publicdomain/mark/1.0/", "type": "Type"}
            ]}],
            "subject_of": [{"subject_to": [{"type": "Right", "classified_as": [
                {"id": "https://creativecommons.org/publicdomain/zero/1.0/", "type": "Type"}
            ]}]}]
        });
        assert_eq!(
            image_rights(&vi),
            vec!["https://creativecommons.org/publicdomain/mark/1.0/"]
        );
    }

    #[test]
    fn reads_linked_art_basics() {
        let obj = json!({
            "id": "https://id.rijksmuseum.nl/200107928",
            "identified_by": [
                {"type": "Identifier", "content": "SK-C-5"},
                {"type": "Name", "content": "De Nachtwacht", "language": [{"id": "http://vocab.getty.edu/aat/300388256"}]},
                {"type": "Name", "content": "The Night Watch", "language": [{"id": "http://vocab.getty.edu/aat/300388277"}]}
            ],
            "produced_by": {"timespan": {
                "identified_by": [{"type": "Name", "content": "1642"}],
                "begin_of_the_begin": "1642-01-01T00:00:00Z",
                "end_of_the_end": "1642-12-31T23:59:59Z"
            }}
        });
        assert_eq!(title_of(&obj).as_deref(), Some("The Night Watch"));
        assert_eq!(object_number_of(&obj).as_deref(), Some("SK-C-5"));
        assert_eq!(date_of(&obj), (Some("1642".into()), Some(1642)));
    }
}
