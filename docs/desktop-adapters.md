# Workbench host adapters

The shared TypeScript boundary is `src/host/contracts.ts`. The native parent and
engine contracts are described in [Desktop host](desktop-host.md); reusable core
embedding APIs are documented in the core's `docs/embedding.md`.


The single public boundary is `src/host/contracts.ts`; bootstrap calls
`createWorkbenchHost()` from `src/host/index.ts`. Native bridge presence selects
the desktop adapter irrevocably: handshake errors are surfaced, never routed to
the browser engine. Identity fields remain opaque strings and native tick/
generation counters remain canonical decimal strings.

`InspectionClient(runtime, ref)` retains at most eight bounded pages and checks
the complete revision identity. `ProjectExporter(runtime)` receives only accepted
revision metadata and delegates render/publication/cancellation to the runtime;
neither UI seam handles playable snapshots, native paths or sample bytes.

The browser runtime privately owns compiler/render/export workers, captured
project source/asset pins, accepted/previous inspection revisions, the audio apply
boundary, transport acknowledgement and bounded status/analysis sampling.
Rebuild cancellation is checked before application; a cancellation arriving at
the apply boundary still returns the authoritative accepted outcome. Explicit
restart creates a fresh engine epoch and rebuilds the pinned accepted source,
without relabelling later working edits as accepted. Browser worker failures do
not silently start replacement engines.
Audio application through accepted-metadata publication is serialized with
transport, audition and analysis controls. Queued controls revalidate their
revision after acquiring that boundary, before mutating the audio engine.

Browser preferences use guarded `muzpad-preferences-v1` storage with an in-memory
session copy; legacy keys are removed only after the new record is written.
Denied or unavailable storage rejects each save as well as reporting the failure,
so the UI cannot clear its temporary-settings warning on an in-memory-only save.
Browser folder refresh/save conflict checks and recovery remain project-store
responsibilities. Native preferences/projects/exports instead use typed parent
commands, with bounded source uploads and immutable large-reply transfers.

The browser project store replays the resumed draft and Previous recovery offers
synchronously to new subscribers. Its internal runtime hooks authorize captured
sources immediately before audio apply, pin accepted/export sources independently,
and retire the old runtime only after a replacement is validated. A cancelled
chooser leaves both workspace and playback intact. A successful replacement
stops old playback before returning; it does not silently recover failed workers.
Folder saves report captured-version successes per file, so later edits remain
dirty. Refresh is manual, and browser filesystem APIs cannot provide an atomic
compare-and-swap against an external editor between the final check and write.
If a newer local edit races a clean disk refresh, recapture preserves its older
disk baseline and publishes a source conflict rather than rejecting recovery
forever or silently rebasing the edit. Recovery and working-copy archives remain
available; unresolved conflicts block affected saves and new builds until explicit
resolution. A bounded previous baseline supplies the common text when available.

Native bridge bootstrap registers its event listener first, then hydrates a
possibly transferred current project before replay. Native save context uses the
latest acknowledged working capture; callers persist their current recovery
capture before saving. Oversized bootstrap projects use the same immutable
transfer descriptor as other large replies, with a null-project bootstrap context.
Replacement close tokens consume permission without clearing the current desktop
identity; canceled choosers retain playback and source-snapshot handles. Protocol
v1 inline requests must fit both the encoded frame and the parent's 16 KiB
envelope reserve; payloads crossing either boundary use chunked uploads.

## Source navigation and retained captures

`ProjectStore.resolveSourceDocument({project, path}, operation)` returns a
canonical editable project-file identity, an authorized readonly document, or
null. It never widens read grants or guesses project files by basename.
Diagnostic, graph and note-explanation consumers use this same boundary.
External readonly documents retain host library identity for lossless close/reopen
without becoming editable project files or core catalog entries.

The desktop adapter retains at most four source captures as identity/version
metadata, not copied file arrays. Current/previous accepted pins and active
requests govern eviction; late replies cannot revive expired project captures.
Web builds retain asset ownership across preparing/queued/accepted phases without
redundant phase-transition decoding. Working recovery persistence warnings remain
separate from accepted build state and structured compiler diagnostics.

