# Rust desktop host and project safety: remaining work

Own all `src-tauri/`, including Cargo/crate roots/protocol/config/capabilities,
parent services, engine child and Rust tests. No TS/UI/core edits. Consume the
frozen application DTOs in `local://desktop-frozen-contract.md` and core API in
`../muz-core/docs/native-runtime-plan.md`; reusable engine internals stay in core.

## Trusted parent and lifecycle

- Build Tauri 2 bundled UI with fixed `muzpad-engine` executable. Parent owns
  project/recovery/preferences/watch/dialog/grant state, not Compiled/audio.
  Spawn child with dedicated inherited length-framed protocol pipes insulated
  from arbitrary plugin stdout; bound stderr/log capture. No discoverable socket,
  shell text, arbitrary executable choice, broad filesystem/shell plugin permission,
  dev-server runtime dependency, or automatic native-to-WASM fallback.
- Bind the frozen Tauri commands/events to the trusted bundled origin/window only.
  Strict CSP, reject remote navigation/new privileged windows; HTTP(S) explicit OS
  opener only. Untrusted Markdown/project/import/config text cannot grant roots or
  host capability. Native plugins remain trusted process-privileged code.
- Handshake protocol/core identity/capabilities/limits before runtime requests.
  Supervise EOF/death/protocol mismatch, fail outstanding requests/exports, invalidate
  engine handles and report lost audio continuity without closing editor or saving
  buffers. Explicit restart allocates new epoch and rebuilds parent-held sources.
  Graceful shutdown drains runtime on owner thread, waits bounded exit then
  escalates/reaps; forced kill never deletes recovery. Focus existing singleton on
  second launch instead of opening identity-unsafe concurrent windows.
- Native close events are vetoable requests to the workbench. Only an approved
  save/discard decision after conflict/job resolution permits flush/preferences,
  job cancellation, watcher/IPC teardown and child shutdown. Failed save/conflict
  or cancel vetoes close; no sole reliance on webview lifecycle events.

## Parent project authority, snapshots and persistence

- Native choose-folder/export dialogs, bounded tree/source/library reads, stable
  app-data project IDs associated with canonical root/file identity, recent list,
  missing/moved-root diagnostics and authorized file-manager reveal. Same-name
  roots must not collide. New/imported directory/ZIP/gist projects may remain
  unsaved until destination selection; retain title/entry/entries metadata schema.
  Samples remain lazy native references, not browser upload objects.
- Separate authorized read roots (project, std/contrib/config/plugin installation,
  explicitly selected external libraries) from project and one-destination writes.
  Preserve native declaring-module-relative import/config/contrib semantics;
  show grant-required errors/explicit chooser rather than silently changing lookup.
  Resolve source identities consistently for overlay/disk/provenance/read-only views.
- Capture entry and all editable buffers, including closed/new/deleted files, at
  one sourceVersion. Pin clean imported disk source/version records into immutable
  host snapshots; check relevant dependency versions/disk generation before apply.
  Filesystem watch is a hint, not atomic snapshot evidence. Reject changing capture
  as source_conflict; unresolved relevant conflicts require explicit version choice.
  Never compile independently from a watcher or read current disk for dirty text.
- Implement secure root-relative paths: reject absolute writes, traversal, NUL,
  ambiguous separators/symlink escapes; use directory-relative/open-handle operations
  robust against path-component replacement. Create parent directories only within
  authorized root. Preflight all source/settings baselines; publish each captured
  file with same-directory restrictive temp, flush/fsync, mode preservation and
  directory sync where supported; report precise partial per-file success/failure.
  Advance baseline only for saved bufferVersion; concurrent typing remains dirty.
- New paths use atomic no-replace and expected-missing. Existing Linux targets use
  atomic exchange/backup-preserving replacement, validate displaced content against
  expected version, and preserve/surface any racing external version in recovery.
  Preflight+rename is not compare-and-swap. Journal interrupted saves/backups with
  actionable recovery and cleanup; errors/cancel leave prior targets intact or
  explicitly preserve both versions. Platform interface must not silently replace
  these guarantees with weaker macOS/Windows behavior.
- Watch source/settings and actually referenced external dependencies, coalescing
  bounded notifications rather than recursively watching sample installations.
  Clean changes refresh text and mark unbuilt, never rebuild; dirty changes retain
  base/local/disk versions. Cover new/deleted/renamed files, permission/root loss,
  unavailable/overflow watcher with visible degraded state and rescan. Match own
  saves by exact fingerprint, not time suppression. Conflict use-disk/keep-local/
  merged choices update acknowledged baseline but do not automatically save.
  Manual refresh preserves modified text, recovery, entry and accepted runtime.
- Durable atomic app-data recovery retains schema/time/project/root/sourceVersion/
  entry, dirty/new/deleted text, original fingerprints and needed base content;
  bounded retention, explicit storage errors, no sample library serialization.
  Offer restore: matching disk yields local buffers, newer/deleted disk yields
  conflict preserving both. Rejected builds do not invalidate drafts. Persist
  version-1 preferences in shell app-config separately, with atomic newest-wins
  behavior and nonfatal errors.
- Archive current working sources/settings/project-owned imported assets through
  safe native destination, not accepted audio state or recursive external library
  copies. Disclose linked resources. Validate import/archive paths and bound/chunk
  transfer; no arbitrary local path from UI becomes an output grant.

## Engine child and complete native operation parity

- Implement fixed protocol and `muzpad-engine` internal modes using direct muz-core
  APIs, fresh per-operation evaluator/HostContext/cancellation and authorized
  SourceLoader/resolvers. Child does not own recovery/watch/save/dialog policies.
  Keep current/previous Compiled plus bounded job pins; explicit expired handles.
  No ordinary Session JSON playable transfer or UI PCM playback IPC.
- Format exact supplied text and echo bufferVersion using core formatter. Check
  ordered candidate entries over one snapshot without audio/plugin construction;
  report progress and actionable per-entry failures, not missing resources as
  simply no syntactic entry. Selecting working entry must not alter accepted entry.
- Rebuild queues one preparing plus coalesced latest candidate. Compile with
  provenance, prepare initial bounded inspection and native transaction off callback,
  then submit against expected revision. Promote Compiled/assets only on authoritative
  applied receipt. Preserve prior audio/inspection/export on compile/prepare/apply
  rejection. Queue-full retains transaction ownership. Cancellation has per-request
  context; crossing submit reconciles applied/not-applied, never fabricates success.
  Distinguish predicted preparation effect from accepted change.
- Consume NativeRuntime for output/health, receipts/retirement, plugin main-thread
  servicing/restart stamps and prepared SFZ seek/loop replay. Preserve baseline
  metadata on accepted restart without recompiling/cloning the whole graph. Use
  core cancel_operation for submission-race outcome and PluginStamp application
  according to core plan. Do not duplicate LiveSession or raw-seek around SFZ.
- Implement acknowledged play/pause/stop/restart/seek/loop/panic with revision and
  transport generation guards, tail-complete status and actual negotiated backend/
  device/rate/period. Apply bounded exact physical audibility mask with mute over
  solo and 5 ms ramps, preserving/pruning policy through revision/seek replacement.
  Temporary listening never mutates source. Observe master/per-track meters and
  one nondestructive pre-bus target; callback uses preallocated storage, off-callback
  FFT/serialization, bounded latest-wins frames and visible drops. Stop hidden detail
  subscription without stopping audio; do not use destructive AudioEngine set_tap.
- Implement page_compiled for every view/filter, score/diagnostics/locations,
  explain_notes with ambiguity detection, all paged provenance diffs and source
  identities. Preserve core structured diagnostic location/help/callers; never
  scrape error text or silently truncate pages.
- Export pinned accepted Session/assets independently of edits and realtime service:
  master stereo 48 kHz PCM24 full duration+tail/written mix ignoring audition;
  custom selected tracks through buses/master at 44.1/48/96 kHz PCM16/24 using
  absolute start/end seconds (`start`, `seconds=end-start`, no section substitution);
  MIDI eligible tracks with performed notes/controllers/messages, conductor tempo/
  meter, source channels and sampled trigger notes. Show shared-effects caveat.
- Pin exact consumed accepted asset versions/bytes within explicit budgets, using
  native cache/snapshots, not whole libraries. If pinning fails or resource changed,
  error rather than silently rendering new bytes. Native plugin future bit identity
  is not promised. Use render_with/SMF or checked playable worker transfer with
  resolver/version correctness; if worker::bounce is used, implement this fixed
  executable's `render-worker` dispatch through worker::run. Render must not block
  plugin service; schedule <=2 workers/32 queued jobs. Parent grants staged output
  only and publishes on success. Cancellation/child death/clipping failure preserve
  previous destination; no large WAV transfer through JS. Native clipping is an
  error, not browser-style successful-warning substitution.

## Host test implementation and live docs

Add Rust tests for framing/limits/stale identity, private channel/log separation,
source capture/import versions, parent/child shutdown/crash, grants/path races,
no-clobber/concurrent replacement/partial saves/journal recovery, watch overflow/
conflicts and durable config/recovery failures. Use fixtures where necessary but
leave actual plugin/audio/packaged acceptance to integration; no mocks as evidence
of native runtime success. Skip builds/tests/formatters here. Update existing live
API documentation and provide README facts to UI owner; prune implemented tasks
in the same host commit, retaining unexercised acceptance in integration plan.
