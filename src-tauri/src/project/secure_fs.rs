//! Descriptor-anchored Linux project I/O and crash-safe, no-clobber publication.
//!
//! Every path component is opened with O_NOFOLLOW. A selected directory remains
//! an authority only while its absolute name resolves to its original identity.
//! Publication never uses a check followed by an overwriting rename: existing
//! files are exchanged into a private recovery directory, and missing files use
//! RENAME_NOREPLACE. The durable journal precedes either operation. Conflicts keep
//! the displaced inode and report its location instead of attempting a racy undo.
//! Journal/private-directory permissions protect transaction names from other
//! users; another process with this user's credentials is not a security boundary.
//! Recovery only deletes private artifacts whose contents prove a completed save.

use crate::protocol::Failure;
use serde_json::Value;
use std::path::{Path, PathBuf};

const MAX_PATH_BYTES: usize = 4095;
const MAX_COMPONENTS: usize = 128;

pub struct Entry {
    pub path: String,
    pub bytes: u64,
}

pub struct ReadFile {
    pub bytes: Vec<u8>,
    /// Lowercase SHA-256 of the exact file contents, without an identity prefix.
    pub version: String,
    pub mode: u32,
}

pub fn validate_path(path: &str) -> Result<(), Failure> {
    let drive_prefix = path.as_bytes().get(1) == Some(&b':')
        && path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic);
    if path.is_empty()
        || path.len() > MAX_PATH_BYTES
        || path.starts_with('/')
        || drive_prefix
        || path.contains(['\0', '\\'])
        || path.split('/').count() > MAX_COMPONENTS
        || path.split('/').any(|part| {
            part.is_empty()
                || part == "."
                || part == ".."
                || part.len() > 255
                || part.starts_with(".muzpad-")
        })
    {
        let mut error = Failure::new("denied_path", "project", "Invalid project-relative path");
        error.path = Some(path.to_owned());
        return Err(error);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use serde::{Deserialize, Serialize};
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::ffi::{CStr, CString, OsStr, OsString};
    use std::fs::File;
    use std::io::{self, Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, RawFd};
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    use std::os::unix::fs::MetadataExt;
    use std::path::Component;
    use std::sync::{Mutex, MutexGuard};
    use uuid::Uuid;

    const MAX_WRITE_BYTES: usize = 256 * 1024 * 1024;
    const MAX_EXPORT_BYTES: u64 = 64 * 1024 * 1024 * 1024;
    const MAX_JOURNALS: usize = 128;
    const MAX_JOURNAL_BYTES: usize = 32 * 1024;
    const JOURNAL_NAME: &str = ".muzpad-secure-journal";
    const PAYLOAD: &str = "payload";

    #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
    struct Identity {
        device: u64,
        inode: u64,
    }

    impl Identity {
        fn of(file: &File) -> Result<Self, Failure> {
            let metadata = file.metadata()?;
            Ok(Self { device: metadata.dev(), inode: metadata.ino() })
        }

        fn label(self) -> String {
            format!("{}:{}", self.device, self.inode)
        }
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct Stamp {
        identity: Identity,
        size: u64,
        mode: u32,
        links: u64,
        modified: (i64, i64),
        changed: (i64, i64),
    }

    impl Stamp {
        fn of(file: &File) -> Result<Self, Failure> {
            let metadata = file.metadata()?;
            if !metadata.is_file() {
                return Err(failure("denied_path", "The requested entry is not a regular file"));
            }
            Ok(Self {
                identity: Identity { device: metadata.dev(), inode: metadata.ino() },
                size: metadata.len(),
                mode: metadata.mode() & 0o7777,
                links: metadata.nlink(),
                modified: (metadata.mtime(), metadata.mtime_nsec()),
                changed: (metadata.ctime(), metadata.ctime_nsec()),
            })
        }
    }

    pub struct Root {
        path: PathBuf,
        directory: File,
        identity: Identity,
        mutation: Mutex<()>,
    }

    struct Parent {
        directory: File,
        relative: String,
        leaf: String,
        identity: Identity,
    }

    struct Fingerprint {
        version: String,
        stamp: Stamp,
    }

    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Journal {
        schema: u32,
        id: String,
        root: String,
        root_path: PathBuf,
        path: String,
        parent: Identity,
        transaction: String,
        transaction_identity: Identity,
        operation: String,
        phase: String,
        expected: Option<String>,
        proposed: Option<String>,
        mode: u32,
    }

    struct Transaction {
        record: Journal,
        journal_directory: File,
        journal_path: PathBuf,
        directory: File,
        directory_path: PathBuf,
    }

    fn failure(code: &str, message: impl Into<String>) -> Failure {
        Failure::new(code, "project", message.into())
    }

    fn io_failure(error: io::Error) -> Failure {
        if error.kind() == io::ErrorKind::PermissionDenied {
            failure("permission_denied", error.to_string())
        } else if matches!(error.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)) {
            failure("denied_path", "A path component is a symlink or is not a directory")
        } else {
            error.into()
        }
    }

    fn conflict(message: &str) -> Failure {
        failure("source_conflict", message)
    }

    fn budget(message: &str) -> Failure {
        failure("resource_budget", message)
    }

    fn c_name(name: &OsStr) -> Result<CString, Failure> {
        CString::new(name.as_bytes()).map_err(|_| failure("denied_path", "NUL in filesystem path"))
    }

    fn open_at(directory: RawFd, name: &OsStr, flags: i32, mode: u32) -> io::Result<File> {
        let name = CString::new(name.as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in path"))?;
        let descriptor = unsafe {
            libc::openat(directory, name.as_ptr(), flags | libc::O_CLOEXEC | libc::O_NOFOLLOW, mode)
        };
        if descriptor < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { File::from_raw_fd(descriptor) })
        }
    }

    fn directory_at(directory: &File, name: &OsStr) -> Result<File, Failure> {
        open_at(directory.as_raw_fd(), name, libc::O_RDONLY | libc::O_DIRECTORY, 0)
            .map_err(io_failure)
    }

    fn mkdir_at(directory: &File, name: &OsStr) -> Result<bool, Failure> {
        let name = c_name(name)?;
        if unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700) } == 0 {
            directory.sync_all()?;
            Ok(true)
        } else {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::AlreadyExists {
                Ok(false)
            } else {
                Err(io_failure(error))
            }
        }
    }

    fn absolute_directory(path: &Path, create: bool) -> Result<(PathBuf, File), Failure> {
        let absolute = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir()?.join(path) };
        let mut canonical = PathBuf::from("/");
        let mut directory = open_at(libc::AT_FDCWD, OsStr::new("/"), libc::O_RDONLY | libc::O_DIRECTORY, 0)
            .map_err(io_failure)?;
        for component in absolute.components() {
            match component {
                Component::RootDir | Component::CurDir => {}
                Component::Normal(name) => {
                    if create {
                        mkdir_at(&directory, name)?;
                    }
                    directory = directory_at(&directory, name)?;
                    canonical.push(name);
                }
                _ => return Err(failure("denied_path", "Directory authority cannot contain parent traversal")),
            }
        }
        Ok((canonical, directory))
    }

    fn private_directory(directory: &File) -> Result<(), Failure> {
        let metadata = directory.metadata()?;
        if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(failure("permission_denied", "Recovery directory must be owned by this user with mode 0700"));
        }
        Ok(())
    }

    fn rename_at(source: &File, from: &str, destination: &File, to: &str, flags: u32) -> Result<(), Failure> {
        let from = c_name(OsStr::new(from))?;
        let to = c_name(OsStr::new(to))?;
        let result = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                source.as_raw_fd(), from.as_ptr(),
                destination.as_raw_fd(), to.as_ptr(), flags,
            )
        };
        if result == 0 {
            Ok(())
        } else {
            let error = io::Error::last_os_error();
            match error.raw_os_error() {
                Some(libc::ENOSYS | libc::EINVAL | libc::EOPNOTSUPP) => Err(failure(
                    "unsupported_platform", "This filesystem cannot provide atomic no-clobber publication",
                )),
                Some(libc::EEXIST | libc::ENOENT) => Err(conflict("The destination changed during publication")),
                _ => Err(io_failure(error)),
            }
        }
    }

    // Only private transaction/journal artifacts are unlinked, never project targets.
    fn unlink_private(directory: &File, name: &str, is_directory: bool) -> Result<(), Failure> {
        let name = c_name(OsStr::new(name))?;
        let flags = if is_directory { libc::AT_REMOVEDIR } else { 0 };
        if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), flags) } == 0 {
            directory.sync_all()?;
            Ok(())
        } else {
            Err(io_failure(io::Error::last_os_error()))
        }
    }

    fn set_mode(file: &File, mode: u32) -> Result<(), Failure> {
        if unsafe { libc::fchmod(file.as_raw_fd(), mode & 0o7777) } < 0 {
            return Err(io_failure(io::Error::last_os_error()));
        }
        if file.metadata()?.mode() & 0o7777 != mode & 0o7777 {
            return Err(failure("file_write_failed", "The filesystem could not preserve the destination mode"));
        }
        Ok(())
    }

    fn file_at(directory: &File, name: &str) -> Result<Option<File>, Failure> {
        match open_at(directory.as_raw_fd(), OsStr::new(name), libc::O_RDONLY | libc::O_NONBLOCK, 0) {
            Ok(file) => {
                Stamp::of(&file)?;
                Ok(Some(file))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(io_failure(error)),
        }
    }

    fn verify_name(directory: &File, name: &str, stamp: &Stamp) -> Result<(), Failure> {
        let current = file_at(directory, name)?.ok_or_else(|| conflict("File disappeared while being read"))?;
        if Stamp::of(&current)? != *stamp {
            return Err(conflict("File changed while being read"));
        }
        Ok(())
    }

    fn hash_file(file: &mut File, max_bytes: u64) -> Result<Fingerprint, Failure> {
        let before = Stamp::of(file)?;
        if before.size > max_bytes {
            return Err(budget("File exceeds the bounded read limit"));
        }
        let mut hash = Sha256::new();
        let mut chunk = [0u8; 64 * 1024];
        let mut total = 0u64;
        loop {
            let count = match file.read(&mut chunk) {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                result => result?,
            };
            if count == 0 { break; }
            total = total.checked_add(count as u64).ok_or_else(|| budget("File size overflow"))?;
            if total > max_bytes { return Err(budget("File grew beyond the bounded read limit")); }
            hash.update(&chunk[..count]);
        }
        if Stamp::of(file)? != before || total != before.size {
            return Err(conflict("File changed while being read"));
        }
        Ok(Fingerprint { version: hex::encode(hash.finalize()), stamp: before })
    }

    fn fingerprint_at(directory: &File, name: &str, max_bytes: u64) -> Result<Option<Fingerprint>, Failure> {
        let Some(mut file) = file_at(directory, name)? else { return Ok(None); };
        let fingerprint = hash_file(&mut file, max_bytes)?;
        verify_name(directory, name, &fingerprint.stamp)?;
        Ok(Some(fingerprint))
    }

    fn version_of(fingerprint: &Option<Fingerprint>) -> Option<&str> {
        fingerprint.as_ref().map(|value| value.version.as_str())
    }

    struct DirectoryStream(*mut libc::DIR);
    impl Drop for DirectoryStream {
        fn drop(&mut self) { unsafe { libc::closedir(self.0); } }
    }

    fn names(directory: &File, limit: usize) -> Result<Vec<OsString>, Failure> {
        names_filtered(directory, limit, false)
    }

    fn source_candidate(directory: &File, name: &[u8], kind: u8) -> Result<bool, Failure> {
        if name.starts_with(b".muzpad-")
            || matches!(name, b"assets" | b".git" | b"node_modules" | b"target")
        {
            return Ok(false);
        }
        if kind == libc::DT_DIR { return Ok(true); }
        if kind == libc::DT_REG { return Ok(name.ends_with(b".muz")); }
        if kind != libc::DT_UNKNOWN { return Ok(false); }
        // Some filesystems do not expose d_type. Only there is an O_PATH
        // metadata lookup necessary to distinguish a directory from an asset.
        let file = open_at(directory.as_raw_fd(), OsStr::from_bytes(name), libc::O_PATH, 0)
            .map_err(io_failure)?;
        let metadata = file.metadata()?;
        Ok(metadata.is_dir() || (metadata.is_file() && name.ends_with(b".muz")))
    }

    fn names_filtered(directory: &File, limit: usize, sources_only: bool) -> Result<Vec<OsString>, Failure> {
        use std::os::fd::IntoRawFd;
        // openat(".") creates a fresh directory offset; dup would share readdir state.
        let descriptor = directory_at(directory, OsStr::new("."))?.into_raw_fd();
        let pointer = unsafe { libc::fdopendir(descriptor) };
        if pointer.is_null() {
            let error = io::Error::last_os_error();
            unsafe { libc::close(descriptor); }
            return Err(io_failure(error));
        }
        let stream = DirectoryStream(pointer);
        let mut output = Vec::new();
        loop {
            unsafe { *libc::__errno_location() = 0; }
            let entry = unsafe { libc::readdir(stream.0) };
            if entry.is_null() {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(0) { return Err(io_failure(error)); }
                break;
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if name == b"." || name == b".." { continue; }
            if sources_only && !source_candidate(directory, name, unsafe { (*entry).d_type })? {
                continue;
            }
            if output.len() >= limit { return Err(budget("Directory contains too many entries")); }
            output.push(OsString::from_vec(name.to_vec()));
        }
        output.sort();
        Ok(output)
    }

    fn descriptor_path(file: &File, fallback: &Path) -> PathBuf {
        // Diagnostic only: no operation resolves or opens the returned pathname.
        std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).unwrap_or_else(|_| fallback.to_path_buf())
    }

    impl Root {
        pub fn open(path: &Path) -> Result<Self, Failure> {
            let (path, directory) = absolute_directory(path, false)?;
            let identity = Identity::of(&directory)?;
            let root = Self { path, directory, identity, mutation: Mutex::new(()) };
            root.healthy()?;
            Ok(root)
        }

        pub fn path(&self) -> &Path { &self.path }

        pub fn identity(&self) -> String { self.identity.label() }

        pub fn healthy(&self) -> Result<(), Failure> {
            let (_, current) = absolute_directory(&self.path, false).map_err(|mut error| {
                error.help.get_or_insert_with(Vec::new).push(format!("Re-select the project root: {}", self.path.display()));
                error
            })?;
            if Identity::of(&current)? != self.identity || self.directory.metadata()?.nlink() == 0 {
                return Err(failure("root_missing", "The selected root was moved or replaced; select it again"));
            }
            Ok(())
        }

        fn lock(&self) -> Result<MutexGuard<'_, ()>, Failure> {
            self.mutation.lock().map_err(|_| failure("recovery_required", "An interrupted filesystem operation requires reopening the project"))
        }

        fn parent(&self, path: &str, create: bool) -> Result<Option<Parent>, Failure> {
            validate_path(path)?;
            let (relative, leaf) = path.rsplit_once('/').unwrap_or(("", path));
            let mut directory = directory_at(&self.directory, OsStr::new("."))?;
            if !relative.is_empty() {
                for component in relative.split('/') {
                    if create { mkdir_at(&directory, OsStr::new(component))?; }
                    match open_at(directory.as_raw_fd(), OsStr::new(component), libc::O_RDONLY | libc::O_DIRECTORY, 0) {
                        Ok(next) => directory = next,
                        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
                        Err(error) => return Err(io_failure(error)),
                    }
                }
            }
            let identity = Identity::of(&directory)?;
            Ok(Some(Parent { directory, relative: relative.to_owned(), leaf: leaf.to_owned(), identity }))
        }

        fn verify_parent(&self, parent: &Parent, path: &str) -> Result<(), Failure> {
            self.healthy()?;
            let current = self.parent(path, false)?.ok_or_else(|| conflict("A parent directory disappeared"))?;
            if current.identity != parent.identity {
                return Err(conflict("A parent directory moved or was replaced"));
            }
            Ok(())
        }

        pub fn read(&self, path: &str, max_bytes: usize) -> Result<Option<ReadFile>, Failure> {
            validate_path(path)?;
            self.healthy()?;
            let Some(parent) = self.parent(path, false)? else { return Ok(None); };
            let Some(mut file) = file_at(&parent.directory, &parent.leaf)? else {
                self.verify_parent(&parent, path)?;
                return Ok(None);
            };
            let before = Stamp::of(&file)?;
            if before.size > max_bytes as u64 { return Err(budget("File exceeds the bounded read limit")); }
            let mut bytes = Vec::with_capacity(before.size as usize);
            (&mut file).take((max_bytes as u64).saturating_add(1)).read_to_end(&mut bytes)?;
            if bytes.len() > max_bytes { return Err(budget("File grew beyond the bounded read limit")); }
            if Stamp::of(&file)? != before || bytes.len() as u64 != before.size {
                return Err(conflict("File changed while being read"));
            }
            verify_name(&parent.directory, &parent.leaf, &before)?;
            self.verify_parent(&parent, path)?;
            let version = hex::encode(Sha256::digest(&bytes));
            Ok(Some(ReadFile { bytes, version, mode: before.mode }))
        }

        pub fn fingerprint(&self, path: &str, max_bytes: u64) -> Result<Option<String>, Failure> {
            validate_path(path)?;
            self.healthy()?;
            let Some(parent) = self.parent(path, false)? else { return Ok(None); };
            let result = fingerprint_at(&parent.directory, &parent.leaf, max_bytes)?;
            self.verify_parent(&parent, path)?;
            Ok(result.map(|value| value.version))
        }

        pub fn list(&self, max_entries: usize) -> Result<Vec<Entry>, Failure> {
            self.list_kind(max_entries, false)
        }

        /// Bounded source-only library discovery: asset trees are never opened,
        /// and ordinary non-source entries do not incur metadata or content reads.
        pub fn list_sources(&self, max_entries: usize) -> Result<Vec<Entry>, Failure> {
            self.list_kind(max_entries, true)
        }

        fn list_kind(&self, max_entries: usize, sources_only: bool) -> Result<Vec<Entry>, Failure> {
            self.healthy()?;
            let mut entries = Vec::new();
            let mut remaining = max_entries;
            self.list_directory(&self.directory, "", 0, &mut remaining, &mut entries, sources_only)?;
            self.healthy()?;
            entries.sort_by(|a, b| a.path.cmp(&b.path));
            Ok(entries)
        }

        fn list_directory(&self, directory: &File, prefix: &str, depth: usize, remaining: &mut usize, output: &mut Vec<Entry>, sources_only: bool) -> Result<(), Failure> {
            if depth >= MAX_COMPONENTS { return Err(budget("Project tree exceeds the directory depth limit")); }
            for name in names_filtered(directory, *remaining, sources_only)? {
                *remaining = remaining.checked_sub(1).ok_or_else(|| budget("Project tree exceeds its entry limit"))?;
                let Some(name) = name.to_str() else { return Err(failure("denied_path", "Project filenames must be UTF-8")); };
                if name.starts_with(".muzpad-") || matches!(name, ".git" | "node_modules" | "target") { continue; }
                let path = if prefix.is_empty() { name.to_owned() } else { format!("{prefix}/{name}") };
                validate_path(&path)?;
                let file = match open_at(directory.as_raw_fd(), OsStr::new(name), libc::O_RDONLY | libc::O_NONBLOCK, 0) {
                    Ok(file) => file,
                    Err(error) if error.raw_os_error() == Some(libc::ELOOP) => continue,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(conflict("Project tree changed while being listed")),
                    Err(error) => return Err(io_failure(error)),
                };
                let metadata = file.metadata()?;
                if metadata.is_dir() {
                    self.list_directory(&file, &path, depth + 1, remaining, output, sources_only)?;
                    let current = directory_at(directory, OsStr::new(name))?;
                    if Identity::of(&current)? != Identity::of(&file)? { return Err(conflict("Directory changed while being listed")); }
                } else if metadata.is_file() && (!sources_only || name.ends_with(".muz")) {
                    let stamp = Stamp::of(&file)?;
                    verify_name(directory, name, &stamp)?;
                    output.push(Entry { path, bytes: stamp.size });
                }
            }
            Ok(())
        }

        pub fn write(&self, path: &str, bytes: Option<&[u8]>, expected: Option<&str>, journal_dir: &Path) -> Result<Option<String>, Failure> {
            validate_path(path)?;
            if bytes.is_some_and(|value| value.len() > MAX_WRITE_BYTES) {
                return Err(budget("Save exceeds the 256 MiB per-file limit"));
            }
            let _guard = self.lock()?;
            self.healthy()?;
            let Some(parent) = self.parent(path, bytes.is_some())? else {
                return if expected.is_none() { Ok(None) } else { Err(conflict("The expected file is missing")) };
            };
            let baseline = fingerprint_at(&parent.directory, &parent.leaf, MAX_WRITE_BYTES as u64)?;
            if version_of(&baseline) != expected { return Err(conflict("The disk version no longer matches the saved baseline")); }
            self.verify_parent(&parent, path)?;
            if baseline.is_none() && bytes.is_none() { return Ok(None); }
            let proposed = bytes.map(|value| hex::encode(Sha256::digest(value)));
            let mode = baseline.as_ref().map_or(0o600, |value| value.stamp.mode);
            let mut transaction = Transaction::begin(self, &parent, path, expected, proposed, mode, bytes.is_some(), journal_dir)?;
            let result = (|| {
                if let Some(bytes) = bytes {
                    let mut staged = transaction.create_payload()?;
                    staged.write_all(bytes)?;
                    set_mode(&staged, mode)?;
                    staged.sync_all()?;
                    transaction.directory.sync_all()?;
                }
                let _journal_guard = lock_journal(&transaction.journal_directory)?;
                transaction.record.phase = "publishing".to_owned();
                transaction.persist()?;
                self.publish(&parent, &mut transaction, MAX_WRITE_BYTES as u64)
            })();
            result.map_err(|error| transaction.annotate(error))
        }

        fn publish(&self, parent: &Parent, transaction: &mut Transaction, max_bytes: u64) -> Result<Option<String>, Failure> {
            self.verify_parent(parent, &transaction.record.path)?;
            #[cfg(test)]
            before_publish_hook();
            self.verify_parent(parent, &transaction.record.path)?;
            if transaction.record.operation == "delete" {
                rename_at(&parent.directory, &parent.leaf, &transaction.directory, PAYLOAD, libc::RENAME_NOREPLACE)?;
            } else {
                let flags = if transaction.record.expected.is_some() { libc::RENAME_EXCHANGE } else { libc::RENAME_NOREPLACE };
                rename_at(&transaction.directory, PAYLOAD, &parent.directory, &parent.leaf, flags)?;
            }
            // Both directory entries must reach durable storage before journal cleanup.
            transaction.directory.sync_all()?;
            parent.directory.sync_all()?;
            self.verify_parent(parent, &transaction.record.path)?;
            let displaced = fingerprint_at(&transaction.directory, PAYLOAD, max_bytes)?;
            if version_of(&displaced) != transaction.record.expected.as_deref() {
                return Err(conflict("A racing external version was preserved in the recovery directory"));
            }
            let current = fingerprint_at(&parent.directory, &parent.leaf, max_bytes)?;
            if version_of(&current) != transaction.record.proposed.as_deref() {
                return Err(conflict("The published destination changed; preserved recovery files need review"));
            }
            self.verify_parent(parent, &transaction.record.path)?;
            let version = transaction.record.proposed.clone();
            transaction.cleanup(parent, displaced.as_ref())?;
            Ok(version)
        }

        pub fn recover(&self, journal_dir: &Path) -> Result<Vec<Value>, Failure> {
            let _guard = self.lock()?;
            self.healthy()?;
            let (journal_path, journal_directory) = open_journal(journal_dir)?;
            let _journal_guard = lock_journal(&journal_directory)?;
            let mut records = Vec::new();
            for name in names(&journal_directory, MAX_JOURNALS * 2)? {
                let Some(name) = name.to_str() else { return Err(failure("recovery_required", "Invalid recovery journal filename")); };
                if !name.ends_with(".json") {
                    records.push(json!({"path": "", "state": "journal-fragment", "journal": journal_path.join(name), "action": "Inspect the interrupted journal fragment; it was not removed."}));
                    continue;
                }
                let loaded = read_journal(&journal_directory, name);
                let record = match loaded {
                    Ok(record) => record,
                    Err(error) => {
                        records.push(json!({"path": "", "state": "invalid-journal", "journal": journal_path.join(name), "message": error.message, "action": "Inspect or repair this journal; no project bytes were removed."}));
                        continue;
                    }
                };
                if record.root != self.identity() { continue; }
                if let Err(error) = validate_record(&record, name) {
                    records.push(json!({"path": record.path, "state": "invalid-journal", "journal": journal_path.join(name), "message": error.message}));
                    continue;
                }
                let path = record.path.clone();
                let journal_file = journal_path.join(name);
                let outcome = self.recover_one(record, &journal_path, &journal_directory);
                match outcome {
                    Ok(Some(record)) => records.push(record),
                    Ok(None) => {}
                    Err(error) => records.push(json!({"path": path, "state": "recovery-required", "journal": journal_file, "message": error.message, "help": error.help, "action": "Keep the journal and backups until their versions have been reviewed."})),
                }
            }
            self.healthy()?;
            Ok(records)
        }

        fn recover_one(&self, record: Journal, journal_path: &Path, journal_directory: &File) -> Result<Option<Value>, Failure> {
            let parent = self.parent(&record.path, false)?.ok_or_else(|| failure("recovery_required", "Transaction parent is missing"))?;
            if parent.identity != record.parent { return Err(failure("recovery_required", "Transaction parent identity changed; do not discard its backup")); }
            let transaction_path = self.path.join(&parent.relative).join(&record.transaction);
            let directory = match open_at(parent.directory.as_raw_fd(), OsStr::new(&record.transaction), libc::O_RDONLY | libc::O_DIRECTORY, 0) {
                Ok(directory) => directory,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    // A missing directory may mean cleanup reached rmdir but not journal unlink.
                    let current = fingerprint_at(&parent.directory, &parent.leaf, MAX_EXPORT_BYTES)?;
                    if record.phase == "publishing" && version_of(&current) == record.proposed.as_deref() {
                        self.verify_parent(&parent, &record.path)?;
                        unlink_private(journal_directory, &format!("{}.json", record.id), false)?;
                        return Ok(None);
                    }
                    return Err(failure("recovery_required", "Transaction backup is missing and completion cannot be proven"));
                }
                Err(error) => return Err(io_failure(error)),
            };
            private_directory(&directory)?;
            if Identity::of(&directory)? != record.transaction_identity {
                return Err(failure("recovery_required", "Transaction directory identity changed"));
            }
            let transaction = Transaction {
                record, journal_directory: directory_at(journal_directory, OsStr::new("."))?,
                journal_path: journal_path.to_path_buf(), directory, directory_path: transaction_path,
            };
            let result = (|| {
                let current = fingerprint_at(&parent.directory, &parent.leaf, MAX_EXPORT_BYTES)?;
                let payload = fingerprint_at(&transaction.directory, PAYLOAD, MAX_EXPORT_BYTES)?;
                self.verify_parent(&parent, &transaction.record.path)?;
                let completed = transaction.record.phase == "publishing"
                    && version_of(&current) == transaction.record.proposed.as_deref()
                    && version_of(&payload) == transaction.record.expected.as_deref();
                if completed {
                    transaction.cleanup(&parent, payload.as_ref())?;
                    return Ok(None);
                }
                // A completed cleanup can leave an empty, still-journaled directory.
                if transaction.record.phase == "publishing"
                    && payload.is_none()
                    && version_of(&current) == transaction.record.proposed.as_deref()
                    && names(&transaction.directory, 1)?.is_empty()
                {
                    transaction.cleanup(&parent, None)?;
                    return Ok(None);
                }
                let state = if transaction.record.phase == "staging" { "interrupted-staging" }
                    else if version_of(&current) == transaction.record.proposed.as_deref() { "displaced-conflict" }
                    else { "interrupted-or-external-change" };
                Ok(Some(json!({
                    "path": transaction.record.path, "state": state,
                    "operation": transaction.record.operation,
                    "expectedVersion": transaction.record.expected, "proposedVersion": transaction.record.proposed,
                    "diskVersion": version_of(&current), "backupVersion": version_of(&payload),
                    "backup": descriptor_path(&transaction.directory, &transaction.directory_path).join(PAYLOAD),
                    "journal": transaction.journal_file(),
                    "action": "Review disk and backup contents; copy wanted bytes to a new path before removing this journal."
                })))
            })();
            result.map_err(|error| transaction.annotate(error))
        }
    }

    fn lock_journal(directory: &File) -> Result<File, Failure> {
        let guard = directory_at(directory, OsStr::new("."))?;
        if unsafe { libc::flock(guard.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::WouldBlock {
                return Err(failure("recovery_required", "Another filesystem transaction is updating this recovery journal"));
            }
            return Err(io_failure(error));
        }
        Ok(guard)
    }

    fn open_journal(base: &Path) -> Result<(PathBuf, File), Failure> {
        let (base_path, base_directory) = absolute_directory(base, true)?;
        mkdir_at(&base_directory, OsStr::new(JOURNAL_NAME))?;
        let directory = directory_at(&base_directory, OsStr::new(JOURNAL_NAME))?;
        private_directory(&directory)?;
        Ok((base_path.join(JOURNAL_NAME), directory))
    }

    fn read_journal(directory: &File, name: &str) -> Result<Journal, Failure> {
        let mut file = file_at(directory, name)?.ok_or_else(|| failure("recovery_required", "Journal disappeared"))?;
        let before = Stamp::of(&file)?;
        if before.size > MAX_JOURNAL_BYTES as u64 { return Err(budget("Recovery journal exceeds its size limit")); }
        let mut bytes = Vec::with_capacity(before.size as usize);
        (&mut file).take(MAX_JOURNAL_BYTES as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > MAX_JOURNAL_BYTES || Stamp::of(&file)? != before || bytes.len() as u64 != before.size {
            return Err(failure("recovery_required", "Recovery journal changed while being read"));
        }
        verify_name(directory, name, &before)?;
        serde_json::from_slice(&bytes).map_err(|error| failure("recovery_required", format!("Invalid recovery journal: {error}")))
    }

    fn validate_record(record: &Journal, filename: &str) -> Result<(), Failure> {
        validate_path(&record.path)?;
        let valid_digest = |value: &Option<String>| value.as_ref().is_none_or(|value| {
            value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        });
        if record.schema != 1
            || Uuid::parse_str(&record.id).is_err()
            || filename != format!("{}.json", record.id)
            || record.transaction != format!(".muzpad-{}", record.id)
            || !matches!(record.operation.as_str(), "write" | "delete")
            || !matches!(record.phase.as_str(), "staging" | "publishing")
            || !valid_digest(&record.expected) || !valid_digest(&record.proposed)
            || (record.operation == "delete" && (record.expected.is_none() || record.proposed.is_some()))
            || (record.operation == "write" && record.phase == "publishing" && record.proposed.is_none())
        {
            return Err(failure("recovery_required", "Recovery journal has an unsupported or inconsistent schema"));
        }
        Ok(())
    }

    impl Transaction {
        #[allow(clippy::too_many_arguments)]
        fn begin(root: &Root, parent: &Parent, path: &str, expected: Option<&str>, proposed: Option<String>, mode: u32, write: bool, journal_base: &Path) -> Result<Self, Failure> {
            let (journal_path, journal_directory) = open_journal(journal_base)?;
            let _journal_guard = lock_journal(&journal_directory)?;
            if names(&journal_directory, MAX_JOURNALS * 2)?.len() >= MAX_JOURNALS {
                let mut error = budget("Recovery journal is full; review outstanding save recovery records before saving again");
                error.help = Some(vec![format!("Recovery journals: {}", journal_path.display())]);
                return Err(error);
            }
            let id = Uuid::new_v4().to_string();
            let transaction_name = format!(".muzpad-{id}");
            if !mkdir_at(&parent.directory, OsStr::new(&transaction_name))? {
                return Err(conflict("A recovery transaction name already exists"));
            }
            let directory = directory_at(&parent.directory, OsStr::new(&transaction_name))?;
            private_directory(&directory)?;
            let record = Journal {
                schema: 1, id, root: root.identity(), root_path: root.path.clone(), path: path.to_owned(),
                parent: parent.identity, transaction_identity: Identity::of(&directory)?, transaction: transaction_name,
                operation: if write { "write" } else { "delete" }.to_owned(), phase: "staging".to_owned(),
                expected: expected.map(str::to_owned), proposed, mode,
            };
            let directory_path = root.path.join(&parent.relative).join(&record.transaction);
            let transaction = Self { record, journal_directory, journal_path, directory, directory_path };
            transaction.persist().map_err(|error| transaction.annotate(error))?;
            Ok(transaction)
        }

        fn create_payload(&self) -> Result<File, Failure> {
            open_at(self.directory.as_raw_fd(), OsStr::new(PAYLOAD), libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL, 0o600)
                .map_err(io_failure)
        }

        fn journal_file(&self) -> PathBuf { self.journal_path.join(format!("{}.json", self.record.id)) }

        fn persist(&self) -> Result<(), Failure> {
            let bytes = serde_json::to_vec(&self.record).map_err(|error| failure("project_io", error.to_string()))?;
            if bytes.len() > MAX_JOURNAL_BYTES { return Err(budget("Recovery journal exceeds its size limit")); }
            let temporary = format!("{}.{}.pending", self.record.id, Uuid::new_v4());
            let mut file = open_at(self.journal_directory.as_raw_fd(), OsStr::new(&temporary), libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL, 0o600)
                .map_err(io_failure)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            // Journal names are confined to the private app-data directory, not project paths.
            let source = c_name(OsStr::new(&temporary))?;
            let target = c_name(OsStr::new(&format!("{}.json", self.record.id)))?;
            if unsafe { libc::renameat(self.journal_directory.as_raw_fd(), source.as_ptr(), self.journal_directory.as_raw_fd(), target.as_ptr()) } < 0 {
                return Err(io_failure(io::Error::last_os_error()));
            }
            self.journal_directory.sync_all()?;
            Ok(())
        }

        fn annotate(&self, mut error: Failure) -> Failure {
            error.path = Some(self.record.path.clone());
            let help = error.help.get_or_insert_with(Vec::new);
            help.push(format!("Preserved transaction contents: {}", descriptor_path(&self.directory, &self.directory_path).display()));
            help.push(format!("Preserved payload/backup: {}", descriptor_path(&self.directory, &self.directory_path).join(PAYLOAD).display()));
            help.push(format!("Recovery journal: {}", self.journal_file().display()));
            help.push("Do not delete these files until disk and backup versions have been reviewed.".to_owned());
            error
        }

        fn cleanup(&self, parent: &Parent, payload: Option<&Fingerprint>) -> Result<(), Failure> {
            private_directory(&self.directory)?;
            // Recovery may observe a rename whose original process died before
            // fsync. Persist both sides before removing its last displaced link.
            self.directory.sync_all()?;
            parent.directory.sync_all()?;
            let entries = names(&self.directory, 2)?;
            if entries.iter().any(|name| name != OsStr::new(PAYLOAD)) {
                return Err(failure("recovery_required", "Unexpected files in the recovery directory were preserved"));
            }
            if let Some(payload) = payload {
                // Only a proven expected baseline in a private name can be discarded.
                if Some(payload.version.as_str()) != self.record.expected.as_deref() {
                    return Err(conflict("Unexpected displaced version must not be discarded"));
                }
                verify_name(&self.directory, PAYLOAD, &payload.stamp)?;
                unlink_private(&self.directory, PAYLOAD, false)?;
            } else if !entries.is_empty() {
                return Err(conflict("An unexpected recovery payload appeared"));
            }
            let named = directory_at(&parent.directory, OsStr::new(&self.record.transaction))?;
            if Identity::of(&named)? != self.record.transaction_identity { return Err(conflict("Recovery directory was replaced")); }
            unlink_private(&parent.directory, &self.record.transaction, true)?;
            unlink_private(&self.journal_directory, &format!("{}.json", self.record.id), false)?;
            Ok(())
        }
    }

    /// Native-dialog-selected destination. The child sees only its private stage
    /// pathname, never authority to replace the selected destination directly.
    pub struct ExportDestination {
        root: Root,
        parent: Parent,
        transaction: Transaction,
        staged_path: PathBuf,
        preserve: bool,
    }

    pub fn stage_export(destination: &Path) -> Result<ExportDestination, Failure> {
        let name = destination.file_name().and_then(OsStr::to_str)
            .ok_or_else(|| failure("denied_path", "Export destination needs a UTF-8 filename"))?;
        validate_path(name)?;
        let directory = destination.parent().filter(|path| !path.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
        let root = Root::open(directory)?;
        let parent = root.parent(name, false)?.ok_or_else(|| failure("root_missing", "Export parent is missing"))?;
        let baseline = fingerprint_at(&parent.directory, name, MAX_EXPORT_BYTES)?;
        root.verify_parent(&parent, name)?;
        let transaction = Transaction::begin(
            &root, &parent, name, version_of(&baseline), None,
            baseline.as_ref().map_or(0o600, |value| value.stamp.mode), true, root.path(),
        )?;
        // The trusted child creates this file with create_new. /proc/<parent>/fd
        // retains directory authority even if an ancestor is renamed mid-export.
        let staged_path = PathBuf::from(format!(
            "/proc/{}/fd/{}/{}", std::process::id(), transaction.directory.as_raw_fd(), PAYLOAD,
        ));
        Ok(ExportDestination { root, parent, transaction, staged_path, preserve: false })
    }

    impl ExportDestination {
        pub fn staged_path(&self) -> &Path { &self.staged_path }

        pub fn publish(mut self) -> Result<(), Failure> {
            // Every failure from this point is actionable recovery, never Drop cleanup.
            self.preserve = true;
            let result = (|| {
                self.root.verify_parent(&self.parent, &self.transaction.record.path)?;
                let file = file_at(&self.transaction.directory, PAYLOAD)?
                    .ok_or_else(|| failure("file_write_failed", "Export worker did not leave a staged file"))?;
                let metadata = file.metadata()?;
                if metadata.uid() != unsafe { libc::geteuid() } || metadata.nlink() != 1 {
                    return Err(conflict("Export stage is not a privately owned single-link file"));
                }
                set_mode(&file, self.transaction.record.mode)?;
                file.sync_all()?;
                let staged = fingerprint_at(&self.transaction.directory, PAYLOAD, MAX_EXPORT_BYTES)?
                    .ok_or_else(|| failure("file_write_failed", "Export staging file disappeared"))?;
                let _journal_guard = lock_journal(&self.transaction.journal_directory)?;
                self.transaction.record.proposed = Some(staged.version);
                self.transaction.record.phase = "publishing".to_owned();
                self.transaction.directory.sync_all()?;
                self.transaction.persist()?;
                self.root.publish(&self.parent, &mut self.transaction, MAX_EXPORT_BYTES)?;
                Ok(())
            })();
            result.map_err(|error| self.transaction.annotate(error))
        }
    }

    impl Drop for ExportDestination {
        fn drop(&mut self) {
            if self.preserve { return; }
            // Only the sole regular payload in our private directory is ours to
            // cancel. Linked, foreign, replaced-directory, or extra artifacts stay.
            let cleanup = || -> Result<(), Failure> {
                let _journal_guard = lock_journal(&self.transaction.journal_directory)?;
                private_directory(&self.transaction.directory)?;
                if Identity::of(&self.transaction.directory)? != self.transaction.record.transaction_identity {
                    return Err(conflict("Cancelled export transaction directory was replaced"));
                }
                let entries = names(&self.transaction.directory, 2)?;
                if entries.is_empty() { return self.transaction.cleanup(&self.parent, None); }
                if entries != vec![OsString::from(PAYLOAD)] {
                    return Err(failure("recovery_required", "Cancelled export has unexpected recovery contents"));
                }
                let file = file_at(&self.transaction.directory, PAYLOAD)?
                    .ok_or_else(|| failure("recovery_required", "Cancelled export stage is missing"))?;
                let metadata = file.metadata()?;
                if metadata.uid() != unsafe { libc::geteuid() } || metadata.nlink() != 1 {
                    return Err(conflict("Cancelled export stage is not privately owned"));
                }
                let stamp = Stamp::of(&file)?;
                verify_name(&self.transaction.directory, PAYLOAD, &stamp)?;
                unlink_private(&self.transaction.directory, PAYLOAD, false)?;
                self.transaction.cleanup(&self.parent, None)
            };
            let _ = cleanup(); // Failure intentionally retains journal/artifacts for recover().
        }
    }

    #[cfg(test)]
    pub(crate) fn set_before_publish(callback: impl FnOnce() + 'static) {
        BEFORE_PUBLISH.with(|hook| *hook.borrow_mut() = Some(Box::new(callback)));
    }

    #[cfg(test)]
    thread_local! {
        static BEFORE_PUBLISH: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = std::cell::RefCell::new(None);
    }

    #[cfg(test)]
    fn before_publish_hook() {
        BEFORE_PUBLISH.with(|hook| {
            let callback = hook.borrow_mut().take();
            if let Some(callback) = callback { callback(); }
        });
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::fs::{symlink, PermissionsExt};

        fn digest(bytes: &[u8]) -> String { hex::encode(Sha256::digest(bytes)) }

        fn hook(callback: impl FnOnce() + 'static) {
            BEFORE_PUBLISH.with(|hook| *hook.borrow_mut() = Some(Box::new(callback)));
        }

        #[test]
        fn rejects_ambiguous_and_internal_paths() {
            for path in ["", "/etc/passwd", "../a", "a/../b", "a//b", "a/./b", "a/", "a\\b", "a\0b", ".muzpad-temp", "a/.muzpad-private/b", "C:/a"] {
                assert!(validate_path(path).is_err(), "{path:?}");
            }
            assert!(validate_path(&"a".repeat(256)).is_err());
            assert!(validate_path("music/main.muz").is_ok());
        }

        #[test]
        fn digest_reads_limits_and_repeated_listing() {
            let project = tempfile::tempdir().unwrap();
            std::fs::write(project.path().join("a.muz"), b"abc").unwrap();
            let root = Root::open(project.path()).unwrap();
            let read = root.read("a.muz", 3).unwrap().unwrap();
            assert_eq!(read.version, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
            assert_eq!(root.fingerprint("a.muz", 3).unwrap(), Some(read.version));
            assert!(root.read("a.muz", 2).is_err());
            assert!(root.read("missing", 10).unwrap().is_none());
            assert_eq!(root.list(10).unwrap().len(), 1);
            assert_eq!(root.list(10).unwrap().len(), 1);
            assert!(root.list(0).is_err());
        }

        #[test]
        fn symlinks_never_grant_read_or_write_authority() {
            let project = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            let journal = tempfile::tempdir().unwrap();
            std::fs::write(outside.path().join("secret"), b"untouched").unwrap();
            symlink(outside.path(), project.path().join("escape")).unwrap();
            symlink(outside.path().join("secret"), project.path().join("leaf")).unwrap();
            let root = Root::open(project.path()).unwrap();
            assert!(root.read("escape/secret", 100).is_err());
            assert!(root.read("leaf", 100).is_err());
            assert!(root.write("escape/secret", Some(b"bad"), None, journal.path()).is_err());
            assert!(root.write("leaf", Some(b"bad"), None, journal.path()).is_err());
            assert!(Root::open(&project.path().join("escape")).is_err());
            assert_eq!(std::fs::read(outside.path().join("secret")).unwrap(), b"untouched");
            assert!(root.list(10).unwrap().is_empty());
        }

        #[test]
        fn preserves_modes_and_securely_creates_parents() {
            let project = tempfile::tempdir().unwrap();
            let journal = tempfile::tempdir().unwrap();
            let target = project.path().join("main.muz");
            std::fs::write(&target, b"old").unwrap();
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
            let root = Root::open(project.path()).unwrap();
            assert_eq!(root.write("main.muz", Some(b"new"), Some(&digest(b"old")), journal.path()).unwrap(), Some(digest(b"new")));
            assert_eq!(std::fs::metadata(&target).unwrap().mode() & 0o777, 0o640);
            root.write("nested/next.muz", Some(b"next"), None, journal.path()).unwrap();
            assert_eq!(std::fs::metadata(project.path().join("nested")).unwrap().mode() & 0o777, 0o700);
            assert_eq!(std::fs::metadata(project.path().join("nested/next.muz")).unwrap().mode() & 0o777, 0o600);
            assert!(root.recover(journal.path()).unwrap().is_empty());
        }

        #[test]
        fn racing_creation_is_not_clobbered() {
            let project = tempfile::tempdir().unwrap();
            let journal = tempfile::tempdir().unwrap();
            let target = project.path().join("new.muz");
            let raced = target.clone();
            hook(move || std::fs::write(raced, b"external").unwrap());
            let root = Root::open(project.path()).unwrap();
            let error = root.write("new.muz", Some(b"local"), None, journal.path()).unwrap_err();
            assert_eq!(error.code, "source_conflict");
            assert_eq!(std::fs::read(target).unwrap(), b"external");
            let recovery = root.recover(journal.path()).unwrap();
            assert_eq!(recovery.len(), 1);
            assert_eq!(std::fs::read(recovery[0]["backup"].as_str().unwrap()).unwrap(), b"local");
            assert!(error.help.unwrap().iter().any(|help| help.contains("payload")));
        }

        #[test]
        fn exchanged_external_version_survives_in_backup() {
            let project = tempfile::tempdir().unwrap();
            let journal = tempfile::tempdir().unwrap();
            let target = project.path().join("main.muz");
            std::fs::write(&target, b"old").unwrap();
            let raced = target.clone();
            hook(move || std::fs::write(raced, b"external").unwrap());
            let root = Root::open(project.path()).unwrap();
            assert!(root.write("main.muz", Some(b"local"), Some(&digest(b"old")), journal.path()).is_err());
            assert_eq!(std::fs::read(target).unwrap(), b"local");
            let recovery = root.recover(journal.path()).unwrap();
            assert_eq!(recovery[0]["state"], "displaced-conflict");
            assert_eq!(std::fs::read(recovery[0]["backup"].as_str().unwrap()).unwrap(), b"external");
            assert_eq!(root.recover(journal.path()).unwrap().len(), 1);
        }

        #[test]
        fn deletion_moves_and_preserves_racing_bytes() {
            let project = tempfile::tempdir().unwrap();
            let journal = tempfile::tempdir().unwrap();
            let target = project.path().join("main.muz");
            std::fs::write(&target, b"old").unwrap();
            let root = Root::open(project.path()).unwrap();
            assert!(root.write("main.muz", None, Some(&digest(b"wrong")), journal.path()).is_err());
            let raced = target.clone();
            hook(move || std::fs::write(raced, b"external").unwrap());
            assert!(root.write("main.muz", None, Some(&digest(b"old")), journal.path()).is_err());
            assert!(!target.exists());
            let recovery = root.recover(journal.path()).unwrap();
            assert_eq!(std::fs::read(recovery[0]["backup"].as_str().unwrap()).unwrap(), b"external");
            root.write("other.muz", Some(b"delete"), None, journal.path()).unwrap();
            assert_eq!(root.write("other.muz", None, Some(&digest(b"delete")), journal.path()).unwrap(), None);
            assert!(!project.path().join("other.muz").exists());
        }

        #[test]
        fn parent_replacement_cannot_redirect_publication() {
            let project = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            let journal = tempfile::tempdir().unwrap();
            std::fs::create_dir(project.path().join("music")).unwrap();
            std::fs::write(project.path().join("music/main.muz"), b"old").unwrap();
            std::fs::write(outside.path().join("main.muz"), b"outside").unwrap();
            let project_path = project.path().to_owned();
            let outside_path = outside.path().to_owned();
            hook(move || {
                std::fs::rename(project_path.join("music"), project_path.join("moved")).unwrap();
                symlink(outside_path, project_path.join("music")).unwrap();
            });
            let root = Root::open(project.path()).unwrap();
            assert!(root.write("music/main.muz", Some(b"local"), Some(&digest(b"old")), journal.path()).is_err());
            assert_eq!(std::fs::read(outside.path().join("main.muz")).unwrap(), b"outside");
            assert_eq!(std::fs::read(project.path().join("moved/main.muz")).unwrap(), b"old");
        }

        #[test]
        fn root_identity_rejects_replacement() {
            let container = tempfile::tempdir().unwrap();
            let path = container.path().join("project");
            std::fs::create_dir(&path).unwrap();
            let root = Root::open(&path).unwrap();
            std::fs::rename(&path, container.path().join("moved")).unwrap();
            std::fs::create_dir(&path).unwrap();
            assert!(root.healthy().is_err());
            assert!(root.read("missing", 10).is_err());
        }

        #[test]
        fn recovery_finishes_durable_exchange_but_retains_staging() {
            let project = tempfile::tempdir().unwrap();
            let journal = tempfile::tempdir().unwrap();
            std::fs::write(project.path().join("main.muz"), b"old").unwrap();
            let root = Root::open(project.path()).unwrap();
            let parent = root.parent("main.muz", false).unwrap().unwrap();
            let mut transaction = Transaction::begin(&root, &parent, "main.muz", Some(&digest(b"old")), Some(digest(b"new")), 0o600, true, journal.path()).unwrap();
            let mut staged = transaction.create_payload().unwrap();
            staged.write_all(b"new").unwrap();
            staged.sync_all().unwrap();
            transaction.record.phase = "publishing".to_owned();
            transaction.persist().unwrap();
            rename_at(&transaction.directory, PAYLOAD, &parent.directory, "main.muz", libc::RENAME_EXCHANGE).unwrap();
            parent.directory.sync_all().unwrap();
            transaction.directory.sync_all().unwrap();
            drop(transaction);
            assert!(root.recover(journal.path()).unwrap().is_empty());
            assert_eq!(std::fs::read(project.path().join("main.muz")).unwrap(), b"new");
            let parent = root.parent("draft.muz", false).unwrap().unwrap();
            let transaction = Transaction::begin(&root, &parent, "draft.muz", None, Some(digest(b"draft")), 0o600, true, journal.path()).unwrap();
            transaction.create_payload().unwrap().write_all(b"draft").unwrap();
            drop(transaction);
            let records = root.recover(journal.path()).unwrap();
            assert_eq!(records[0]["state"], "interrupted-staging");
            assert_eq!(std::fs::read(records[0]["backup"].as_str().unwrap()).unwrap(), b"draft");
        }

        #[test]
        fn export_publication_and_cancellation_obey_destination_baseline() {
            let project = tempfile::tempdir().unwrap();
            let target = project.path().join("mix.wav");
            let staged = stage_export(&target).unwrap();
            let private_path = staged.staged_path().to_owned();
            assert!(!private_path.exists());
            std::fs::OpenOptions::new().write(true).create_new(true).open(&private_path)
                .unwrap().write_all(b"cancelled").unwrap();
            drop(staged);
            assert!(!target.exists());
            assert!(!private_path.exists());
            let staged = stage_export(&target).unwrap();
            std::fs::write(staged.staged_path(), b"rendered").unwrap();
            staged.publish().unwrap();
            assert_eq!(std::fs::read(&target).unwrap(), b"rendered");
            let staged = stage_export(&target).unwrap();
            std::fs::write(staged.staged_path(), b"new-render").unwrap();
            std::fs::write(&target, b"external").unwrap();
            assert!(staged.publish().is_err());
            let root = Root::open(project.path()).unwrap();
            let records = root.recover(project.path()).unwrap();
            assert_eq!(std::fs::read(records[0]["backup"].as_str().unwrap()).unwrap(), b"external");
        }

        #[test]
        fn recovery_preserves_unexpected_private_artifacts() {
            let project = tempfile::tempdir().unwrap();
            let journal = tempfile::tempdir().unwrap();
            let root = Root::open(project.path()).unwrap();
            let parent = root.parent("draft.muz", false).unwrap().unwrap();
            let transaction = Transaction::begin(&root, &parent, "draft.muz", None, Some(digest(b"draft")), 0o600, true, journal.path()).unwrap();
            transaction.create_payload().unwrap().write_all(b"draft").unwrap();
            std::fs::write(transaction.directory_path.join("unexpected"), b"external").unwrap();
            let directory = transaction.directory_path.clone();
            drop(transaction);
            let records = root.recover(journal.path()).unwrap();
            assert_eq!(records.len(), 1);
            assert_eq!(std::fs::read(directory.join("unexpected")).unwrap(), b"external");
            assert_eq!(std::fs::read(directory.join(PAYLOAD)).unwrap(), b"draft");
        }

        #[test]
        fn recovery_completes_a_journaled_deletion() {
            let project = tempfile::tempdir().unwrap();
            let journal = tempfile::tempdir().unwrap();
            std::fs::write(project.path().join("main.muz"), b"old").unwrap();
            let root = Root::open(project.path()).unwrap();
            let parent = root.parent("main.muz", false).unwrap().unwrap();
            let mut transaction = Transaction::begin(&root, &parent, "main.muz", Some(&digest(b"old")), None, 0o600, false, journal.path()).unwrap();
            transaction.record.phase = "publishing".to_owned();
            transaction.persist().unwrap();
            rename_at(&parent.directory, "main.muz", &transaction.directory, PAYLOAD, libc::RENAME_NOREPLACE).unwrap();
            drop(transaction);
            assert!(root.recover(journal.path()).unwrap().is_empty());
            assert!(!project.path().join("main.muz").exists());
        }

        #[test]
        fn journal_budget_never_discards_old_recovery() {
            let project = tempfile::tempdir().unwrap();
            let journal = tempfile::tempdir().unwrap();
            let (path, _) = open_journal(journal.path()).unwrap();
            for index in 0..MAX_JOURNALS {
                std::fs::write(path.join(format!("{index}.pending")), b"fragment").unwrap();
            }
            let root = Root::open(project.path()).unwrap();
            assert_eq!(root.write("new.muz", Some(b"new"), None, journal.path()).unwrap_err().code, "resource_budget");
            assert!(!project.path().join("new.muz").exists());
            assert_eq!(root.recover(journal.path()).unwrap().len(), MAX_JOURNALS);
        }

        #[test]
        fn export_stage_retains_directory_authority_after_parent_move() {
            let container = tempfile::tempdir().unwrap();
            let original = container.path().join("original");
            let moved = container.path().join("moved");
            std::fs::create_dir(&original).unwrap();
            let staged = stage_export(&original.join("mix.wav")).unwrap();
            assert!(staged.staged_path().to_string_lossy().starts_with(&format!("/proc/{}/fd/", std::process::id())));
            std::fs::rename(&original, &moved).unwrap();
            std::fs::create_dir(&original).unwrap();
            std::fs::write(staged.staged_path(), b"rendered").unwrap();
            assert!(staged.publish().is_err());
            assert!(!original.join("mix.wav").exists());
            let root = Root::open(&moved).unwrap();
            let recovery = root.recover(&moved).unwrap();
            assert_eq!(std::fs::read(recovery[0]["backup"].as_str().unwrap()).unwrap(), b"rendered");
        }

        #[test]
        fn listing_excludes_build_and_transaction_trees() {
            let project = tempfile::tempdir().unwrap();
            for directory in [".git", "node_modules", "target", ".muzpad-private"] {
                std::fs::create_dir(project.path().join(directory)).unwrap();
                std::fs::write(project.path().join(directory).join("hidden"), b"hidden").unwrap();
            }
            std::fs::write(project.path().join("main.muz"), b"source").unwrap();
            let root = Root::open(project.path()).unwrap();
            let entries = root.list(10).unwrap();
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].path, "main.muz");
            fn is_send<T: Send>() {}
            is_send::<Root>();
            is_send::<ExportDestination>();
        }

        #[test]
        fn source_listing_skips_assets_and_counts_only_source_candidates() {
            let project = tempfile::tempdir().unwrap();
            std::fs::create_dir(project.path().join("assets")).unwrap();
            std::fs::write(project.path().join("assets/hidden.muz"), b"not a library source").unwrap();
            std::fs::create_dir(project.path().join("library")).unwrap();
            std::fs::write(project.path().join("library/instrument.muz"), b"source").unwrap();
            std::fs::write(project.path().join("main.muz"), b"source").unwrap();
            for index in 0..32 {
                std::fs::write(project.path().join(format!("sample-{index}.wav")), b"asset").unwrap();
            }
            symlink(project.path().join("assets"), project.path().join("linked-assets")).unwrap();
            let root = Root::open(project.path()).unwrap();
            let entries = root.list_sources(3).unwrap();
            assert_eq!(entries.iter().map(|entry| entry.path.as_str()).collect::<Vec<_>>(),
                vec!["library/instrument.muz", "main.muz"]);
            assert!(root.list_sources(2).is_err());
            assert!(root.list(3).is_err());
        }
    }
}

#[cfg(target_os = "linux")]
pub use linux::{stage_export, ExportDestination, Root};
#[cfg(all(test, target_os = "linux"))]
pub(crate) use linux::set_before_publish;

#[cfg(not(target_os = "linux"))]
mod unsupported {
    use super::*;

    fn unsupported() -> Failure {
        Failure::new("unsupported_platform", "project", "Secure project storage requires Linux dirfd and renameat2 guarantees on this build")
    }

    pub struct Root { path: PathBuf }
    impl Root {
        pub fn open(_: &Path) -> Result<Self, Failure> { Err(unsupported()) }
        pub fn path(&self) -> &Path { &self.path }
        pub fn identity(&self) -> String { String::new() }
        pub fn healthy(&self) -> Result<(), Failure> { Err(unsupported()) }
        pub fn list(&self, _: usize) -> Result<Vec<Entry>, Failure> { Err(unsupported()) }
        pub fn list_sources(&self, _: usize) -> Result<Vec<Entry>, Failure> { Err(unsupported()) }
        pub fn read(&self, _: &str, _: usize) -> Result<Option<ReadFile>, Failure> { Err(unsupported()) }
        pub fn fingerprint(&self, _: &str, _: u64) -> Result<Option<String>, Failure> { Err(unsupported()) }
        pub fn write(&self, _: &str, _: Option<&[u8]>, _: Option<&str>, _: &Path) -> Result<Option<String>, Failure> { Err(unsupported()) }
        pub fn recover(&self, _: &Path) -> Result<Vec<Value>, Failure> { Err(unsupported()) }
    }

    pub struct ExportDestination { path: PathBuf }
    pub fn stage_export(_: &Path) -> Result<ExportDestination, Failure> { Err(unsupported()) }
    impl ExportDestination {
        pub fn staged_path(&self) -> &Path { &self.path }
        pub fn publish(self) -> Result<(), Failure> { Err(unsupported()) }
    }
}

#[cfg(not(target_os = "linux"))]
pub use unsupported::{stage_export, ExportDestination, Root};
