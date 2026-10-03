# TypeScript host adapters: remaining work

Owner/file boundaries: [desktop-direction.md](desktop-direction.md). Exact DTOs,
command/event spellings and exports: `local://desktop-frozen-contract.md`. Implement
`src/host/{contracts,index,web,desktop}.ts`; do not edit shared main/style/editor/
theme/preferences/views/document/README. Deliver callable seams to that owner.

## Shared boundary and web cutover

- Declare WorkbenchHost/WorkbenchRuntime/ProjectStore/PreferencesStore once in
  contracts.ts. Explicitly choose trusted native bridge or web at bootstrap;
  native handshake failure reports native failure, never falls back to WASM.
  Expose actual capabilities/reasons, identities and negotiated limits, not a
  backend registry. Keep browser builds free of mandatory native dependencies.
- Move existing Compiler/AudioPlayer/worker/asset orchestration behind web.ts,
  including immutable all-buffer snapshots, entry checks, exact-source formatting,
  compile/prepare/apply/accept, cancellation and snapshot retention. No caller may
  continue the old prepare/accept_compilation choreography. Rebuild resolves only
  on real apply; prefetch bounded initial summary/graph/sections/track_groups/
  locations/diagnostics before mutation, preserve continuations and last accepted
  inspection/audio on failure. Human sourceVersion remains distinct from opaque
  engine revision; source entry changes do not relabel accepted playback.
- Adapt InspectionClient to typed runtime+RevisionRef with its eight-page bounded
  cache. Support all core views/filters, explanation key ambiguity, source locations
  and all diff categories with explicit comparison base; reject stale/expired
  identities. Retain current graph/performance projections and UTF-16 editor
  conversion; do not create a second inspector or materialize unlimited pages.
- Expose transport play/pause/stop/restart/seek/loop/panic through one contract:
  pause holds position, stop pauses and rewinds to loop-start/zero, restart preserves
  running state, play at end restarts, finite nonnegative beats, half-open loops,
  enabling seeks start, disabling retains position, invalidated shortened loops
  clear. Track acknowledged transport generation. Physical mute/solo resolves kit
  groups with mute precedence, no source rebuild; selection independent of audio.
- Bridge bounded master/per-track meters, nondestructive master/selected waveform/
  spectrum and health/status to shared events. Stop unused detailed capture while
  hidden, clear paused meters, retain current drawing semantics, observe drops.
  Browser PCM stays in existing browser engine/workers/worklet only.
- Refactor ProjectExporter around runtime.export and AcceptedRevision metadata;
  export the frozen constructor/set/open/close seam for UI. Keep current dialog,
  track selection, absolute seconds/rate/PCM depth, progress/cancel, master written
  mix and MIDI conductor/channel semantics. Web adapter owns snapshot/assets,
  worker/download and clipping warnings. Never expose snapshots in main/UI.

## Native adapter and project parity

- Transcribe the frozen typed Tauri commands/envelopes; correlate request IDs,
  project epoch, engine epoch, sourceVersion, accepted revision and transport
  generation before delivery. Bounded reliable outcomes differ from coalesced
  telemetry. AbortSignal sends request-scoped cancellation; applying is the commit
  boundary, so reconcile late abort with authoritative applied/not-applied response.
  Native calls never route through web compiler/audio/assets or text CLI.
- Chunk source/import/archive transfer without exceeding encoded frame ceilings;
  source capture includes every canonical edited/new/deleted/closed buffer, exact
  clean baselines and entry at one sourceVersion. Return parent immutable snapshot
  handle; no child disk substitution. Project native paths/grants remain opaque.
- Implement all ProjectStore operations: chooseFolder/openRecent/listRecent,
  newProject/importProject/readLibraryDocument, save/refresh/resolveConflict,
  snapshotSources/persistRecovery/restoreRecovery/exportArchive/reveal,
  prepareClose/close/subscribe. Preserve web folder/import/ZIP/gist/previous/draft
  semantics and asset storage compatibility; never copy native libraries into
  IndexedDB/base64. Archive current working project/settings/project-owned assets,
  excluding preferences and explicitly disclosing linked native resources.
- Apply native parent events for clean refresh/unbuilt state, dirty conflicts,
  deletion/rename/root/permission/watch failure, exact own-save fingerprints and
  stable recents/recovery identities. Save returns per-file captured-version
  successes/errors; edits typed while saving remain dirty, partial success is not
  all-or-nothing. Settings baseline is conflict checked too. Buffers survive view
  closure and engine crash. Library/authorized external source identity cannot
  alias a same-basename project path.
- Expose host engine restart only as explicit recovery with fresh epoch and
  parent-held snapshot; invalidate accepted/export/inspection handles after death.
  Listen to parent close handshake and preserve buffers until allowed teardown.
  Keep native URL opening HTTP(S)-only and project reveal identity-authorized.

## Preferences and focused tests

- Web PreferencesStore uses guarded `muzpad-preferences-v1`; only when no usable
  versioned record exists, migrate valid `muzpad-theme` and `muzpad-inspector`
  into defaults. Remove old keys only after successful new save; denied storage
  gives usable in-memory state plus actionable failure. UI owns normalization,
  serialized application and temporary-settings presentation; do not leave legacy
  independent theme/inspector storage paths. Native store delegates atomic config
  commands, not localStorage or project files.
- Add boundary tests for parity method coverage, stale project/engine/transport
  identities, abort-before/after-apply outcomes, queue/size limits, retained previous
  inspection, export pinned accepted revision, chunk framing and partial saves.
  Retain existing engine/audio-player/render-worker/worklet/inspection/export/
  audition/assets/project-storage/gist/arrangement/catalog tests. Add adapter
  tests without substituting them for real native acceptance. Do not run checks
  mid-flight; hand commands/scenarios to integration owner.
- Update affected existing code/API documentation and prune this plan in each
  implementation commit. Send README-visible usage changes to its UI owner.
