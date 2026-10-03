# Desktop host

The Linux Tauri parent owns project authority, recovery, preferences, filesystem
watching, dialogs and engine supervision. The fixed `muzpad-engine` child owns
compilation, accepted inspection, native audio and rendering through muz-core's
embedding APIs (`docs/embedding.md` in the core checkout). Shared application DTOs
live in `src/host/contracts.ts`; Rust dispatch and wire identities live in
`src-tauri/src/protocol.rs`.

`src-tauri` is a standalone Cargo workspace. Its default `shell` feature builds
the Tauri application; `--no-default-features --bin muzpad-engine` builds the
engine without a staged sidecar. Both executables embed the same full core
revision from `src-tauri/core-revision` and require protocol version 1.

## Project and revision authority

Project IDs and epochs bind canonical roots; selecting an external folder grants
read access only, and export dialogs grant one staged destination. Editable
project buffers, including closed/new/deleted files, are captured at one
sourceVersion. Clean imported dependencies retain disk versions. Before apply,
the parent validates source/dependency authority; watcher notifications never
trigger compilation or stand in for an immutable snapshot.

Source navigation resolves canonical editable file IDs or authorized readonly
documents, never basename guesses or new grants. Reads, snapshots and archive
imports have explicit size budgets. Root-relative writes reject traversal and
symlink escapes. Saves report per-file captured-version outcomes; later typing
remains dirty. Linux no-replace creation and backup-preserving replacement retain
racing disk versions through interrupted-save recovery rather than silently
overwriting them. Clean external changes refresh without rebuilding; dirty
changes preserve base/local/disk conflicts for explicit resolution.

The child promotes candidates only on authoritative native applied receipts.
Rejection preserves the previous accepted audio/inspection revision. Transport,
inspection and telemetry carry exact accepted identities; detailed hidden
analysis is suspended without stopping audio. WAV/MIDI exports pin accepted
resources independently of working edits and temporary audition controls.
Changed/unpinnable resources and clipping fail explicitly. Recovery/preferences
are separate from source/archive state. Project/window close is vetoable until
save/discard/cancel, conflicts and active exports are resolved; child loss leaves
editor buffers available for explicit restart.

## Trusted process boundary


The bundled `main` window is created in Rust. Navigation is limited to the local
Tauri origin, new windows are denied, and each of the seven IPC entry points
checks the calling window and origin. The capability file grants event listening,
not filesystem or shell access. `host.openExternal` accepts explicit HTTP(S) URLs
only and invokes the system opener without a shell. Markdown, project source,
archive contents and plugin configuration are data, not webview permissions.

The parent launches only the sibling `muzpad-engine` executable. Dedicated
inherited descriptors 3 and 4 carry four-byte little-endian length-framed JSON.
The maximum private frame is 2 MiB; plugin stdout/stderr are separate, drained
into a bounded 64 KiB diagnostic ring. The child is its own process-group leader.
Linux parent-death signaling prevents the engine surviving a crashed shell. A
dedicated spawning owner thread remains alive until the child is reaped, so a
transient Tauri request worker retiring cannot terminate healthy audio.
Bounded graceful shutdown includes writer-queue admission in its absolute request
deadline before escalating to process-group termination and reaping. Saturated
private-frame traffic cannot strand shutdown before that deadline starts.
Plugins execute trusted native code in this process boundary, **not** in individual
plugin sandboxes. A plugin can hang or terminate the engine. The engine process
is not an OS filesystem sandbox: read grants constrain the host's loaders and
resolvers, not arbitrary syscalls made by trusted native plugin code.

Authorized Reveal uses the desktop session's `org.freedesktop.FileManager1`
`ShowItems`/`ShowFolders` methods through `gdbus`, with a four-second bounded
client lifecycle and a typed unavailable error when the integration is absent.
The Debian package depends on `libglib2.0-bin`; file-type associations are neither
modified nor used to launch a file in an arbitrary application.

The public boundary is the frozen `workbench_bootstrap`, `workbench_request`,
`workbench_cancel` and four `workbench_upload_*` commands. Requests are dispatched
through a closed Rust method enum. Private engine requests and replies carry
protocol/request/project/engine/source/revision identities. An internal prepared
event requires parent source/dependency validation before apply authorization;
it is never forwarded as an accepted revision. Child loss rejects outstanding
requests, clears accepted native handles and leaves the project service alive.
Restart is explicit and uploads parent-retained source before rebuilding.
Only an explicit restart's apply-authority handshake may validate the exact
parent-retained snapshot against its original consumed dependencies rather than
newer working-text baselines; normal builds retain current source/disk checks.

Uploads and immutable reply/event transfers use sequential, base64-encoded
256 KiB chunks. Eight retained transfers, a 512 MiB encoded aggregate budget and a
two-minute inactivity lifetime bound shell retention; source snapshots remain
limited to 64 MiB and individual source documents to 8 MiB. Engine inspection
continues through bounded core pages rather than transferring an unbounded graph.
Export dialogs grant a native staging destination. Only a matching successful
job may publish it; cancelled/clipped/failed jobs never publish staged audio.

External read access is granted through a native folder chooser when compilation
returns a `grant_required` failure with an absolute dependency path. The chosen
canonical folder must contain that dependency; it receives read authority only.
The failed build is not silently retried: the user rebuilds again so the newly
authorized sources become part of a fresh capture. Project/import JSON cannot
create these grants. Recovery retains at most twelve latest-project drafts within
512 MiB; source captures are capped at 64 MiB, import/archive assets at 256 MiB,
and interrupted-save recovery records at 128.

Imported gist provenance is optional normalized `id[/revision]` metadata
(32–40 lowercase hexadecimal ID characters and an optional 40-character revision).
The parent retains it in workspace snapshots, recovery and recents, including
reopening a recent project. It does not enter `muzpad.json`, ZIP settings or
preferences and grants no additional filesystem authority.

Private formatter requests and results larger than a 2 MiB frame use sequential
256 KiB base64 chunks in both directions, retaining the full request context and
buffer version. Reassembly allows at most eight transfers and 64 MiB aggregate
encoded-document payload, with a two-minute inactivity lifetime; the public source
document limit remains 8 MiB. Exact-file plugin/config grants retain their basename
restriction in the child rather than granting sibling files in their directory.
First-save destination checks and asset copies include project-owned resources
only; authorized linked libraries remain links. Disk rescan validates all changed
source/settings inputs before publishing any authoritative buffer updates.
Omitted entry candidates and the equivalent explicit singleton entry are compared
semantically, so the first Untitled capture retains its requested source version
rather than creating a phantom settings edit. A real-child regression checks this
initial parent snapshot through entry checking.
Diagnostic mapping follows typed core error causes and preserves their structured
location, help and callers without parsing a formatted terminal message.

### Linux build and packaging order

Build prerequisites are Rust/Cargo, Node/npm for the shared production UI,
GTK 3 and WebKitGTK 4.1 development packages, PipeWire/native audio development
libraries required by the pinned core, a C/C++ toolchain and the Tauri CLI.
Runtime packages must provide GTK 3, WebKitGTK 4.1 and PipeWire. System packages
are not installed by the application. Linux is the current implementation target;
this does not establish compatibility with a particular older distribution.

1. Build the core source pinned in `src-tauri/core-revision`. The optional
   `MUZPAD_CORE_REVISION` environment variable must match that full SHA exactly.
   Both executables embed the pin; runtime never consults a source checkout.
2. Build the child with
   `cargo build --manifest-path src-tauri/Cargo.toml --no-default-features --bin muzpad-engine --release`.
3. Copy `src-tauri/target/release/muzpad-engine` to
   `src-tauri/binaries/muzpad-engine-<Rust target triple>`. Keep the executable bit.
   Tauri removes the target-triple suffix when staging the fixed sibling binary.
4. Stage redistributable `.muz` modules and their required JSON/config/document
   resources from the pinned core's `contrib/` tree under
   `src-tauri/resources/library/contrib/`, preserving declaring-module-relative
   paths. Tauri maps `resources/library/` to installed `library/`. The standard
   library remains embedded in core. Do not copy `contrib/**/assets/`, installed
   plugin binaries or user preset/sample libraries without redistribution rights;
   absent external resources produce explicit dependency/grant errors.
5. Produce `dist/` with the shared production build, then build/package the default
   shell feature with the Tauri CLI using `src-tauri/tauri.conf.json`.
   The configuration intentionally has no development-server URL: development
   also loads a production-bundled UI. Packaging automation owns reproducible
   staging and release orchestration outside this crate.

The shell feature's build script requires staged resources and sidecar; do not
start with a default-feature Cargo build before step 2. Both Linux DEB and
AppImage targets are configured; see [README](../README.md) for supported commands,
the measured Linux baseline and the limits of package/runtime qualification.
