use crate::protocol::Failure;
use muz::{compile::Compiled, inspect::PageRequest, model::TrackSource};
use serde_json::{json, Map, Value};
use std::io::{self, Write};

const MAX_ROWS: usize = muz::inspect::MAX_PAGE_ROWS;
const MAX_BYTES: usize = muz::inspect::MAX_PAGE_BYTES;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const INITIAL_VIEWS: [&str; 6] = [
    "summary", "graph", "sections", "track_groups", "locations", "diagnostics",
];

fn invalid(message: impl Into<String>) -> Failure {
    Failure::new("invalid_request", "inspect", message)
}

fn too_large() -> Failure {
    Failure::new("too_large", "inspect", "Inspection page exceeds 1 MiB; request fewer rows")
}

fn core_error(error: anyhow::Error) -> Failure {
    let message = error.to_string();
    let code = if message.contains("MiB") { "too_large" } else { "invalid_request" };
    let mut failure = Failure::new(code, "inspect", message);
    if let Some(diagnostic) = error.downcast_ref::<muz::lang::Diagnostic>() {
        let value = diagnostic.to_json();
        failure.location = value.get("location").filter(|v| !v.is_null()).cloned();
        failure.callers = value.get("callers").filter(|v| !v.is_null()).cloned();
        failure.path = value.get("path").and_then(Value::as_str).map(str::to_owned);
        failure.help = value.get("help").and_then(Value::as_array).map(|items| {
            items.iter().filter_map(Value::as_str).map(str::to_owned).collect()
        });
    }
    failure
}

// Count the actual JSON envelope, not just the rows, without allocating encoded bytes.
fn bounded_size(value: &Value) -> Result<usize, Failure> {
    struct Counter(usize);
    impl Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if bytes.len() > MAX_BYTES.saturating_sub(self.0) {
                return Err(io::Error::other("inspection byte limit exceeded"));
            }
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> { Ok(()) }
    }
    let mut counter = Counter(0);
    serde_json::to_writer(&mut counter, value).map_err(|_| too_large())?;
    Ok(counter.0)
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, Failure> {
    value.get(key).and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("{key} must be a string")))
}

fn integer(value: &Value, key: &str, default: usize) -> Result<usize, Failure> {
    let Some(value) = value.get(key) else { return Ok(default) };
    let number = value.as_u64().filter(|n| *n <= MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid(format!("{key} must be a nonnegative safe integer")))?;
    usize::try_from(number).map_err(|_| invalid(format!("{key} exceeds the platform range")))
}

fn tick(value: &Value, key: &str) -> Result<Option<u64>, Failure> {
    let Some(value) = value.get(key) else { return Ok(None) };
    let value = value.as_str().ok_or_else(|| invalid(format!("{key} must be a decimal tick string")))?;
    if value.is_empty() || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(invalid(format!("{key} must be a canonical unsigned decimal string")));
    }
    value.parse().map(Some).map_err(|_| invalid(format!("{key} exceeds u64")))
}

fn page_request(value: Option<&Value>) -> Result<PageRequest, Failure> {
    let Some(value) = value else { return Ok(PageRequest::default()) };
    let object = value.as_object().ok_or_else(|| invalid("page must be an object"))?;
    if object.keys().any(|key| !matches!(key.as_str(), "offset" | "limit" | "track" | "start_tick" | "end_tick")) {
        return Err(invalid("Unknown page field"));
    }
    let request = PageRequest {
        revision: None,
        offset: integer(value, "offset", 0)?,
        limit: integer(value, "limit", 100)?,
        track: value.get("track").map(|_| text(value, "track").map(str::to_owned)).transpose()?,
        start_tick: tick(value, "start_tick")?,
        end_tick: tick(value, "end_tick")?,
    };
    if request.limit == 0 || request.limit > MAX_ROWS {
        return Err(invalid("page limit must be between 1 and 1000"));
    }
    if matches!((request.start_tick, request.end_tick), (Some(start), Some(end)) if start >= end) {
        return Err(invalid("start_tick must be less than end_tick"));
    }
    Ok(request)
}

fn complete_page(rows: usize, total: usize, request: &PageRequest) -> Result<(), Failure> {
    // Core pages can stop early on their row-byte budget. The desktop contract
    // rejects that requested page rather than returning silently shortened rows.
    if rows != total.saturating_sub(request.offset).min(request.limit) {
        return Err(too_large());
    }
    Ok(())
}

fn inspect_page(compiled: &Compiled, reference: &Value, view: &str, request: &PageRequest) -> Result<Value, Failure> {
    let page = muz::inspect::page_compiled(compiled, 0, view, request).map_err(core_error)?;
    complete_page(page.rows.len(), page.total, request)?;
    let value = json!({"ref": reference, "view": view, "rows": page.rows, "total": page.total, "next": page.next});
    bounded_size(&value)?;
    Ok(value)
}

pub fn inspect(accepted: &super::Accepted, args: &Value) -> Result<Value, Failure> {
    inspect_page(&accepted.compiled, &accepted.reference, text(args, "view")?, &page_request(args.get("page"))?)
}

pub fn initial_pages(compiled: &Compiled, reference: &Value, budget: usize) -> Result<Value, Failure> {
    let mut limit = 100;
    loop {
        let attempt: Result<Value, Failure> = (|| {
            let request = PageRequest { limit, ..PageRequest::default() };
            let mut pages = Map::new();
            let mut bytes = 0;
            for view in INITIAL_VIEWS {
                let page = inspect_page(compiled, reference, view, &request)?;
                bytes += bounded_size(&page)?;
                if bytes > budget.min(MAX_BYTES) { return Err(too_large()) }
                pages.insert(view.into(), page);
            }
            let value = Value::Object(pages);
            if bounded_size(&value)? > budget.min(MAX_BYTES) { return Err(too_large()) }
            Ok(value)
        })();
        match attempt {
            Err(failure) if failure.code == "too_large" && limit > 1 => limit = (limit / 2).max(1),
            result => return result,
        }
    }
}

pub fn export_tracks(compiled: &Compiled) -> Value {
    Value::Array(compiled.session.tracks.iter().map(|track| {
        json!({"id": track.id, "name": track.name, "midi": matches!(&track.source, TrackSource::Midi(_))})
    }).collect())
}

pub fn location(accepted: &super::Accepted, args: &Value) -> Result<Value, Failure> {
    let value = serde_json::to_value(accepted.compiled.locations.get(text(args, "key")?))
        .map_err(|error| invalid(error.to_string()))?;
    bounded_size(&value)?;
    Ok(value)
}

pub fn explain(accepted: &super::Accepted, args: &Value) -> Result<Value, Failure> {
    let track = text(args, "track")?;
    let query = args.get("query").and_then(Value::as_object)
        .ok_or_else(|| invalid("query must be an object"))?;
    if query.keys().any(|key| !matches!(key.as_str(), "key" | "offset" | "limit")) {
        return Err(invalid("Unknown explanation query field"));
    }
    let query_value = &args["query"];
    let offset = integer(query_value, "offset", 0)?;
    let limit = integer(query_value, "limit", 100)?;
    if limit == 0 || limit > MAX_ROWS { return Err(invalid("page limit must be between 1 and 1000")) }
    let compiled = &accepted.compiled;
    let (rows, total, next) = if query.contains_key("key") {
        let key = text(query_value, "key")?;
        let score = compiled.score.iter().find(|candidate| candidate.id == track)
            .ok_or_else(|| invalid(format!("Unknown score track {track}")))?;
        let mut matches = score.pattern.notes.iter().enumerate().filter(|(_, note)| note.key == key);
        let index = matches.next().map(|(index, _)| index);
        if matches.next().is_some() {
            return Err(Failure::new("ambiguous_key", "inspect", format!("Explanation key '{key}' is ambiguous in track '{track}'")));
        }
        let total = usize::from(index.is_some());
        let rows = match index.filter(|_| offset == 0) {
            Some(index) => compiled.explain_notes(track, index, 1).map_err(core_error)?.rows,
            None => Vec::new(),
        };
        complete_page(rows.len(), total, &PageRequest { offset, limit, ..PageRequest::default() })?;
        (rows, total, None)
    } else {
        let page = compiled.explain_notes(track, offset, limit).map_err(core_error)?;
        complete_page(page.rows.len(), page.total, &PageRequest { offset, limit, ..PageRequest::default() })?;
        (page.rows, page.total, page.next)
    };
    let value = json!({"ref": accepted.reference, "rows": rows, "total": total, "next": next});
    bounded_size(&value)?;
    Ok(value)
}

fn overlaps(start: u64, end: u64, request: &PageRequest) -> bool {
    request.end_tick.is_none_or(|bound| start < bound)
        && request.start_tick.is_none_or(|bound| end > bound)
}

fn diff_matches(row: &Value, old: &Compiled, new: &Compiled, request: &PageRequest) -> bool {
    if let Some(track) = request.track.as_deref() {
        let selected = row.get("track").and_then(Value::as_str).map(|id| id == track).unwrap_or_else(|| {
            let id = row.get("id").or_else(|| row.get("device_id")).and_then(Value::as_str);
            [old, new].iter().any(|compiled| compiled.session.tracks.iter().filter(|t| t.id.as_str() == track).any(|t| {
                id.is_some_and(|id| id == t.id.as_str() || id == t.instrument.id.as_str()
                    || t.inserts.iter().any(|device| device.id.as_str() == id)
                    || match &t.source { TrackSource::Pattern(p) => p.id.as_str() == id, TrackSource::Midi(m) => m.id.as_str() == id })
            }))
        });
        if !selected { return false }
    }
    if request.start_tick.is_none() && request.end_tick.is_none() { return true }
    if let (Some(track), Some(key)) = (row.get("track").and_then(Value::as_str), row.get("key").and_then(Value::as_str)) {
        return [old, new].iter().any(|compiled| compiled.score.iter().filter(|t| t.id == track).any(|t| {
            t.pattern.notes.iter().filter(|note| note.key == key).any(|note| overlaps(
                muz::compile::tick(muz::music::real(note.at)),
                muz::compile::tick(muz::music::real(note.at + note.dur)), request))
        }));
    }
    ["before", "after"].iter().filter_map(|key| row.get(*key)).any(|event| {
        if let Some(start) = event.get("start_tick").and_then(Value::as_u64) {
            overlaps(start, start.saturating_add(event.get("duration_ticks").and_then(Value::as_u64).unwrap_or(0)), request)
        } else if let Some(tick) = event.get("tick").and_then(Value::as_u64) {
            request.start_tick.is_none_or(|start| tick >= start) && request.end_tick.is_none_or(|end| tick < end)
        } else { false }
    })
}

pub fn diff(accepted: &super::Accepted, previous: Option<&super::Accepted>, args: &Value) -> Result<Value, Failure> {
    let previous = previous.ok_or_else(|| Failure::new("expired_revision", "inspect", "Previous accepted revision is not retained"))?;
    let category = text(args, "category")?;
    let request = page_request(args.get("page"))?;
    let old = &previous.compiled;
    let new = &accepted.compiled;
    let (rows, total, next) = if request.track.is_none() && request.start_tick.is_none() && request.end_tick.is_none() {
        let page = muz::provenance::diff_page(old, new, category, request.offset, request.limit).map_err(core_error)?;
        complete_page(page.rows.len(), page.total, &request)?;
        (page.rows, page.total, page.next)
    } else {
        if let Some(track) = request.track.as_deref() {
            if ![old, new].iter().any(|compiled| compiled.session.tracks.iter().any(|t| t.id.as_str() == track)) {
                return Err(invalid(format!("Unknown diff track {track}")));
            }
        }
        let mut rows = Vec::new();
        let mut total = 0usize;
        let mut bytes = 0;
        let mut offset = 0;
        loop {
            let page = muz::provenance::diff_page(old, new, category, offset, MAX_ROWS).map_err(core_error)?;
            for row in page.rows {
                if diff_matches(&row, old, new, &request) {
                    if total >= request.offset && rows.len() < request.limit {
                        bytes += bounded_size(&row)?;
                        if bytes > MAX_BYTES { return Err(too_large()) }
                        rows.push(row);
                    }
                    total += 1;
                }
            }
            match page.next {
                Some(next) if next > offset => offset = next,
                Some(_) => return Err(too_large()),
                None => break,
            }
        }
        let end = request.offset.saturating_add(rows.len());
        (rows, total, (end < total).then_some(end))
    };
    let value = json!({"ref": accepted.reference, "base": previous.reference, "category": category, "rows": rows, "total": total, "next": next});
    bounded_size(&value)?;
    Ok(value)
}
