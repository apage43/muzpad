# Desktop packaging and integrated acceptance: remaining work

Start only after shared UI, TS adapters, Rust host and required core runtime have
landed and the UI is integrated. Own package scripts/lockfile/catalog/build config,
release resources outside `src-tauri/` and smoke automation. Rust owner applies
Cargo/Tauri/resource changes; UI owner applies README updates. Do not deploy.

## Package and run boundaries

- Add reproducible Linux desktop development/build/package scripts while retaining
  independent static web build. Pin compatible host/core/protocol versions; build
  may use sibling core source, installed runtime may not. Bundle fixed engine,
  trusted UI/fonts/icons/catalog/docs and required contrib/resources; std stays
  embedded. Resolve packaged/native config resources without checkout absolute
  paths. External plugins/sample libraries stay user-owned and are not bundled
  without permission. Do not install system packages/services silently.
- Choose and document Linux glibc/WebKit/GTK/native-audio baseline and actual tested
  package format/distribution. Rolling-workstation build alone does not prove older
  distro support. No required tray (optional appindicator prerequisite absent).
  Preserve offline local project/docs startup and explicit network-only gist errors.
- Exercise package outside Vite/dev server/sibling checkout with paths containing
  spaces/Unicode, shell app-data/config paths, file reveal, second-launch singleton
  focus, clean shutdown and relaunch. Confirm only trusted bundled UI can invoke
  native commands and that unsafe navigation/link schemes/new windows are denied.
  Missing plugin/sample/audio/config/protocol dependencies must be actionable;
  no false native success or WASM fallback.

## Actual Linux runtime and project acceptance

Run the real Tauri application, not just Rust harnesses/browser mocks. Record exact
fixtures, supported installed plugin identities/formats and exercised operations:

- Open real folder with local sample/imports and installed native plugin; edit dirty
  entry plus dirty imported module (including a closed buffer), rebuild coherent
  unsaved snapshot, play native output, inspect provenance and verify disk unchanged.
  Reject syntax/missing module/sample/plugin/prepare/apply failures while previous
  session stays accepted. Exercise cancel before/after submit, superseded candidates,
  stale engine/project/revision messages and queue/resource limits.
- Play/resume/pause/end-tail, stop/restart/seek, section/range loops and SFZ replay;
  kit/group mute/solo with mute precedence and preserved policy after rebuild;
  independent track selection; master/track meters and selected/master waveform/
  spectrum with bounded traffic, hidden capture suspension and nondestructive audio.
  Exercise plugin restart requests and retire/shutdown behavior where fixture permits;
  report explicit fixture/coverage gaps, never generalize one plugin to all plugins.
- Every paged inspection view, arrangement overview/follow/filter/zoom, routing,
  patch/automation, score/diagnostics/locations, note explanation/jump and every diff
  category; source identity/Unicode location correctness and expired handle errors.
  Confirm continuation rather than silent first-page truncation.
- Master/custom WAV (selection/rates/depth/absolute range/tail), MIDI selection plus
  conductor/controllers/messages/channels, written mix independent of audition.
  Export after newer working edits and after disk asset changes: exact accepted
  resource or explicit changed-resource/limit error, never silent new bytes. Verify
  progress/cancel/dialog-close, clipping failure, bounded jobs and destination
  preservation on failure/crash. ZIP uses working text/project-owned assets/settings,
  excludes preferences, discloses linked libraries; gist/import behavior retained.
- New nested file/no-clobber and settings save; edits during pending save; permissions,
  simultaneous external replacements, interrupted/partial multi-file saves and
  recovery journal. External clean refresh/dirty conflict/use-disk/keep-local/merge,
  deletion/rename/root disappearance, watcher unavailable/overflow and rescan; no
  watcher rebuild or discarded version. Probe traversal/symlink/path replacement
  escapes and source snapshot external-write races.
- Stable recent IDs for same root and distinct same-name roots; missing/moved roots;
  draft restoration after newer/deleted disk, storage failure and inactive/closed
  edited buffers. Cancelled project replacement preserves state; project/window/
  application save/discard/cancel including conflicts and exports; failed save veto.
  Force child crash/hang/termination: editor/buffers survive, handles/jobs invalidate,
  explicit restart/rebuild creates new epoch, old messages cannot mutate current UI.
  Reap shutdown/forced termination; do not rely on webview unload.

## Shared UI and regression evidence

- Run existing `npm run build`, `npm test`, `npm run test:browser` with fresh
  production bundle and configured Chromium/Firefox/WebKit after all edits land.
  Include owner-added layout/appearance/adapter tests and existing engine,
  audio-player/render-worker/worklet/inspection/export/audition/assets/storage/gist/
  arrangement/catalog coverage. Run integrated Rust host checks and core-owner
  focused/full relevant checks once as directed by its pending plan; report exact
  commands and outcomes, not planned checks as passed.
- Repeat critical UI scenarios in actual Linux system WebKit: modified/inactive/
  library/last-tab close and lossless reopen, right-left neighbor and useful empty
  view while audio continues; keyboard navigation/focus and stale format protection;
  source/Markdown/history/scroll retention; pane hide/restore/all-hidden/wide/narrow/
  short-height layouts, ratio persistence/follow state, accessible settings.
- Check all four themes across CodeMirror/Markdown/graph/canvas/meter/dialog/analysis
  with computed contrast matrix and screenshots; verify theme switches do not rebuild
  or reset views. Native config relaunch and browser legacy migration retain exact
  theme/layout choices; denied/malformed/rapid preference writes remain usable and
  report temporary settings. Preferences must stay out of source/archive dirty state.
- Measure actual packaged cold/warm startup, process-tree RSS, distribution size,
  negotiated audio rate/period and rebuild-to-apply timings; distinguish period
  duration from unmeasured hardware roundtrip latency. Record plugin-specific
  runtime/export coverage and missing evidence honestly, without universal safety,
  latency, compatibility or resource-superiority claims.

Update live packaging/usage/verification docs through their owners with observed
facts and requirements. Prune fulfilled acceptance from this plan only after it is
exercised; remove exhausted plans/index rows. Work report holds measurement/test
results and remaining blockers, not permanent completed-plan history.
