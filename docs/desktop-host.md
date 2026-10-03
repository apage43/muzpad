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

Project IDs and epochs bind canonical roots. Deliberately opened local projects
use the logged-in account's ordinary read authority; reads are demand-loaded from
consumed modules/assets rather than recursively capturing granted library trees.
Editable buffers, including closed/new/deleted files, are captured at one
sourceVersion and override disk fallback. Canonical targets and actual symlink
edges remain dependency identities. Before apply, the parent validates the exact
consumed source/resource authorization; watcher notifications never trigger
compilation or stand in for an immutable snapshot. Special files are rejected
before bounded nonblocking regular-file reads, so FIFOs cannot stall capture.

Source navigation resolves canonical editable file IDs or authorized readonly
documents, never basename guesses or new grants. Reads, snapshots and archive
imports have explicit size budgets. Root-relative writes reject traversal and
symlink escapes. Saves report per-file captured-version outcomes; later typing
remains dirty. Linux no-replace creation and backup-preserving replacement retain
racing disk versions through interrupted-save recovery rather than silently
overwriting them. Clean external changes refresh without rebuilding; dirty
changes preserve base/local/disk conflicts for explicit resolution.

The child promotes candidates only on authoritative native applied receipts.
Revision admission and owned controls share a bounded ordered boundary; callback
guards remain final authority. Global Play/Pause/Stop/Panic can retarget a newly
accepted score in the same session, while score-bound seek/loop/audition reject
changed identities. Stop preserves an honest partial pause/rewind outcome.
Build, playback, Save, recovery and operation issues remain independent and retain
attempted action/request/full identity, exact callback tickets and known continuity.
Status sequence is a canonical decimal producer counter, independent of detail
sequence; delayed metadata/telemetry cannot rewind newer acknowledged status.

Transport, inspection and telemetry carry exact accepted identities. Hidden
detail is suspended without stopping audio or independent meters. WAV/MIDI exports
pin accepted source/resources independently of working edits and audition controls.
Accepted readonly source reopening uses immutable canonical text even after
original deletion. Changed/unpinnable resources and clipping fail explicitly.
Recovery/preferences remain separate from source/archive state. Close is vetoable
until save/discard/cancel, conflicts and active exports are resolved; child loss
leaves editor buffers available for explicit Restart engine.

## Trusted process boundary


The bundled `main` window is created in Rust. Navigation is limited to the local
Tauri origin, new windows are denied, and each of the seven IPC entry points
checks the calling window and origin. The main-window capability grants event
listening and page zoom for maintained Cmd/Ctrl +/- and wheel zoom shortcuts,
not filesystem or shell access. `host.openExternal` accepts explicit HTTP(S) URLs
only and invokes the system opener without a shell. Markdown, project source,
archive contents and plugin configuration are data, not webview permissions.
The native window's minimum inner size is 390×320; narrow Source/Music surfaces
therefore remain actual native windows rather than emulated browser viewports.

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
is not an OS filesystem sandbox: project read policy constrains host loaders and
resolvers, not arbitrary syscalls made by approved native plugin code. Account
read access to assets/configuration never approves an unknown executable.

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

Native gist/ZIP/content imports and untrusted recovery install a nonexecuting
preview. The parent stages data and settles the child prepare-preview barrier
before publication; neither evaluation/classification nor automatic compilation
runs before parent-owned **Trust and run**. Project/import flags and renderer
assertions cannot grant trust. Cancellation restores prior dirty/deleted buffers,
tabs/undo and consumed-dependency watches without rebuilding accepted music.
The retained score remains visibly read-only: global transport and immutable
accepted exports are available, but score/source-bound edits are disabled.
Approval retires prior authority before building the trusted preview; changing
same-project policy/upload metadata cannot unfreeze preview implicitly.
Trusted local reopening does not require per-build/per-asset approval.

Recovery retains at most twelve latest-project drafts within 512 MiB; source
captures are capped at 64 MiB, import/archive assets at 256 MiB, and
interrupted-save recovery records at 128.

Imported gist provenance is optional normalized `id[/revision]` metadata
(32–40 lowercase hexadecimal ID characters and an optional 40-character revision).
The parent retains it in workspace snapshots, recovery and recents, including
reopening a recent project. It does not enter `muzpad.json`, ZIP settings or
preferences and grants no additional filesystem authority.

Private formatter requests and results larger than a 2 MiB frame use sequential
256 KiB base64 chunks in both directions, retaining the full request context and
buffer version. Reassembly allows at most eight transfers and 64 MiB aggregate
encoded-document payload, with a two-minute inactivity lifetime; the public source
document limit remains 8 MiB. Executable plugin approval remains separate from
ordinary trusted source/asset reads.
First-save destination checks and asset copies include project-owned resources
only; authorized linked libraries remain links. Disk rescan validates all changed
source/settings inputs before publishing any authoritative buffer updates.
Omitted entry candidates and the equivalent explicit singleton entry are compared
semantically, so the first Untitled capture retains its requested source version
rather than creating a phantom settings edit. A real-child regression checks this
initial parent snapshot through entry checking.
Diagnostic mapping follows typed core error causes and preserves their structured
location, help and callers without parsing a formatted terminal message.

## Discovery, analysis and inspection

Entry discovery evaluates captured roots/imports into song/non-song/unresolved,
without lowering, resource pinning or audio preparation. Readiness is separate;
only prepare/apply validates accepted playback. Declared/selected missing and
non-song paths remain reasoned UI rows. Latest scans coalesce/cancel by captured
identity; cancellation/global budget failure is not an empty discovery result.

Native analysis consumes full contiguous 2048-sample mono `(L+R)/2` history.
The off-realtime worker reuses FFT plan/scratch and periodic Hann normalization
(coherent gain 0.5), producing 1025 linear peak-amplitude bins including DC/Nyquist.
DC/Nyquist use endpoint gain; positive interior bins use the doubled gain.
Peak/RMS are computed from that same selected unwindowed mono history in the
existing waveform pass; independently observed stereo/master meters cannot
replace those scalars.
Amplitude 1 is 0 dBFS. Capture/generation/source/revision transitions retire old
windows; warmup is not zero-padding. One pending input, one executing transform
and one replaceable output bound worker retention. Detail negotiates at most
30 Hz and meters independently at most 20 Hz; those ceilings are not measured
universal rates. Parent/adapters retain bounded latest-only telemetry separately
from reliable lifecycle/operation events. Exact exclusive window-end counters are
rendered sample-clock positions, not physical DAC presentation timestamps.

Complete graph/section/group catalogs use bounded continuations, including typed
too-large adaptation at the same offset. Visible note tiles stage coverage, rows,
geometry, labels, hit tests and full identity atomically. Previous-revision and
pending presentations are explicit; hidden note work is suspended while catalog
completion remains independent. Cache and host adapter bounds are documented in
[Workbench host adapters](desktop-adapters.md).

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
