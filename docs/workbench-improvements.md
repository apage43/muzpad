# Workbench improvements — pending implementation proposal

This document is an executable proposal, not implemented behavior or an achieved
performance claim. It covers the reported slow waveform/spectrum, arrangement
paging/flicker, related-source regression, confusing entry discovery, native
asset permission friction, folder naming, IDE layout, and the supplied error
screenshot. Existing user changes and all music in `muz-projects` are out of
implementation scope. Do not automatically rewrite music, metadata, plugin
configuration, or the user's environment to make an application issue disappear.

[Desktop host](desktop-host.md) and [host adapters](desktop-adapters.md) describe
LIVE behavior. This proposal intentionally differs from those documents where a
change is pending. Reusable engine work is owned exclusively by
[the core improvement plan](../../muz-core/docs/editor-host-improvements.md),
located at `../muz-core/docs/editor-host-improvements.md` from the repository
root. Do not duplicate its task list here. Repository-relative links below remain
usable without investigation sessions or private artifacts.

## Evidence and limits

The user's observations are accepted, not checks to rerun for confirmation.
Investigation used current source, existing production artifacts and isolated
synthetic diagnostics; those forms of evidence are distinguished below. No
feature implementation, new build, test suite, deployment or formatter was run
for this proposal. An existing binary reporting the pinned core SHA does not
prove that every workbench source edit is represented by that binary.

| Finding | Evidence and boundary |
| --- | --- |
| Slow analysis has an explicit cadence/window limit | **Isolated native measurement:** six seconds from an existing child using a muted synthetic one-track song at 48 kHz/256-frame PipeWire period: 60 analysis frames, 256 waveform samples and 1024 spectrum bins each; arrival p50 101.294 ms, p95 106.382 ms, mean 100.026 ms; approximately 287,560 encoded analysis bytes/s. No analysis/observation drops or render/stream/transaction faults; streamStartCount 1. Selected pre-audition signal was nonzero while audible master was silent. This is not full-webview or representative-project performance. |
| The nominal FFT2048 does not receive a continuous 2048-sample native window | **Source trace:** [core observation](../../muz-core/src/audio/observation.rs#L194-L342) copies only a due hardware block, zero-padded by [analysis worker](../src-tauri/src/engine/analysis.rs). At the observed period that is 5.333 ms of signal, not 42.667 ms. [UI](../src/main.ts#L1990-L2028) adds a 66-ms paint gate; native/web acquisition is capped at 10 Hz. FFT computation, JSON and UI drawing were not individually profiled; none is a measured dominant CPU bottleneck. |
| Source action is gated by the wrong truth set | **Isolated existing browser bundle/real WASM diagnostic:** a 51-track score produced 153 locations; initial request was constrained to native-equivalent 100 rows. Selected `track.t00` was absent and the button disabled; direct existing `location` lookup returned `song.muz:3:59`. Paging to the remaining 53 rows still left it disabled. This proves the page-dependent availability defect, not a native UI reproduction. See [selection gate](../src/main.ts#L1182-L1200), [direct lookup](../src/inspection.ts), [native locations](../src-tauri/src/engine/inspection.rs). |
| Arrangement presents uncovered/empty data | **Source trace:** [acceptance](../src/main.ts#L1119-L1154) installs empty note arrays before fetching; [navigation](../src/views.ts#L103-L159) moves/draws before coverage is ready; [refresh](../src/main.ts#L878-L969) replaces current coverage after a trailing 100-ms debounce. Request/draw right edges differ by 12 px, plus kit-marker overhang. **Isolated actual-module diagnostics:** two concurrent identical requests dispatched twice; a 12-track viewport dispatched all 12 again on a second cycle through the eight-page cache; moving one tick missed the exact-key cache. Pitch 60 moved about 20.67 px inside the same row when another page introduced pitch 84. These are scheduling/layout observations, not measured native frame durations. |
| Entry discovery conflates source kind and resource readiness | **Isolated native corpus scan:** 36 piece directories, 34 with source, 261 `.muz` candidates, 32 full compile/pin positives, 229 negatives (175 invalid_source, 40 missing_module, 14 grant_required); 20 source pieces had no positive. Of 175 invalid_source outcomes, 170 were ordinary non-song roots and five genuine build failures. Independently sampled evaluate-only roots yielded 31 songs, two evaluation failures and one null module. These sampling results do not classify all 261 roots. The native harness used lazy library capture and existing boot grants; it bypassed parent eager library enumeration and UI scheduling. Aggregate child scan time was 31.559 s, not end-to-end UI latency. [Current scan](../src/main.ts#L183-L216) discards all per-candidate failures; [native worker](../src-tauri/src/engine/mod.rs#L65-L111) compiles/pins every candidate. |
| The screenshot is an operation/status failure, not established source syntax failure | The supplied screenshot says **Needs attention**, **The accepted revision is still available**, **queued operation no longer matches the callback revision**. **Source trace:** [core outcome mapping](../../muz-core/src/native.rs#L739-L747) identifies callback stale-revision rejection; [coordinator](../src-tauri/src/engine/mod.rs#L339-L390) can admit old-runtime controls after revision submission, before receipt promotion. Plugin restart can change runtime revision without changing public accepted source ref. [Generic UI error](../src/main.ts#L477-L489) loses action context and overwrites build status. The exact clicked action, actual playback, saved/recovered edits and resulting build cannot be reconstructed from the screenshot; do not invent them. |
| Native read grants are not a plugin OS sandbox | **Source trace:** [loader](../src-tauri/src/engine/sources.rs) confines reads and [capture](../src-tauri/src/project/operations.rs#L127-L162) eagerly scans granted library source trees. **Isolated kernel diagnostic:** outside symlink and `../` reads failed with EXDEV under the loader's openat2 flags while ordinary account reads succeeded. This is not an application timing measurement or exploit. [Trusted boundary](desktop-host.md#trusted-process-boundary) already states native plugin code has OS privileges. |
| Layout needs restructuring, not just colors | **Isolated existing browser production UI:** at 1440×1000, header/transport/pane chrome occupied 141 px; default source width was about 568 px versus 666 px visualization. At 390×844, chrome occupied 363 px, source began at 616 px, full page reached 1868 px and diagnostics began around 1840 px. Important labels were 8–10 px and some targets about 20 px. These are actual bundle geometry, not native-window observations; [shell](../src/main.ts#L91-L119) and [styles](../src/style.css) ground the redesign. |

### Real project distinctions the application must expose

These observations are evidence, not a request to edit the pieces or promise that
an IDE change can make every piece compile. Native read-policy simplification
removes permission friction; it does not create missing files, install plugins,
license sample libraries, or legalize invalid language/graph use.

| Observed example, relative to `../muz-projects` | Required distinction |
| --- | --- |
| [the-order-beneath/orchestra.muz](../../muz-projects/boss-battles/the-order-beneath/orchestra.muz), selected by its `muzpad.json` | Definitions evaluate to null, not a song. Its [song.muz](../../muz-projects/boss-battles/the-order-beneath/song.muz) binds an 18-track song. Explain the configured selection; do not silently rewrite metadata or switch songs. The song's sfizz bundle links an external Roboto font; current library approval is incorrectly insufficient for a resource checked as plugin authority. |
| `borrowed-light/song.muz`, `what-the-evening-holds/song.muz` | Staged contrib lacks required drum/VSCO sample bytes. Installed contrib-root diagnostics made these songs compile/pin successfully. Bind a chosen installed library's source and assets to the same root; source-only redistribution remains legitimate but not playback-ready. |
| `the-way-still-open/song.muz`, `an-exit-made-of-rain/song.muz`, several `what-the-wind-keeps` candidates | Sibling-owned saved states exist outside the opened piece root. Distinguish account-readable linked resources from absent resources; do not auto-import or rewrite sibling music. |
| `the-quiet-between-suns/song.muz` | Existing Sonatina SFZ path was blocked by current authorized-root case lookup; ordinary native read policy must apply consistently to SFZ/include/case resolution. |
| `station-conversation/song.muz` | `sfizz` alias is unconfigured although evaluation returns a six-track song. Offer explicit plugin setup, not “not an entrypoint.” |
| `the-distance-that-answers/song.muz`, a `departure` revision | Piece-owned Sonatina states are actually missing. Report exact paths; do not pretend broad read access repairs absence. |
| `when-the-current-turns/song.muz` | Evaluates to a song but lowering rejects unknown note expression `variation`. Preserve the real language failure and structured attribution/help. |
| `pocket-customs/song.muz` and preview revisions | Missing imported `palette.muz` prevents evaluation: unresolved, not definitely non-song. |
| `machinehead-master-study/assets/tonematch.muz` and `assets/analysis/vocal-cells.muz` | Real graph budget failure (7453 units against 4096) and malformed expression respectively. Do not auto-raise budgets, suppress validation or rewrite music. |

## Ownership, sequence and invariant contract

One workbench integration owner owns the shared cutover in
[src/main.ts](../src/main.ts), [contracts](../src/host/contracts.ts), adapters and
native coordinator; implementation slices may have dedicated owners below but
must not introduce competing state/navigation/render schedulers in those files.
One core owner lands reusable changes in the linked core plan. An app integration
commit updates [the core pin](../src-tauri/core-revision), matching native child,
shell and WASM/resource artifacts together when a core change is consumed. Old
10-Hz validators cannot be mixed with new subscriptions. Deployment is not
implicitly authorized.

| Priority / owning slice | Dependencies / landing boundary |
| --- | --- |
| P0 operation scheduling + typed status | Shared receipt/outcome contract with core owner first; root race and user-facing action interpretation land coherently. |
| P0 navigation | Existing direct location/document APIs suffice; consume typed action status and coordinate native external identity migration. |
| P0 entry classification | Reusable core evaluation classifier; native import trust gate before external evaluation. UI must never advertise compile readiness from classification. |
| P0 native reads/trust | Parent-owned trust/dependency identity contract first; host/child/resolver/watch/recovery/UI migration together. No fake universal grant. |
| P0 small UX fixes | Folder labels, status discoverability, meaningful action names and essential keyboard targets may land independently; do not wait for P2. |
| P1 continuous analysis + delivery | Core window/rate contract, P0 apply owner, then worker/IPC/adapters/rAF; cadence selected after profiling. |
| P1 coherent viewport/cache/catalog | Presented-viewport/coverage contract first, complete metadata and scheduling together; conditional producer changes only if existing APIs/profile warrant them. |
| P2 source-primary IDE | Builds on P0 state/action contracts and P1 loading/visibility invariants; shell owner integrates design rather than masking runtime defects. |

Always preserve complete accepted identity (project, epoch, engineEpoch,
revision, sourceVersion, entry), canonical decimal native counters, authoritative
apply receipts, captured overlays including closed/new/deleted buffers, immutable
accepted resources, bounded work and reliable operation outcomes. Working text,
accepted audio, displayed inspection revision, selected entry, disk save and
recovery are distinct facts. Never label retained old content as newly accepted.
Native handshake failure never selects a browser fallback engine.

## P0 operation boundary and actionable status

**Owner:** native coordinator/shared-contract owner with core owner; UI status
owner consumes the same typed result. Primary files:
[coordinator](../src-tauri/src/engine/mod.rs), [protocol](../src-tauri/src/protocol.rs),
[desktop adapter](../src/host/desktop.ts), [web precedent](../src/host/web.ts#L319-L355),
[contracts](../src/host/contracts.ts), [shell](../src/main.ts).

1. Serialize revision prepare/policy capture → parent authorization → submission
   → callback apply → receipt consumption → accepted metadata publication with
   revision-bound controls, including plugin restart and automatic observation
   registration. Compile may remain concurrent outside this boundary. Consume the
   [core admission invariant](../../muz-core/docs/editor-host-improvements.md#p0-native-admission-and-receipt-integrity);
   retain final callback guards.
2. Keep bounded deferred explicit requests and latest desired analysis/audition
   state within existing operation budgets. Revalidate after the boundary. Never
   replay an obsolete absolute seek/loop/track mask on a changed score. Explicit
   Play/Pause/Stop/Panic must settle visibly exactly once, not disappear as a
   background replacement. Define deterministic pause/panic behavior during apply;
   disabling all controls throughout compilation is not a solution.
3. Treat Stop's pause→rewind as one owned compound transaction. Report an actual
   paused-but-not-rewound result honestly. For policy changes that invalidate an
   unsubmitted prepared revision, reprepare the retained compiled candidate against
   acknowledged policy and renew parent authorization as needed; do not call
   internal supersession user cancellation or recapture unrelated working edits.
4. Pair technical Failure with typed attempted action, request and identity,
   authoritative outcome and known continuity. Preserve stale vs session mismatch
   and cancelled vs superseded. Expected/actual runtime tickets, phase, raw cause,
   locations/help/callers and generation belong in expandable copyable details,
   not raw-message regex classification.
5. Replace last-writer generic `error()` state with independent operation issues,
   build, engine/playback, disk/working copy and acknowledged recovery state.
   Obsolete background failures cannot overwrite a newer accepted build or a
   current source/save issue. An explicit action that did not apply still needs
   acknowledgement. Healthy telemetry never clears unresolved disk/conflict issues.
6. Every failure says attempted action, observed outcome, what remains usable,
   known save/recovery state and the next safe existing action. For example,
   “Music updated, but the arrangement could not refresh” differs from “Rebuild
   did not apply”; “Previous build is loaded” differs from observed playing audio.
   Unknown outcome must remain unknown pending safe reconciliation. Engine loss
   offers explicit Restart engine; a healthy-engine transport failure does not.
   Source diagnostics retain a functional Open error action. No generic automatic
   retry/restart or suppressed exception substitutes for the root correction.

**Future acceptance:** deterministic isolated core/coordinator fixtures hold apply
before/after fades and receipt consumption; exercise value/structural rebuild,
plugin restart with same public ref, policy change, cancel-before/after-commit,
removed track, shortened timeline, concurrent transport/audition/analysis and
compound Stop. No wrong-revision mutation, exactly one outcome per operation,
correct accepted publication and latest acknowledged desired state. Extend
[desktop boundary tests](../tests/desktop-host.test.mjs) and browser apply tests.
Then exercise the actual native window and browser: late failed action cannot
replace newer Accepted; first/cancelled build does not invent a previous build;
engine loss does not claim playback or disk durability; save/recovery/build issues
coexist and retain actionable details at desktop/narrow widths. The screenshot's
exact trigger remains unknown until request/outcome evidence exists; use the
proved scheduling scenario, not a guessed click, as the root regression.

## P0 page-independent source navigation

**Owner:** one navigation owner across all existing callers, using
[InspectionClient](../src/inspection.ts), [jump/lookup](../src/main.ts#L842-L875),
[selection/provenance](../src/main.ts#L1182-L1287), [graph views](../src/views.ts),
and the existing canonical ProjectStore resolver. No primary core API change is
required for the page-gating defect.

- Model accepted targets as `{ref,key}` and diagnostic/contextual targets with
  their own project/source location context. Capture one navigation-intent token
  before the first location lookup and carry it through resolve/open/jump.
  Later file/tab selection, source navigation, selection, close, project/revision
  replacement or engine restart invalidates obsolete intents.
- Source availability is checking/available/unavailable from bounded direct
  lookup, never membership in the displayed locations page. Cache only optimizes.
  Missing note provenance retains known track fallback. Legitimately generated
  or master-bus origins explain unavailability instead of enabled-looking no-ops.
- Migrate inspector track/note, definition/latest-edit/occurrence/field links,
  routing device/bus, voice-patch device, primary diagnostic and graph keyboard
  actions together. Patch-node attribution remains enclosing-device precision.
  Paginated locations remain a separate bounded browsing surface.
- Preserve exact canonical editable IDs, readonly document identities on reopen,
  scalar-to-UTF16 coordinate conversion, project overlays and no basename guessing.
  Native trusted external resolution uses the read-policy identity below. Accepted
  source coordinates in current working text remain explicitly best effort after
  edits; do not mislabel the working buffer an accepted source snapshot.

**Future acceptance:** native >100 and byte-shrunk initial location pages, then
actual source button clicks without visiting Revision details; page-next/previous
cannot change action availability. Delayed/reordered lookup/explanation/document
responses cannot steal later file intent. Cover all callers, kit authored note
keys, missing provenance/master origin, Unicode/spaces, same-basename unknown
files, standard/contrib/readonly documents and dirty line drift. Extend
[inspection tests](../tests/inspection.test.mjs),
[workbench navigation](../tests/browser/workbench.spec.ts),
[kit navigation](../tests/browser/kits.spec.ts) and native resolver tests; verify
native and browser UI surfaces, not only the direct API diagnostic.

## P0 entry classification and discovery

**Owner:** entry integration owner across [contracts](../src/host/contracts.ts),
[scan UI](../src/main.ts#L183-L216), desktop/web adapters,
[parent snapshots](../src-tauri/src/project/operations.rs), native source worker
and [WASM commands](../wasm/src/lib.rs). Core owns
[root classification semantics](../../muz-core/docs/editor-host-improvements.md#p0-evaluated-root-classification).

- Replace `playable` discovery with orthogonal source kind **song / non-song /
  unresolved** and readiness **unchecked / validated / blocked with typed reason**.
  Only normal prepare/apply receipt certifies playable accepted music. Reuse core
  bound-main/import/evaluation semantics, not substring detection; no lowering,
  sample stamping, plugin-bundle pin/copy or audio execution during classification.
  Evaluation may itself need a dependency: failure is unresolved with reason.
- Keep declared and selected entries visible even if absent, non-song or blocked.
  Expose exact reason, readiness and selected-versus-playing entry. Known songs
  remain selectable when dependencies block compilation; unresolved declared
  candidates have an explicit diagnose/build action. Confirmed non-song must not
  look playable. A failed/cancelled/global scan is not “no entries.”
- Deterministic native/browser defaults: valid explicit selection is preserved,
  even when classification will explain it is non-song; absent explicit selection
  prefers root `song.muz`, then root `main.muz`, then lexical source path. Preserve
  declared order, selected candidate and lexical discovered song ordering. No
  opaque file-ID fallback and no silent switch away from explicit metadata.
  Missing/deleted selected entry must not prevent capturing/classifying alternatives.
- Single latest scan per project/source capture: preserve previous results marked
  stale during debounce, pass cancellation, coalesce obsolete queued jobs, release
  captures and reject wrong identity replies before publication. Publish typed
  progress/per-entry reasons without occupying builds with obsolete full scans.
  Cancellation is an outer operation outcome, including the final candidate;
  browser utility timeout is failed runtime/scan, not all candidates non-song.
- Align candidate/file-extension/filter budgets and closed/dirty/new/deleted
  overlay behavior. Installed contrib binding must pair module source and relative
  assets under the chosen root. Missing installation/setup has an explicit action,
  not permission prompts from background discovery or automated config changes.

**Future acceptance:** native/WASM synthetic direct/bound/imported/builder songs,
module/null/pattern/wrong-record, commented song text, syntax/missing import/cycle,
resource-blocked songs and genuine lowering/graph failures. Classifier performs no
plugin pinning/audio preparation. Explicit `orchestra.muz` is explained alongside
`song.muz` without metadata edits; known song identity survives sample/plugin
readiness failures; actual missing palette remains unresolved. Test queued/first/
middle/final cancellation, rapid typing and project switching, missing selected
entry and uppercase source parity. Then inspect authorized representative projects
in the actual native chooser and browser; retain all 31 sampled evaluate-only song
identities where evaluation still succeeds, with honest readiness, not a promise
that all projects play. Do not use or change personal pieces as committed fixtures.

## P0 native read policy and import trust

**Owner:** one native host owner across
[project authority](../src-tauri/src/project/mod.rs),
[IO](../src-tauri/src/project/io.rs),
[capture/save](../src-tauri/src/project/operations.rs),
[watching](../src-tauri/src/project/watch.rs),
[source/pinned assets](../src-tauri/src/engine/sources.rs),
[host dispatch](../src-tauri/src/host.rs) and adapter/UI contracts.

**Decision:** deliberately opened trusted local projects use the logged-in OS
account's ordinary read authority by default. No per-asset/library permission
picker, recurring grants or “connect” metaphor on desktop. Local creation/open
explains this authority. Imported gist/ZIP workspaces initially remain data
previews; one parent-owned **Trust and run** boundary precedes external evaluation,
automatic native build, classification that evaluates imports, and execution.
Preview/edit/archive inspection itself does not execute project code. Trust is
not accepted from project/archive/gist flags or renderer assertion; a fresh remote
import is a fresh trust decision, while reopening an already trusted local
workspace does not re-prompt per build. Preserve explicit native executable trust:
configured/installed trusted plugins work, arbitrary downloaded/bundled plugin
binaries need explicit install/enable approval rather than a sample-folder grant.
Approved native plugins have account privileges; loader policy is not a sandbox.

The clean cutover separates read policy from canonical resource identity:

- Demand-load only consumed external sources/assets, preserving stable bounded
  reads, canonical identity, aliases, hashes/versions, cancellation, parent
  preapply validation and watches of consumed files/parents. Never implement
  account authority by recursively granting `/`, HOME or every readable tree.
  Remove eager capture of unrelated granted-library `.muz` sources and obsolete
  trusted-library chooser/recovery-grant/error paths, not snapshot safety.
- Resolve normal external read symlinks canonically; detect link/target changes
  during capture and preserve alias identity. Never create writable project
  aliases or resurrect overlay-deleted project sources from disk. Readonly source
  navigation and reopen share dependency identity rather than generic file IPC.
- Preserve immutable accepted source/resource/plugin pins and digest verification.
  Original mutation/deletion after acceptance cannot change accepted export;
  newly demanded uncaptured frozen resources fail. Separate inert plugin bundle
  resources from executable installation approval (including external font links).
  Keep core custom-loader/resolver and saved-state restricted defaults; app supplies
  its explicit trusted/pinned resolver, not global core relaxation.
- Browser remains handle/import sandboxed with current path validation and native
  plugin rejection. Preserve project-relative/no-follow writes, racing-save and
  per-file conflicts, no-clobber export publication, ZIP traversal checks,
  linked-resource exclusion, budgets and explicit close/recovery gates.
- Preserve bundled-origin IPC, sanitization, no arbitrary webview navigation and
  explicit HTTP(S) external links. Markdown/source are data, not read capabilities.
  Broader trusted reads increase consequences of injected same-origin code;
  do not claim window/origin checks alone prevent that risk.

**Future acceptance:** trusted native absolute/relative WAV/SFZ/includes/modules/
states/config and external symlinks read without perasset prompts; absent vs OS
permission-denied vs plugin-install-required errors are distinct. A large sample/
home root never triggers recursive source enumeration. Test dependency/link
changes before apply and original deletion after accepted export, immutable pins,
uncaptured-resource failure, closed/dirty/deleted overlay authority, readonly
navigation, unchanged save/archive/write confinement. In actual native gist/ZIP
UI, no external evaluation happens before Trust and run; Cancel preserves current
workspace/playback, project metadata cannot self-trust and one trust enables normal
builds. Unknown native executables remain separately unapproved. Browser sandbox
and read/write/Markdown boundaries remain exercised. Missing real samples/config/
invalid music are reported, not “fixed” by fabricated assets or broader grants.

## P0 small user-facing wins

**Owner:** shell/capability owner; these do not await the P2 redesign.

- Exact visible and accessible native chooser label: **Open folder…**. Browser
  writable-handle action: **Connect folder…**. Browser disconnected-copy action:
  **Import folder copy…**, with “Edits are not written back; export ZIP to keep a
  portable copy.” Update capability application, handlers, shortcuts, tooltips
  and LIVE README together; changing only a native tooltip is insufficient.
- Distinguish **Return to start** from **Restart engine**. Keep Save, Rebuild,
  unsaved, unbuilt, playback and recovery semantics distinct. Surface the P0 action
  summary beside the affected workflow, with expandable technical detail and no
  modal that interrupts editing. Folder label/error improvements are correctness
  and discoverability, not cosmetic work deferred wholesale to P2.
- Provide named active-file/read-only editor, usable close/collapse/restore targets
  and view-tab roving semantics by reusing existing source-tab/focus patterns.

**Future acceptance:** native actual chooser and Ctrl/Cmd+O use Open folder…;
cancellation leaves music/workspace intact. Browser capable/noncapable folder
paths show exact labels and copy/write semantics. Keyboard reaches tab close,
pane restore, Settings and action/details without losing buffers. No obsolete
labels or misleading generic Restart survive the touched surface.

## P1 analysis correctness and delivery

**Owner:** analysis/native-delivery owner plus UI/adapters owner, coordinated by
the operation owner. Core owns the
[bounded contiguous capture/window contract](../../muz-core/docs/editor-host-improvements.md#p1-continuous-observation-window-contract);
app owns [FFT worker](../src-tauri/src/engine/analysis.rs),
[publication](../src-tauri/src/engine/mod.rs),
[protocol budgets](../src-tauri/src/protocol.rs), parent supervisor/host/transfers,
[desktop](../src/host/desktop.ts), [web](../src/host/web.ts),
[Web Audio](../src/audio.ts) and scope/status rendering.

1. Consume continuous selected-tap 2048-sample history with revision/source/
   generation reset, explicit warmup and window **end** sample position,
   sampleRate/count, increasing sequence and drop counters. Detail/meter retained
   clocks are independent. No concatenation of sparse snapshots or callback
   FFT/JSON/allocation/locking; accepted identity checks remain at every consumer.
2. Reuse off-realtime FFT plan/scratch, precomputed Hann/coherent gain and reusable
   compute buffers. Define interior/DC/Nyquist amplitude handling and mono stereo
   cancellation semantics. Map frequency by `k*sampleRate/N`; document/calibrate
   dBFS and web analyser window/smoothing differences. Nonfinite data is handled
   off realtime. One latest worker input/output, not catch-up queues.
3. Profile stage costs and freshness before choosing publication cadence. **Target
   candidate: 30 Hz on a measured 60-Hz display**, not achieved performance or a
   universal display guarantee. Negotiate rates and migrate core/native/protocol/
   HostLimits/desktop/Web declarations coherently. Visibility suspends history,
   FFT, publication and painting while independent audio/meters continue.
4. Maintain bounded latest-wins status/analysis through parent emission and adapter
   acceptance, not just after expensive arrivals. Reduce demonstrably redundant
   JSON/size passes only while preserving ingress limits/numeric validation.
   Isolate telemetry from large-event hydration with explicit ordered lifecycle/
   accepted-revision barriers; existing global sequence semantics need tests.
   Reliable build/project/engine outcomes must never be discarded as telemetry.
5. Incoming UI handlers store latest validated data only; visibility-aware rAF
   paints at most once per refresh without the fixed 66-ms gate. Cache geometry,
   DPR/theme and bin mapping; use delta-time smoothing explicitly as display
   smoothing, not new measurements. Batch clock/meter DOM writes and visible rows
   with the arrangement render owner. Do not change unrelated browser playback
   buffer credits to repair native visualization or send playback PCM over IPC.
6. Prefer bounded pixel-appropriate waveform/spectrum summaries and existing
   transport; compact/binary IPC or canvas workers require measured justification.
   No architectural change solely because FFT/JSON/canvas could be expensive.

**Future acceptance:** contiguous2048 at callback sizes128/256/512 and 44.1/48/96k,
known sine/DC/silence/near-Nyquist scaling, source/seek/rebuild reset and no stale
frame paint. Capture has zero allocations/deallocations or blocking under stalled
worker/UI; track stream starts/faults and callback cost. Prove capture/worker/
parent/adapter retention bounds and latest-only recovery under large transfers.
Measure calibrated window-end→paint (plus window-start/center age), ingress→paint,
received/painted sequences, p50/p95/max cadence, skips, encoded bytes/s, validation/
FFT/UI stage cost and refresh gaps on isolated baseline and authorized representative
native/browser interaction. Relative arrival-minus-capture progression is **not**
absolute age. Candidate period P must track delivery under measured callback/
coordinator/writer jitter, not stay at100ms; choose/refine budgets from profiles,
not invented speedup ratios. Show/hide/pause/resume paints fresh correctly warmed
windows. Actual native/webview rAF performance is required, not private-child data
alone; do not claim30Hz achieved merely because a capability says30.

## P1 coherent viewport and inspection

**Owner:** one arrangement integration owner across
[refresh scheduling](../src/main.ts#L878-L969), [inspection client](../src/inspection.ts),
[views](../src/views.ts), [layout](../src/arrangement-layout.ts) and pan; producer
changes coordinate with core/native owners only where needed.

- Separate desired from presented viewport. A prepared frame includes exact ref,
  time/track coverage, layout generation and representation. Stage required visible
  rows and coordinates together, then atomically commit. Do not draw unqueried
  lanes as known empty, discard other still-covered rows or shift an old bitmap
  under new labels/hit tests. Fix shared drawn/query range, sustained-note overlap
  and kit-marker overhang mathematics.
- Keep a coherent frame/covered data through same-revision navigation with bounded
  overscan. Beyond coverage, explicitly show pending/uncovered regions or retain
  prior coherent coordinates with pending intent. On new acceptance update audio
  authority immediately, but stage new visual data without first drawing empty
  arrays. Retained prior visuals are visibly the previous displayed revision and
  have identity-sensitive actions disabled until new commit. Retire fully on
  project/engine loss; never relabel old music as new.
- Canonical coverage-aligned range/LOD keys in the existing client; coalesce
  identical in-flight requests. Bound entries/rows/bytes and dispatch below host
  request capacity, prioritize visible rows, pin presented/in-flight coverage and
  evict irrelevant prefetch by actual LRU/coverage relevance. Replace arbitrary
  eight-page FIFO, not inspection output budgets. Latest-target scheduling and
  cancellation reject obsolete work/cache pollution; synchronous native scan
  cancellation is not magically made interruptible by AbortSignal alone.
- rAF-coalesce target/paint, fetch only changed coverage/LOD/track sets and make
  bounded progress during continuous drag rather than trailing-only debounce.
  Suspend hidden/inactive arrangement fetches. Follow prefetch uses measured
  request latency, retains one pending + one latest target and immediately serves
  the latest after completion. User pan/zoom/seek/follow-off invalidates old follow;
  internal scroll commits do not trigger redundant user-navigation fetches.
- Complete lightweight track/section/group catalogs through bounded existing page
  continuations and aggregate limits, without full note snapshots. Initial native
 100-row/byte-shrunk and browser1000-row graph pages cannot define the track
  universe; buses before tracks must not hide valid tracks. Catalog completeness
  is explicit; page replies cannot roll metadata back or replace global groups/
  sections with one browsing page. All tracks remain in arrangement/selectors.
- Separate structural row geometry/control identity from note tiles. Use stable
  accepted-revision pitch bounds if supplied, otherwise a deliberate fixed stable
  pitch-scale policy; never page-local min/max labeled stable. Keep selection,
  collapse/audition/focus/scroll as structure permits. Do not rebuild group note
  clones/controls per detail refresh. Cache row geometry and coalesce paints,
  retaining viewport-sized canvas/static layers and separate playhead/meters.
- Preserve melodic duration occupancy and make kit overview **onset density**
  consistent with detail; invented velocities from counts are not real aggregates.
  Use additive bounded producer metadata only if existing APIs cannot express
  this. Profile core scan/serialization and coordinator contention before any
  indexing/inspection-worker escalation; core owns
  [those conditional tasks](../../muz-core/docs/editor-host-improvements.md#conditional-inspection-indexes-and-stable-metadata).
  Long notes crossing range left edges must survive any future index. Increasing
  inspection limits or introducing an unbounded performance snapshot is forbidden.

**Future acceptance:** delayed/reordered/manual pan both axes, zoom by all controls,
fit/resize/center, long continuous drag, follow high tempo/deep zoom, seek/loop wrap,
follow disable/manual override and acceptance while pending. Every presented frame
is complete or explicitly pending, coordinates/hit testing/ref agree and returning
to nearby coverage reuses it. >8 tracks and large collapsed kits stay within
memory/concurrency budgets; duplicate requests dispatch once. Exercise graph with
many buses/track counts beyond first page, budget-shrunk page, reordered catalog
replies, stable pitch extremes, sustained/controller-only/sparse/empty/edge events,
kit/melody LOD, DPR and theme changes. Controls/selection remain stable on data-only
refresh. Extend [follow](../tests/browser/follow.spec.ts),
[audition](../tests/browser/audition.spec.ts),
[melodic shape](../tests/browser/melodic-shape.spec.ts),
[layout](../tests/browser/workbench-layout.spec.ts) and inspection tests. Measure
actual native/browser gaps, producer/transfer/layout/draw cost, dispatched/coalesced/
obsolete pages and peak retained bytes before accepting performance claims.

## P2 source-primary IDE redesign

**Owner:** shell/UI integration owner for [main](../src/main.ts),
[styles](../src/style.css), [editor](../src/editor.ts), preferences and affected
canvas/theme consumers. This is a coherent information-architecture/layout
redesign, not a palette patch or new framework. Root runtime fixes stay owned by
P0/P1 and cannot be hidden by animations or automatically concealed panels.

Proposed desktop structure (sizes are design candidates):

```text
Project: title + authority + unsaved state   Save   Export   View   Settings
Return to start  Play/Pause  Stop  clock/bar/tempo  section/loop  Rebuild
+----------------+------------------------------+-------------------------+
| Project files  | Source tabs             close| Music view tabs         |
| Libraries      | path / entry / Format        | zoom / Fit / Follow     |
| (read only)    |                              | arrangement/routing/etc |
|                | primary source editor        |                         |
| ~200–220 px    | ~60% remaining width         | ~40% remaining width    |
| collapsible    | resizable                    | progressive inspector   |
|                |                              | explicit analysis       |
+----------------+------------------------------+-------------------------+
Action summary / unsaved / unbuilt / playback   Problems + Technical details
```

- Compact ~44–48px project header and ~40–44px stable transport, not three action
  strips. Project menu organizes New/Open/Connect/Import/Recents/Reveal; Export
  distinguishes accepted Audio/MIDI from working Project ZIP; View/layout offers
  pane restore/Reset. Settings stays visible and Save direct when meaningful.
  Remove replaced duplicate controls rather than retain old/new UI paths.
- Source owns the default usable area. Respect existing saved splitter/layout;
  choose source-primary defaults only for new/reset layouts. Unified tab/header
  heights, path/read-only/entry context, persistent close target and contextual
  Use as entry. Project versus readonly Libraries remains explicit. Closing a
  view does not discard buffers; preserve undo/cursor/scroll/last-tab empty state.
- Concise arrangement toolbar, aligned track/audition controls and progressive
  selection inspector showing meaningful source target/unavailable reason.
  Detailed device/send/voice information appears when relevant. Analysis is a
  separate disclosure with stopped/loading/no-data/error states, not permanent
  meaningless empty scopes. Visibility uses P1 suspension, never stops music.
- Narrow mode becomes Source-first single active workspace with Explorer drawer
  and Source/Music surface switch, not a 1868px stack. Keep transport/Rebuild and
  compact action status reachable while editing. Inspector/analysis lives within
  Music; details open an in-viewport surface. Drawers restore focus; explicit
  source jump switches/focuses Source without losing music selection. Responsive
  auto-hiding does not overwrite desktop pane preferences. Intermediate/short
  layouts progressively collapse lower-value space rather than crush the editor.
- Shared 4/8/12/16 spacing scale, baseline alignment and restrained separators;
  normal UI ~13px, secondary≥11–12px, source13–14px. Candidate desktop targets
 28–32px, touch primary40–44px; close/mute/solo/collapse get real boxes. Stable
  transport numeral widths, visible focus, non-color selected/loop/error cues,
  distinct disabled/busy states and explanatory prerequisites.
- Preserve four themes, migrate affected semantic tokens/canvas/CodeMirror together
  without editor reconstruction. Contrast acceptance: normal text≥4.5:1,
  essential UI/focus/non-text graphics≥3:1. Respect reduced motion. Named source
  editor/read-only state, roving source/music tabs, meaningful regions/focus order,
  deduplicated polite operation announcements (not meters each frame), and task-
  based keyboard alternatives for meaningful canvas selection/seek/source actions.
  Preserve Settings trap/Escape/return and pane focus restoration; scope shortcuts
  out of modal inputs and retain browser-reserved keys.
- Nonmodal actionable status follows P0 independent channels. Expand technical
  data/locations/callers without stealing typing focus or hiding unresolved issues
  below all panes. No claim that saved/recovery/playing are interchangeable.

**Future acceptance:** actual native and browser at1440×1000/1280×800,
1024×768/800×600,390×844 and200% zoom/short height. Editing/entry choice/Rebuild/
Play/Stop/close/source jump/status are discoverable without traversing a long
stack; no body-wide horizontal overflow or clipped menu/dialog actions. All hidden
panes have keyboard restore, Reset gives documented default, current saved layouts
remain respected. Verify all themes/contrast, screen-reader editor/tab/status
names, keyboard/touch tasks, focus return and browser shortcuts. Theme/layout/
surface switches preserve tabs, undo, selection, pan/zoom, playback and buffers.
P1 pending/old-revision presentation remains truthful through the redesigned UI.

## Runtime verification and implementation commit protocol

Planning commits contain only each repository's own plan; no source/project
changes, generated artifacts or deployment. Future implementation must use the
normal repository commit rule: coherent owning changes in muzpad, engine changes
in muz-core, never unrelated user edits. Shared prerequisites land first; frontend
source, protocol, deployed binary and core pin cannot be partially cut over.

**Planning provenance gate:** the default [build configuration](../build.config.json)
uses the sibling core checkout. [Desktop build validation](../scripts/desktop.mjs#L45-L53)
requires its HEAD to equal `src-tauri/core-revision`, even when differences are
docs-only. The core proposal commit advances HEAD beyond the currently pinned
`9fedb16a042bfaa7501eabb5e8bedcc7ec7c0778`; by source inspection this gates the next
desktop resources/prepare/dev/build/package/release command before staging.
Existing binaries are unchanged, not rebuilt or requalified by planning. Resolve
planning provenance explicitly with the integration owner before those commands;
do not silently bump the pin and claim existing child/shell/catalog binaries match
it, or weaken the build guard. No build was run merely to confirm this condition.

Before **each future owning implementation commit**, the integration owner runs a
separate verification pass after all slices are integrated: relevant focused
unit/coordinator/adapter/browser suites, required build/format checks for touched
code, and the actual native-window/browser runtime acceptance for that slice.
A test or private-child probe alone does not qualify a claim about the UI, audio
continuity, folder chooser or frame cadence. Use temporary isolated fixtures/private
children and authorized readonly representative projects; never edit user music,
steal the native singleton or play unrequested audible synthetic material. Keep
runtime/environment/source-artifact identity with evidence; report exercised
scenarios and measured values, and distinguish unexercised gates explicitly.
Remove temporary instrumentation unless a maintained diagnostic mode is agreed.
This proposal does not authorize implementation or running those checks now.

On the same owning implementation commit:

1. Update LIVE [README](../README.md), [desktop host](desktop-host.md),
   [adapters](desktop-adapters.md) and affected core embedding documentation to the
   behavior actually implemented and runtime-qualified (host-specific labels,
   trust/import behavior, entries, cache bounds, rates/window and layout).
2. Remove the implemented pending scope, its acceptance text and now-obsolete
   rationale from the owning plan. Preserve only genuinely pending dependencies
   and uncertain gates; narrow references when part of a section lands. Core tasks
   are pruned only in the core plan, app tasks only here.
3. Do not leave completed checklists, “done” annotations or historical implementation
   logs in either plan. Remove a fulfilled section/document when no pending scope
   remains and repair incoming links. Permanent guarantees belong in LIVE docs;
   verification evidence belongs in the implementation handoff/commit record,
   not an accumulating roadmap history.

## Uncertain gates and explicit non-goals

- The screenshot's exact attempted action and final outcome need owned receipts;
  no retrospective assumption or generic harmless-stale message is acceptable.
- Final cadence, payload reduction/encoding, absolute latency budget and UI frame
  budgets require native/webview profiling and valid clock calibration.30Hz on60Hz
  is the candidate target, not measured improvement. No automatic OffscreenCanvas,
  binary IPC or new performance telemetry framework.
- Core inspection indexes/workers, revision pitch bounds, onset-summary DTOs and
  any extra catalog API are conditional on profiles or proven insufficiency of
  bounded existing APIs. Their reusable implementation scope is only in the core
  plan, not a duplicate workbench backlog.
- Broader trusted reads do not repair real missing libraries/states, unconfigured
  plugin aliases or invalid music. Preserve exact failures and explain setup.
  No sample/plugin redistribution without rights, automatic project rewrite,
  autoplay/retry/restart policy, OS plugin sandbox, new framework, command palette
  or expanded theme inventory is part of this proposal.
