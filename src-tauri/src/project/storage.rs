//! Parent-owned, bounded persistence. Linux publication stays relative to pinned
//! directory descriptors; other platforms fail rather than weaken that guarantee.
use crate::protocol::Failure;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const DOCUMENT_BYTES: usize = 8 * 1024 * 1024;
const SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;
const RECORD_BYTES: usize = 140 * 1024 * 1024;
const RECOVERY_BYTES: u64 = 512 * 1024 * 1024;
const RECOVERY_COUNT: usize = 12;
const RECENTS_BYTES: usize = 1024 * 1024;
const PREFERENCES_BYTES: usize = 64 * 1024;
const SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const RECENTS_FILE: &str = "muzpad-recents-v1.json";
const PREFERENCES_FILE: &str = "muzpad-preferences-v1.json";
const DRAFT_PREFIX: &str = "muzpad-draft-v1-";

fn failure(code: &str, message: impl Into<String>) -> Failure {
    Failure::new(code, "project", message)
}
fn invalid(message: impl Into<String>) -> Failure { failure("storage_invalid", message) }
fn budget(message: impl Into<String>) -> Failure { failure("storage_budget", message) }
fn safe_id(id: &str) -> Result<(), Failure> {
    if id.is_empty() || id.len() > 128
        || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
        return Err(invalid("Recovery identity must be 1–128 ASCII letters, digits, hyphens or underscores"));
    }
    Ok(())
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, Failure> {
    value.get(key).and_then(Value::as_str).filter(|v| !v.is_empty())
        .ok_or_else(|| invalid(format!("Missing or invalid {key}")))
}
fn nullable_string(value: &Value, key: &str) -> Result<(), Failure> {
    match value.get(key) {
        Some(Value::Null | Value::String(_)) => Ok(()),
        _ => Err(invalid(format!("Missing or invalid {key}"))),
    }
}
fn safe_integer(value: &Value, key: &str) -> Result<(), Failure> {
    if value.get(key).and_then(Value::as_u64).is_some_and(|n| n <= SAFE_INTEGER) { Ok(()) }
    else { Err(invalid(format!("Invalid {key}"))) }
}
fn relative_path(path: &str) -> Result<(), Failure> {
    if path.is_empty() || path.len() > 4096 || path.contains(['\\', '\0', ':'])
        || path.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return Err(invalid("Invalid recovery document path"));
    }
    Ok(())
}
fn validate_preferences(value: &Value) -> Result<(), Failure> {
    if value.get("version").and_then(Value::as_u64) != Some(1)
        || !matches!(value.get("theme").and_then(Value::as_str),
            Some("light" | "dark" | "soft-light" | "soft-dark")) {
        return Err(invalid("Unsupported workbench preferences version or theme"));
    }
    let layout = value.get("layout").ok_or_else(|| invalid("Missing preferences layout"))?;
    for key in ["explorer", "source", "visualization", "inspector"] {
        if !layout.get(key).is_some_and(Value::is_boolean) {
            return Err(invalid(format!("Invalid preferences layout.{key}")));
        }
    }
    if !layout.get("sourceFraction").and_then(Value::as_f64)
        .is_some_and(|n| n.is_finite() && n > 0.0 && n < 1.0) {
        return Err(invalid("Preferences sourceFraction must be finite and strictly between zero and one"));
    }
    Ok(())
}
fn validate_optional_gist(value: &Value) -> Result<(), Failure> {
    if let Some(gist) = value.get("gist") {
        let gist = gist.as_str().ok_or_else(|| invalid("Invalid gist origin"))?;
        super::model::validate_gist(gist).map_err(|error| invalid(error.message))?;
    }
    Ok(())
}
fn validate_recents(rows: &[Value]) -> Result<(), Failure> {
    if rows.len() > 128 { return Err(budget("At most 128 recent projects may be retained")); }
    let mut projects = HashSet::new();
    for row in rows {
        validate_optional_gist(row)?;
        let project = string(row, "project")?;
        if project.len() > 128 || !projects.insert(project) {
            return Err(invalid("Invalid or duplicate recent project identity"));
        }
    }
    Ok(())
}
fn validate_text_rows(rows: &[Value], capture: bool) -> Result<(), Failure> {
    let mut total = 0usize;
    let mut files = HashSet::new();
    let mut paths = HashSet::new();
    for row in rows {
        let id = string(row, "fileId")?;
        let path = string(row, "path")?;
        relative_path(path)?;
        if id.len() > 128 || !files.insert(id) || !paths.insert(path) {
            return Err(invalid("Duplicate or invalid recovery document identity/path"));
        }
        nullable_string(row, "text")?;
        if let Some(text) = row["text"].as_str() {
            if text.len() > DOCUMENT_BYTES { return Err(budget("Recovery document exceeds 8 MiB of decoded UTF-8")); }
            total += text.len();
            if total > SNAPSHOT_BYTES { return Err(budget("Recovery source set exceeds 64 MiB of decoded UTF-8")); }
        }
        nullable_string(row, if capture { "expectedDiskVersion" } else { "diskVersion" })?;
        if capture { safe_integer(row, "bufferVersion")?; }
    }
    Ok(())
}
fn validate_recovery(record: &Value) -> Result<(), Failure> {
    if record.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(invalid("Unsupported recovery record version"));
    }
    validate_optional_gist(record)?;
    safe_id(string(record, "id")?)?;
    let project = string(record, "project")?;
    if project.len() > 128 { return Err(invalid("Invalid recovery project identity")); }
    string(record, "title")?;
    for key in ["rootLabel", "root", "rootIdentity"] { nullable_string(record, key)?; }
    let updated = string(record, "updatedAt")?;
    if updated.len() > 64 || record.get("updatedMillis").and_then(Value::as_u64).is_none() {
        return Err(invalid("Invalid recovery timestamp"));
    }
    let capture = record.get("capture").ok_or_else(|| invalid("Missing recovery capture"))?;
    if string(capture, "project")? != project || string(capture, "epoch")?.len() > 128 {
        return Err(invalid("Recovery capture belongs to another project or has invalid epoch"));
    }
    safe_integer(capture, "sourceVersion")?;
    relative_path(string(capture, "entry")?)?;
    let generation = string(capture, "expectedDiskGeneration")?;
    if generation.parse::<u64>().ok().is_none()
        || (generation.len() > 1 && generation.starts_with('0'))
        || !generation.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid("Invalid recovery disk generation"));
    }
    nullable_string(capture, "settingsDiskVersion")?;
    let settings = capture.get("settings").ok_or_else(|| invalid("Missing recovery settings"))?;
    string(settings, "title")?;
    relative_path(string(settings, "entry")?)?;
    if let Some(entries) = settings.get("entries") {
        for entry in entries.as_array().ok_or_else(|| invalid("Invalid recovery entries"))? {
            relative_path(entry.as_str().ok_or_else(|| invalid("Invalid recovery entry"))?)?;
        }
    }
    let buffers = capture.get("buffers").and_then(Value::as_array)
        .ok_or_else(|| invalid("Missing recovery buffers"))?;
    validate_text_rows(buffers, true)?;
    let base = record.get("baseFiles").and_then(Value::as_array)
        .ok_or_else(|| invalid("Missing recovery base files"))?;
    validate_text_rows(base, false)?;
    let resources = record.get("resources").and_then(Value::as_array)
        .ok_or_else(|| invalid("Missing recovery resources"))?;
    let mut resource_ids = HashSet::new();
    for resource in resources {
        if !resource_ids.insert(string(resource, "id")?) { return Err(invalid("Duplicate recovery resource")); }
        string(resource, "path")?;
        if !matches!(resource.get("kind").and_then(Value::as_str),
            Some("midi" | "wav" | "flac" | "sample" | "plugin" | "library" | "config")) {
            return Err(invalid("Invalid recovery resource kind"));
        }
        nullable_string(resource, "version")?;
        if !matches!(resource.get("byteLength"), Some(Value::Null)) {
            safe_integer(resource, "byteLength")?;
        }
        if !resource.get("linked").is_some_and(Value::is_boolean)
            || !resource.get("availability").and_then(|v| v.get("available")).is_some_and(Value::is_boolean) {
            return Err(invalid("Invalid recovery resource availability"));
        }
        nullable_string(&resource["availability"], "reason")?;
    }
    Ok(())
}

struct BoundedBytes { bytes: Vec<u8>, limit: usize }
impl Write for BoundedBytes {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            return Err(io::Error::new(io::ErrorKind::FileTooLarge, "Storage serialization budget exceeded"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> { Ok(()) }
}
fn encode<T: Serialize + ?Sized>(value: &T, limit: usize) -> Result<Vec<u8>, Failure> {
    let mut output = BoundedBytes { bytes: Vec::new(), limit };
    serde_json::to_writer(&mut output, value).map_err(|e| budget(format!("Cannot encode bounded storage record: {e}")))?;
    Ok(output.bytes)
}

pub fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default()
        .as_millis().min(u64::MAX as u128) as u64
}
/// RFC3339 UTC, including milliseconds, without locale/timezone dependencies.
pub fn timestamp() -> String { timestamp_at(now_millis()) }
fn timestamp_at(millis: u64) -> String {
    // Gregorian civil date conversion, using 400-year eras from the Unix epoch.
    let seconds = millis / 1000;
    let days = (seconds / 86400) as i64 + 719468;
    let era = days / 146097;
    let day_of_era = days - era * 146097;
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        seconds / 3600 % 24, seconds / 60 % 60, seconds % 60, millis % 1000)
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::ffi::{CStr, CString, OsStr};
    use std::fs::File;
    use std::io::Read;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    use std::path::Component;

    pub(super) struct Directory { file: File, pub path: PathBuf }
    fn cstring(value: &OsStr) -> Result<CString, Failure> {
        CString::new(value.as_bytes()).map_err(|_| invalid("NUL in storage path"))
    }
    fn file_from_fd(fd: libc::c_int) -> Result<File, Failure> {
        if fd < 0 { Err(io::Error::last_os_error().into()) }
        else { Ok(unsafe { File::from_raw_fd(fd) }) }
    }
    impl Directory {
        pub fn open(path: PathBuf) -> Result<Self, Failure> {
            let path = if path.is_absolute() { path } else { std::env::current_dir()?.join(path) };
            let mut current = file_from_fd(unsafe {
                libc::open(c"/".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC)
            })?;
            let mut components = 0;
            for component in path.components() {
                let name = match component {
                    Component::RootDir => continue,
                    Component::Normal(name) => cstring(name)?,
                    _ => return Err(invalid("Storage directories must not contain traversal")),
                };
                components += 1;
                let fd = unsafe { libc::openat(current.as_raw_fd(), name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
                let next = if fd < 0 && io::Error::last_os_error().kind() == io::ErrorKind::NotFound {
                    if unsafe { libc::mkdirat(current.as_raw_fd(), name.as_ptr(), 0o700) } != 0
                        && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists {
                        return Err(io::Error::last_os_error().into());
                    }
                    let file = file_from_fd(unsafe { libc::openat(current.as_raw_fd(), name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) })?;
                    file.sync_all()?;
                    current.sync_all()?;
                    file
                } else { file_from_fd(fd)? };
                current = next;
            }
            if components == 0 { return Err(invalid("Filesystem root cannot be an app storage directory")); }
            let metadata = current.metadata()?;
            if metadata.uid() != unsafe { libc::geteuid() } {
                return Err(failure("storage_unsafe", "App storage directory is not owned by the current user"));
            }
            if unsafe { libc::fchmod(current.as_raw_fd(), 0o700) } != 0 {
                return Err(io::Error::last_os_error().into());
            }
            current.sync_all()?;
            Ok(Self { file: current, path })
        }
        pub fn child(&self, name: &str) -> Result<Self, Failure> {
            let name_c = cstring(OsStr::new(name))?;
            if unsafe { libc::mkdirat(self.file.as_raw_fd(), name_c.as_ptr(), 0o700) } != 0
                && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists {
                return Err(io::Error::last_os_error().into());
            }
            let file = file_from_fd(unsafe { libc::openat(self.file.as_raw_fd(), name_c.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) })?;
            if file.metadata()?.uid() != unsafe { libc::geteuid() } {
                return Err(failure("storage_unsafe", "Private storage directory has a different owner"));
            }
            if unsafe { libc::fchmod(file.as_raw_fd(), 0o700) } != 0 { return Err(io::Error::last_os_error().into()); }
            file.sync_all()?;
            self.file.sync_all()?;
            Ok(Self { file, path: self.path.join(name) })
        }
        fn open_file(&self, name: &str) -> Result<Option<File>, Failure> {
            let name = cstring(OsStr::new(name))?;
            let fd = unsafe { libc::openat(self.file.as_raw_fd(), name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC) };
            if fd < 0 && io::Error::last_os_error().kind() == io::ErrorKind::NotFound { return Ok(None); }
            let file = file_from_fd(fd)?;
            let metadata = file.metadata()?;
            if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() }
                || metadata.nlink() != 1 || metadata.mode() & 0o777 != 0o600 {
                return Err(failure("storage_unsafe", "Storage record must be a private, singly-linked regular file"));
            }
            Ok(Some(file))
        }
        pub fn read(&self, name: &str, limit: usize) -> Result<Option<(Value, u64)>, Failure> {
            let Some(file) = self.open_file(name)? else { return Ok(None); };
            let size = file.metadata()?.len();
            if size > limit as u64 { return Err(budget(format!("Storage record {name} exceeds its byte limit"))); }
            let mut bytes = Vec::with_capacity(size as usize);
            file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
            if bytes.len() > limit { return Err(budget(format!("Storage record {name} grew beyond its byte limit"))); }
            let value = serde_json::from_slice(&bytes)
                .map_err(|e| failure("storage_corrupt", format!("Cannot decode {name}: {e}")))?;
            Ok(Some((value, bytes.len() as u64)))
        }
        pub fn write(&self, name: &str, bytes: &[u8]) -> Result<(), Failure> {
            // Refuse symlinks/hard links and unsafe existing records even though rename
            // itself would not follow the final component.
            self.open_file(name)?;
            let temporary = format!(".muzpad-tmp-{}", uuid::Uuid::new_v4());
            let temp_c = cstring(OsStr::new(&temporary))?;
            let name_c = cstring(OsStr::new(name))?;
            let mut file = file_from_fd(unsafe { libc::openat(self.file.as_raw_fd(), temp_c.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o600) })?;
            let result = (|| -> Result<(), Failure> {
                if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } != 0 { return Err(io::Error::last_os_error().into()); }
                file.write_all(bytes)?;
                file.sync_all()?;
                if unsafe { libc::renameat(self.file.as_raw_fd(), temp_c.as_ptr(), self.file.as_raw_fd(), name_c.as_ptr()) } != 0 {
                    return Err(io::Error::last_os_error().into());
                }
                self.file.sync_all()?;
                Ok(())
            })();
            if result.is_err() {
                // If rename succeeded, the temp name is already gone. Never remove
                // the published destination on a directory-fsync failure.
                unsafe { libc::unlinkat(self.file.as_raw_fd(), temp_c.as_ptr(), 0); }
                let _ = self.file.sync_all();
            }
            result
        }
        pub fn remove(&self, name: &str) -> Result<(), Failure> {
            if self.open_file(name)?.is_none() { return Ok(()); }
            let name = cstring(OsStr::new(name))?;
            if unsafe { libc::unlinkat(self.file.as_raw_fd(), name.as_ptr(), 0) } != 0 {
                return Err(io::Error::last_os_error().into());
            }
            self.file.sync_all()?;
            Ok(())
        }
        pub fn names(&self) -> Result<Vec<String>, Failure> {
            // A fresh open description avoids sharing readdir offsets with earlier scans.
            let fd = unsafe { libc::openat(self.file.as_raw_fd(), c".".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
            let file = file_from_fd(fd)?;
            use std::os::fd::IntoRawFd;
            let raw_fd = file.into_raw_fd();
            let stream = unsafe { libc::fdopendir(raw_fd) };
            if stream.is_null() {
                let error = io::Error::last_os_error();
                unsafe { libc::close(raw_fd); }
                return Err(error.into());
            }
            struct Stream(*mut libc::DIR);
            impl Drop for Stream { fn drop(&mut self) { unsafe { libc::closedir(self.0); } } }
            let stream = Stream(stream);
            let mut names = Vec::new();
            loop {
                unsafe { *libc::__errno_location() = 0; }
                let entry = unsafe { libc::readdir(stream.0) };
                if entry.is_null() {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() != Some(0) { return Err(error.into()); }
                    break;
                }
                let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_str()
                    .map_err(|_| failure("storage_corrupt", "Non-UTF8 recovery filename"))?;
                if name == "." || name == ".." { continue; }
                // A crash may leave a never-published temporary. It is not a draft.
                // Remove it durably on the next scan (operations are serialized by caller).
                if name.starts_with(".muzpad-tmp-") { self.remove(name)?; continue; }
                if names.len() >= 1024 { return Err(budget("Too many files in the private recovery directory")); }
                names.push(name.to_owned());
            }
            Ok(names)
        }
    }
}

#[cfg(target_os = "linux")]
pub struct Storage {
    data: platform::Directory,
    config: platform::Directory,
    recovery: platform::Directory,
    journal: platform::Directory,
}
#[cfg(target_os = "linux")]
impl Storage {
    pub fn new(data_dir: PathBuf, config_dir: PathBuf) -> Result<Self, Failure> {
        let data = platform::Directory::open(data_dir)?;
        let config = platform::Directory::open(config_dir)?;
        let recovery = data.child("muzpad-recovery-v1")?;
        let journal = data.child("muzpad-save-journal-v1")?;
        // Reclaim never-published recents/preferences after process interruption.
        data.names()?;
        config.names()?;
        Ok(Self { data, config, recovery, journal })
    }
    pub fn journal_dir(&self) -> &Path { &self.journal.path }
    pub fn load_recents(&self) -> Result<Vec<Value>, Failure> {
        let Some((value, _)) = self.data.read(RECENTS_FILE, RECENTS_BYTES)? else { return Ok(Vec::new()); };
        let Value::Array(rows) = value else { return Err(failure("storage_corrupt", "Recent projects must be an array")); };
        validate_recents(&rows).map_err(|e| failure("storage_corrupt", e.message))?;
        Ok(rows)
    }
    pub fn save_recents(&self, rows: &[Value]) -> Result<(), Failure> {
        validate_recents(rows)?;
        self.data.write(RECENTS_FILE, &encode(rows, RECENTS_BYTES)?)
    }
    pub fn load_preferences(&self) -> Result<Value, Failure> {
        let Some((value, _)) = self.config.read(PREFERENCES_FILE, PREFERENCES_BYTES)? else { return Ok(Value::Null); };
        validate_preferences(&value).map_err(|e| failure("storage_corrupt", e.message))?;
        Ok(value)
    }
    pub fn save_preferences(&self, value: &Value) -> Result<(), Failure> {
        validate_preferences(value)?;
        self.config.write(PREFERENCES_FILE, &encode(value, PREFERENCES_BYTES)?)
    }
    fn records(&self) -> Result<Vec<(Value, u64)>, Failure> {
        let mut records = Vec::new();
        let mut total = 0u64;
        for name in self.recovery.names()? {
            let id = name.strip_prefix(DRAFT_PREFIX).and_then(|s| s.strip_suffix(".json"))
                .ok_or_else(|| failure("storage_corrupt", format!("Unexpected recovery file {name}")))?;
            safe_id(id).map_err(|e| failure("storage_corrupt", e.message))?;
            let (record, size) = self.recovery.read(&name, RECORD_BYTES)?
                .ok_or_else(|| failure("storage_corrupt", format!("Recovery file disappeared: {name}")))?;
            validate_recovery(&record).map_err(|e| failure("storage_corrupt", format!("Invalid {name}: {}", e.message)))?;
            if record["id"].as_str() != Some(id) { return Err(failure("storage_corrupt", "Recovery filename and identity disagree")); }
            total += size;
            // A crash between publishing one replacement and pruning superseded
            // drafts can leave one extra record. Reconcile that bounded state below.
            if total > RECOVERY_BYTES + RECORD_BYTES as u64 || records.len() > RECOVERY_COUNT {
                return Err(budget("Existing recovery storage exceeds its crash-recovery allowance; no draft was removed"));
            }
            records.push((record, size));
        }
        if total > RECOVERY_BYTES || records.len() > RECOVERY_COUNT {
            let newest = records.iter().enumerate().max_by_key(|(_, (r, _))|
                (r["updatedMillis"].as_u64().unwrap(), r["id"].as_str().unwrap()))
                .map(|(index, _)| index).unwrap();
            let (published, size) = records.swap_remove(newest);
            let victims = retention_victims(&records, size, RECOVERY_COUNT, RECOVERY_BYTES)?;
            for victim in &victims {
                self.recovery.remove(&format!("{DRAFT_PREFIX}{victim}.json"))?;
            }
            records.retain(|(record, _)| !victims.iter().any(|id| record["id"].as_str() == Some(id.as_str())));
            records.push((published, size));
        }
        Ok(records)
    }
    pub fn recovery_records(&self) -> Result<Vec<Value>, Failure> {
        let mut records = self.records()?;
        records.sort_by(|a, b| b.0["updatedMillis"].as_u64().cmp(&a.0["updatedMillis"].as_u64())
            .then_with(|| a.0["id"].as_str().cmp(&b.0["id"].as_str())));
        Ok(records.into_iter().map(|(record, _)| record).collect())
    }
    pub fn put_recovery(&self, record: &Value) -> Result<Vec<String>, Failure> {
        validate_recovery(record)?;
        let bytes = encode(record, RECORD_BYTES)?;
        let id = record["id"].as_str().unwrap();
        let mut records = self.records()?;
        if let Some((old, _)) = records.iter().find(|(old, _)| old["id"] == record["id"]) {
            if old["project"] != record["project"] || old["updatedMillis"].as_u64() > record["updatedMillis"].as_u64() {
                return Err(failure("storage_stale", "Recovery replacement changes project identity or predates the durable draft"));
            }
        }
        records.retain(|(old, _)| old["id"] != record["id"]);
        let victims = retention_victims(&records, bytes.len() as u64, RECOVERY_COUNT, RECOVERY_BYTES)?;
        // Never prune until the incoming draft is durable. A crash in this short
        // window is reconciled by records(), which keeps the newest publication.
        self.recovery.write(&format!("{DRAFT_PREFIX}{id}.json"), &bytes)?;
        for victim in &victims { self.recovery.remove(&format!("{DRAFT_PREFIX}{victim}.json"))?; }
        Ok(victims)
    }
    pub fn remove_recovery(&self, id: &str) -> Result<(), Failure> {
        safe_id(id)?;
        self.recovery.remove(&format!("{DRAFT_PREFIX}{id}.json"))
    }
}

fn retention_victims(records: &[(Value, u64)], size: u64,
    count_limit: usize, byte_limit: u64) -> Result<Vec<String>, Failure> {
    if count_limit == 0 || size > byte_limit {
        return Err(budget("The current recovery draft exceeds the storage limit"));
    }
    let mut count = records.len() + 1;
    let mut bytes = records.iter().map(|(_, n)| n).sum::<u64>() + size;
    let mut candidates: Vec<_> = records.iter().collect();
    candidates.sort_by(|(a, _), (b, _)|
        a["updatedMillis"].as_u64().cmp(&b["updatedMillis"].as_u64())
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str())));
    let mut victims = Vec::new();
    for (record, size) in candidates {
        if count <= count_limit && bytes <= byte_limit { break; }
        victims.push(record["id"].as_str().unwrap().to_owned());
        count -= 1;
        bytes -= size;
    }
    Ok(victims)
}

#[cfg(not(target_os = "linux"))]
pub struct Storage { journal: PathBuf }
#[cfg(not(target_os = "linux"))]
impl Storage {
    pub fn new(_data_dir: PathBuf, _config_dir: PathBuf) -> Result<Self, Failure> { Err(unsupported()) }
    pub fn journal_dir(&self) -> &Path { &self.journal }
    pub fn load_recents(&self) -> Result<Vec<Value>, Failure> { Err(unsupported()) }
    pub fn save_recents(&self, _rows: &[Value]) -> Result<(), Failure> { Err(unsupported()) }
    pub fn load_preferences(&self) -> Result<Value, Failure> { Err(unsupported()) }
    pub fn save_preferences(&self, _value: &Value) -> Result<(), Failure> { Err(unsupported()) }
    pub fn recovery_records(&self) -> Result<Vec<Value>, Failure> { Err(unsupported()) }
    pub fn put_recovery(&self, _record: &Value) -> Result<Vec<String>, Failure> { Err(unsupported()) }
    pub fn remove_recovery(&self, _id: &str) -> Result<(), Failure> { Err(unsupported()) }
}
#[cfg(not(target_os = "linux"))]
fn unsupported() -> Failure {
    failure("platform_unsupported", "Secure durable project storage is currently supported only on Linux")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn draft(id: &str, project: &str, time: u64) -> Value {
        json!({"version": 1, "id": id, "project": project, "title": "Draft", "rootLabel": null,
            "root": null, "rootIdentity": null, "updatedAt": timestamp_at(time), "updatedMillis": time,
            "capture": {"project": project, "epoch": "epoch", "sourceVersion": 1, "entry": "main.muz",
                "expectedDiskGeneration": "0", "settingsDiskVersion": null,
                "settings": {"title": "Draft", "entry": "main.muz"},
                "buffers": [{"fileId": "file", "path": "main.muz", "text": "local", "bufferVersion": 1,
                    "expectedDiskVersion": "base"}]},
            "baseFiles": [{"fileId": "file", "path": "main.muz", "text": "base", "diskVersion": "base"}],
            "resources": []})
    }
    fn preferences() -> Value {
        json!({"version": 1, "theme": "soft-dark", "layout": {"explorer": true, "source": true,
            "visualization": false, "inspector": false, "sourceFraction": 0.6}})
    }
    #[test]
    fn preferences_reject_bad_version_theme_flags_and_fraction() {
        assert!(validate_preferences(&preferences()).is_ok());
        for fraction in [json!(0), json!(1), json!(-0.1), json!(null), json!("0.5")] {
            let mut value = preferences(); value["layout"]["sourceFraction"] = fraction;
            assert!(validate_preferences(&value).is_err());
        }
        let mut value = preferences(); value["theme"] = json!("unknown");
        assert!(validate_preferences(&value).is_err());
        value = preferences(); value["version"] = json!(2);
        assert!(validate_preferences(&value).is_err());
        value = preferences(); value["layout"]["source"] = json!(1);
        assert!(validate_preferences(&value).is_err());
    }
    #[test]
    fn validates_ids_schema_and_decoded_document_budget() {
        for id in ["", "../escape", "/tmp/x", "a/b", "a\\b", ".", "a\0b"] { assert!(safe_id(id).is_err()); }
        assert!(safe_id("draft_0123-abcd").is_ok());
        let mut record = draft("draft", "project", 1);
        assert!(validate_recovery(&record).is_ok());
        record["capture"]["buffers"][0]["text"] = json!("é".repeat(DOCUMENT_BYTES / 2 + 1));
        assert_eq!(validate_recovery(&record).unwrap_err().code, "storage_budget");
        record = draft("draft", "project", 1); record["capture"]["project"] = json!("other");
        assert!(validate_recovery(&record).is_err());
        record = draft("draft", "project", 1); record["capture"]["buffers"][0]["path"] = json!("../escape");
        assert!(validate_recovery(&record).is_err());
    }
    #[test]
    fn timestamps_are_utc_rfc3339() {
        assert_eq!(timestamp_at(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(timestamp_at(951_827_696_789), "2000-02-29T12:34:56.789Z");
    }
    #[test]
    fn retention_evicts_oldest_by_count_and_bytes() {
        let records = vec![(draft("new", "a", 2), 10), (draft("only", "b", 3), 10), (draft("old", "a", 1), 10)];
        assert_eq!(retention_victims(&records, 10, 3, 40).unwrap(), vec!["old"]);
        assert_eq!(retention_victims(&records, 10, 4, 30).unwrap(), vec!["old"]);
        assert_eq!(retention_victims(&records, 10, 2, 40).unwrap(), vec!["old", "new"]);
        assert_eq!(retention_victims(&records, 10, 4, 29).unwrap(), vec!["old", "new"]);
        assert_eq!(retention_victims(&records, 31, 4, 30).unwrap_err().code, "storage_budget");
    }
    #[test]
    fn bounded_encoding_and_recents_validation() {
        assert!(encode(&json!("oversized"), 3).is_err());
        assert!(validate_recents(&[json!({"project": "same"}), json!({"project": "same"})]).is_err());
        assert!(validate_recents(&vec![json!({"project": "x"}); 129]).is_err());
    }
    #[cfg(target_os = "linux")]
    fn storage(root: &Path) -> Storage {
        Storage::new(root.join("data"), root.join("config")).unwrap()
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn durable_atomic_draft_restore_and_preferences() {
        use std::os::unix::fs::MetadataExt;
        let root = tempfile::tempdir().unwrap();
        let store = storage(root.path());
        assert!(store.load_preferences().unwrap().is_null());
        let mut record = draft("draft", "project", 1);
        store.put_recovery(&record).unwrap();
        record["updatedMillis"] = json!(2);
        record["capture"]["buffers"][0]["text"] = Value::Null;
        store.put_recovery(&record).unwrap();
        store.save_preferences(&preferences()).unwrap();
        store.save_recents(&[json!({"project": "project", "root": "/missing"})]).unwrap();
        drop(store);
        let store = storage(root.path());
        assert_eq!(store.recovery_records().unwrap(), vec![record.clone()]);
        assert_eq!(store.load_preferences().unwrap(), preferences());
        assert_eq!(store.load_recents().unwrap()[0]["project"], "project");
        assert_eq!(std::fs::metadata(store.journal_dir()).unwrap().mode() & 0o777, 0o700);
        let path = root.path().join("data/muzpad-recovery-v1/muzpad-draft-v1-draft.json");
        assert_eq!(std::fs::metadata(path).unwrap().mode() & 0o777, 0o600);
        let mut bad = record; bad["capture"]["buffers"][0]["path"] = json!("../bad");
        assert!(store.put_recovery(&bad).is_err());
        assert_eq!(store.recovery_records().unwrap().len(), 1);
        store.remove_recovery("draft").unwrap();
        assert!(store.recovery_records().unwrap().is_empty());
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn corrupt_records_are_reported_not_hidden() {
        let root = tempfile::tempdir().unwrap(); let store = storage(root.path());
        store.put_recovery(&draft("draft", "project", 1)).unwrap();
        let path = root.path().join("data/muzpad-recovery-v1/muzpad-draft-v1-draft.json");
        std::fs::write(path, b"{truncated").unwrap();
        assert_eq!(store.recovery_records().unwrap_err().code, "storage_corrupt");
        assert!(store.put_recovery(&draft("second", "other", 2)).is_err());
        store.save_preferences(&preferences()).unwrap();
        std::fs::write(root.path().join("config").join(PREFERENCES_FILE), b"null").unwrap();
        assert_eq!(store.load_preferences().unwrap_err().code, "storage_corrupt");
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn full_recovery_evicts_oldest_and_keeps_updated_drafts() {
        let root = tempfile::tempdir().unwrap(); let store = storage(root.path());
        for n in 0..RECOVERY_COUNT { store.put_recovery(&draft(&format!("draft-{n}"), &format!("project-{n}"), n as u64)).unwrap(); }
        assert_eq!(store.put_recovery(&draft("incoming", "other", 99)).unwrap(), vec!["draft-0"]);
        assert!(store.put_recovery(&draft("draft-1", "project-1", 100)).unwrap().is_empty());
        drop(store);
        let records = storage(root.path()).recovery_records().unwrap();
        assert_eq!(records.len(), RECOVERY_COUNT);
        assert_eq!(records[0]["id"], "draft-1");
        assert_eq!(records[1]["id"], "incoming");
        assert!(!records.iter().any(|r| r["id"] == "draft-0"));
        assert!(records.iter().any(|r| r["id"] == "draft-2"));
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn symlink_directories_and_files_are_rejected() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let store = storage(root.path());
        let outside = root.path().join("outside"); std::fs::create_dir(&outside).unwrap();
        symlink(&outside, root.path().join("linked")).unwrap();
        assert!(Storage::new(root.path().join("linked/data"), root.path().join("config")).is_err());
        let target = outside.join("untouched"); std::fs::write(&target, b"sentinel").unwrap();
        symlink(&target, root.path().join("config").join(PREFERENCES_FILE)).unwrap();
        assert!(store.save_preferences(&preferences()).is_err());
        assert_eq!(std::fs::read(target).unwrap(), b"sentinel");
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn abandoned_temporary_never_replaces_published_draft() {
        let root = tempfile::tempdir().unwrap(); let store = storage(root.path());
        let record = draft("draft", "project", 1); store.put_recovery(&record).unwrap();
        use std::os::unix::fs::OpenOptionsExt;
        let temporary = root.path().join("data/muzpad-recovery-v1/.muzpad-tmp-interrupted");
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temporary).unwrap();
        file.write_all(b"{partial").unwrap(); file.sync_all().unwrap();
        assert_eq!(store.recovery_records().unwrap(), vec![record]);
        assert!(!temporary.exists());
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn interrupted_retention_finishes_only_after_new_draft_is_durable() {
        let root = tempfile::tempdir().unwrap(); let store = storage(root.path());
        for n in 0..RECOVERY_COUNT {
            store.put_recovery(&draft(&format!("draft-{n}"), &format!("project-{n}"), n as u64)).unwrap();
        }
        let replacement = draft("replacement", "new-project", 100);
        // Model a crash after rename+fsync but before the retention unlink.
        store.recovery.write("muzpad-draft-v1-replacement.json", &encode(&replacement, RECORD_BYTES).unwrap()).unwrap();
        drop(store);
        let store = storage(root.path());
        let records = store.recovery_records().unwrap();
        assert_eq!(records.len(), RECOVERY_COUNT);
        assert!(records.iter().any(|r| r == &replacement));
        assert!(!records.iter().any(|r| r["id"] == "draft-0"));
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn publication_stays_with_pinned_directory_after_path_replacement() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap(); let store = storage(root.path());
        let moved = root.path().join("original-config");
        std::fs::rename(root.path().join("config"), &moved).unwrap();
        let outside = root.path().join("outside"); std::fs::create_dir(&outside).unwrap();
        symlink(&outside, root.path().join("config")).unwrap();
        store.save_preferences(&preferences()).unwrap();
        assert_eq!(store.load_preferences().unwrap(), preferences());
        assert!(moved.join(PREFERENCES_FILE).exists());
        assert!(!outside.join(PREFERENCES_FILE).exists());
    }
}
