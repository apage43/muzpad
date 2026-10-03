# Workbench host adapters

The shared TypeScript boundary is `src/host/contracts.ts`. The native parent and
engine contracts are described in [Desktop host](desktop-host.md); reusable core
embedding APIs are documented in the core's `docs/embedding.md`.


The single public boundary is `src/host/contracts.ts`; bootstrap calls
`createWorkbenchHost()` from `src/host/index.ts`. Native bridge presence selects
the desktop adapter irrevocably: handshake errors are surfaced, never routed to
the browser engine. Identity fields remain opaque strings and native tick/
generation counters remain canonical decimal strings.

`InspectionClient(runtime, ref)` checks the complete revision identity and uses an
LRU bounded to 128 pages, 24,000 rows and 8 MiB encoded bytes. Dispatch concurrency
is at most `min(4, hostOutstandingRequests-2)` (minimum one), with at most 64 queued
requests. Equivalent normalized ranges coalesce; cancellation/retirement prevents
obsolete replies entering the cache. Complete graph/section/group catalogs have
separate aggregate 32,768-row/16 MiB bounds. Only typed too-large page failures
halve row count at the same offset down to one; other failures are not retried.
`ArrangementInspection` stages complete visible rows and full coverage/geometry
before atomic presentation, retaining explicit previous/pending state meanwhile.
`ProjectExporter` receives accepted metadata plus an originating outcome reporter;
each job retains immutable revision/spec and its own terminal receipt even after
the dialog closes. Neither UI seam handles playable snapshots, native paths or
sample bytes.

The browser runtime privately owns compiler/render/export workers, captured
project source/asset pins, accepted/previous inspection revisions, the audio apply
boundary, transport acknowledgement and bounded status/analysis sampling.
Rebuild cancellation is checked before application; a cancellation arriving at
the apply boundary still returns the authoritative accepted outcome. Explicit
restart creates a fresh engine epoch and rebuilds the pinned accepted source,
without relabelling later working edits as accepted. Browser worker failures do
not silently start replacement engines.
Audio application through accepted-metadata publication is serialized with
transport, audition and analysis controls. Global transport intentions revalidate
at the acknowledged current score; score-bound controls remain pinned and reject
changed identities. Successful older receipts remain authoritative applied outcomes
without rewinding newer status. Status and detail use independent decimal producer
sequences, not arrival-order clocks.

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
null. It never widens read policy or guesses project files by basename.
Diagnostic, graph and note-explanation consumers use this same boundary.
Related-source availability comes from bounded direct `{ref,key}` lookup, not
membership in a displayed locations page. One latest intent begins before lookup
and guards every resolve/open/jump/Markdown continuation. Generated origins have
an explanation; working-text jumps after edits remain explicitly best effort.
External readonly documents retain canonical host identity for lossless
close/reopen without becoming editable project files or core catalog entries.

The desktop adapter retains at most four source captures as identity/version
metadata, not copied file arrays. Current/previous accepted pins and active
requests govern eviction; late replies cannot revive expired project captures.
Web builds retain asset ownership across preparing/queued/accepted phases without
redundant phase-transition decoding. Working recovery persistence warnings remain
separate from accepted build state and structured compiler diagnostics.


## Discovery, execution and observation

`EntryClassification` exposes song/non-song/unresolved independently from
unchecked/validated/blocked readiness. Discovery uses evaluate-only captured
roots/imports, not full compilation or native plugin/audio preparation. Missing
selected files cannot fall back to bundled modules or prevent alternatives.
Declared paths remain visible with reasons; latest captured scans coalesce and
cancel, including final-candidate cancellation. Native imported previews remain
inert until parent `trustAndRun`; browser imports keep browser sandbox authority.
Native preview preserves the previous full accepted identity/global controls and
immutable exports while disabling source/score-bound controls. Cancel restores
working/editor checkpoints without a rebuild; approval retires prior authority.

Detail and meters are independently negotiated at ceilings of 30/20 Hz.
Browser publication uses fractional deadlines without accumulated drift or
catch-up queues after stalls. Analysis consumes contiguous 2048-sample selected
mono windows and rejects old ref/source/generation/capture identity. Browser
Blackman coherent gain is 0.42, smoothing is zero at measurement, and exact
analyser window end remains null; native Hann gain is 0.5 and exclusive end
sample counters are exact decimals. Native includes Nyquist (1025 bins), browser
omits it (1024); frequency uses `k*sampleRate/2048`, not array length.
Detail peak/RMS come from the same unwindowed selected mono history, independently
of status/master meters. Matching browser worklet readiness loss publishes an
existing warmup marker immediately, with empty measurements and an unknown end
sample, so renderers retire old detail without inventing a complete zero window.
Visibility-aware dirty rAF draws at most once per refresh with display-only
delta-time smoothing; hidden detail disconnects without stopping playback/meters.

Native envelopes mark reliable project/engine/accepted lifecycle barriers.
Validated global sequence advances at ingress; reliable hydration stays ordered,
while two bounded latest status/detail slots proceed independently when no prior
barrier blocks them. Reliable failures cannot be lost behind newer telemetry.
Public project seconds are not an always-advancing physical sample clock.
