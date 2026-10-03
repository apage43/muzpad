# muzpad

A local music workbench for [muz](../muz-core), with a static browser application
and a Linux-first Tauri 2 desktop application sharing the same editor and
inspection interface. The browser uses WebAssembly and Web Audio; desktop owns a
native muz-core engine child and never silently falls back to WASM. Write source,
rebuild, and inspect performed music while it plays. Settings offers Light, Dark,
Soft light, and Soft dark palettes. Interface text uses proportional fonts;
monospace is confined to source code.

## Run locally

Requires current Node.js/npm, Rust, and the sibling muz-core checkout with its
portable embedding interfaces. No desktop audio service is needed in the browser.

```sh
rustup target add wasm32-unknown-unknown
npm ci
npm run prepare:engine
npm run dev
```

Open the URL printed by Vite. Start with the new project, use **Import from gist**
to load source from GitHub, or choose a Gists sidebar link when configured.
Browser imports compile locally on opening; press Play to enable browser audio.
Deliberately opened native folders use your account's ordinary read authority.
Native gist/ZIP imports and untrusted recovery are nonexecuting previews until a
parent-owned **Trust and run** confirmation. Cancel preserves the previous
workspace and accepted music; imported metadata cannot grant trust.
Rebuild, or Cmd/Ctrl+Enter in the editor, accepts a new source revision. Invalid
edits retain the previous accepted session. Compatible edits retain the rendering
engine, held voices and matching processor state; structural changes use the
engine's reconciliation decisions and cutover fades.

## Workspace

- Browse project files and gist links, with muz-core's README, std, contrib, docs, and examples
  together under one section. Markdown opens as formatted documentation, with
  relative links to included documents and source files opening in the workbench.
- Open a local folder or project ZIP. Relative imports stay relative to their
  declaring module. Muz source, Markdown documentation, muzpad metadata, and
  project-relative MIDI, WAV, and FLAC assets are imported. In browsers, text and
  binary assets remain separate in storage; limits are 500 source files, 4 MB of
  text, and 256 binary assets of at most 16 MB each and 64 MB total.
  Native imports allow up to 8,192 tree/archive entries and 256 MiB of imported
  assets; native source documents and captured source sets are bounded to 8 MiB
  and 64 MiB respectively. Connected-folder assets remain authorized descriptors.
- The header distinguishes **Folder connected** from **Browser copy** or **Native
  working copy**, shows the folder's unsaved-file count, and groups current-workspace
  actions separately from opening other projects. Gist copies explicitly say that edits stay local.
- Native **Open folder…** opens a local project. Browser **Connect folder…**
  authorizes a writable directory; **Import folder copy…** imports a disconnected
  copy whose edits are not written back (export ZIP to retain them).
  **Save to folder** (Cmd/Ctrl+S) writes changed buffers and entry metadata,
  including new nested source files. Unsaved-to-disk and edited-since-build are
  separate states.
  Saves check disk baselines before writing; a failed save never grants close.
- **Reload** checks the connected folder, including added/deleted files. Clean
  changes refresh their buffers; overlapping local/disk changes offer **Use disk**,
  **Keep local**, or editable merged text. These choices change buffers without an
  implicit disk write. Completing manual Reload's conflict choices rebuilds the
  refreshed buffers; choosing **Later** leaves the accepted revision available.
  The accepted revision keeps playing during refresh/rebuild. Read failures keep
  the workspace. Browser folder grants last only for the tab session; recovered
  browser copies are disconnected.
  Native folder status distinguishes missing roots and degraded watches from ready
  access; working buffers remain available, and restored watch readiness clears
  the folder warning without hiding unrelated engine diagnostics.
- Project replacement and desktop window close use a save/discard/cancel gate.
  Conflicts and active export jobs can veto closure. Native recovery offers are
  explicit; Recent projects and Reveal project use the host's authorized roots.
  Browser draft/Previous workspace recovery remains available through the same
  project interface. A gist URL is fetched afresh on startup, with cached local
  changes offered as Previous rather than replacing the requested remote source.
  The chosen recovery copy stays intact while the current project's safety gate
  runs. Clearing browser site data removes its recovery.
  If browser storage denies a recovery write, **Recovery unavailable** stays visible
  separately from build status and compiler diagnostics; export a ZIP to keep edits.
  Project replacements execute in order, including confirmed recovery requests
  made while a prior replacement is rebuilding.
- Edit multiple source files, format them, add files, and choose the compilation
  entry. Bundled libraries are read only. Closing a tab closes its view, not its
  buffer: modified closed files remain in rebuilds, saves, recovery, and archives.
  New relative source paths may contain Unicode and spaces; traversal, absolute
  paths, backslashes, NUL and reserved `.muzpad-` components remain rejected.
  Active-tab closure selects its right neighbor, otherwise its left; inactive
  closure does not switch source. Last-close shows **No file open**, with **Open
  entrypoint** and **Show explorer**, while transport and Rebuild remain usable.
- Tab Arrow Left/Right and Home/End activate neighboring/end tabs; Delete closes
  the focused tab. Close buttons have full-path names and support Enter/Space.
  Desktop Cmd/Ctrl+W closes the active tab, not the window; browsers retain their
  own Cmd/Ctrl+W behavior. Desktop Cmd/Ctrl+O opens a folder; Cmd/Ctrl+, opens Settings.
  Desktop Cmd/Ctrl+N creates a project through the same safety gate; Cmd/Ctrl+Enter
  rebuilds outside dialogs.
- Project, Export and View menus close after a command is activated. Focus returns
  to their visible summary unless the command already focused its dialog or pane.
- Desktop Cmd/Ctrl+Plus or Minus and Cmd/Ctrl+mouse wheel change actual page zoom,
  independently of the arrangement's musical zoom.
- Editor undo/redo, selections, scroll and folds, and Markdown scroll/details are
  retained while closing/reopening views in a live project. Indented multiline
  source folds use the gutter or Ctrl+Shift+[ / Ctrl+Shift+] (Cmd+Alt on macOS).
  Explicit source/fragment links take precedence. This does not promise cross-launch
  undo, cursor or tab-history persistence; recovery stores canonical buffers,
  not serialized editor history.
- Desktop **View** commands restore collapsed Explorer, Source, Music or Inspector;
  Settings exposes the same choices. Hidden views retain navigation, zoom,
  selection, audition, loop and follow preferences. Narrow layouts use one
  Source/Music surface and a temporary Explorer drawer, without overwriting saved
  desktop visibility. Inspector and analysis scroll within Music, including short
  windows. Drag or keyboard-resize the source separator (arrows, Home/End); its
  preferred 25–70% fraction persists.
- **Settings** applies theme and pane choices immediately. New/reset layouts give
  source 60% of the area remaining after Explorer and keep optional Inspector
  closed; genuine saved layouts remain unchanged. **Reset layout** preserves music
  and theme. Preferences
  live separately from projects/ZIPs/gists/recovery text, in guarded browser storage
  or native app configuration. **Preferences are temporary** reports storage failure
  without blocking editing or masking engine diagnostics. Keyboard focus stays
  within Settings until it closes. Escape returns focus to its invoker or a safe
  global control; a queued close event never takes focus back from a newly chosen control.
- The Entrypoints chooser separates evaluated **song**, **non-song**, and
  **unresolved** source kind from unchecked, validated or blocked build readiness.
  Discovery evaluates roots/imports but does not lower, pin plugins/samples or
  prepare audio. Declared/selected missing or non-song entries remain visible with
  reasons alongside alternatives; a cancelled scan is not “no entries.”
  Changing entrypoint does not rebuild automatically. Selected and accepted
  entries remain distinct until Rebuild accepts the change.
- Play/pause, Stop, **Return to start**, seek on the ruler or by section, and loop
  a section or explicit beat range. Range values use zero-based musical beats.
  **Panic** releases sounding voices through the acknowledged transport operation.
  Build, playback, Save, recovery and other operation outcomes have independent,
  actionable status; healthy playback cannot clear a failed Save. Technical
  details retain exact native tickets and request identities. Stop can report
  paused-but-not-rewound partial success rather than claiming full success.
- Use **M** and **S** beside arrangement tracks to mute or solo temporarily.
  Multiple solos combine; mute takes precedence. Kit-group buttons act on their
  explicit lanes (a dashed button means some lanes are enabled). Controls survive
  rebuilds for unchanged track IDs and reset when opening another project; they
  do not edit source or ZIP exports. Output and all sends are gated with a short
  fade; existing shared-effect tails decay naturally. Analysis and sidechain
  detectors keep running. Changes follow queued audio (up to about half a second),
  without seeking or restarting playback.
- Inspect arrangement notes, note performance data, routing, native voice graphs,
  automation curves, master/track peak meters, and output waveform/spectrum.
  Accepted **Revision details** remain accessible after project replacement or
  Rebuild; the first accepted revision explains that no comparison exists yet.
  Automation values/cursors update only against the exact revision and lane model
  that produced their visible curve; Rebuild stages new data independently.
- Select a track to analyze its output, or choose Master in the analysis menu.
  The analysis signal is separate from the audible mix. Detailed peak/RMS describe
  the same selected unwindowed mono history, not master meters. Losing matching
  worklet readiness immediately returns the display to fresh-window loading rather
  than repainting an old measurement. Hiding Inspector does not hide analysis;
  hiding Visualization suspends detailed capture/drawing. Contrib folders show
  sample/plugin requirements. Browser hosts cannot run native plugins; native
  hosts report supported formats and use installed authorized resources.
- Click a diagnostic or the related-source action to navigate to a declaration.
  Availability uses direct accepted-source lookup independently of displayed
  location pages; later file/tab intent wins over delayed lookup/document replies.
  Generated material has an explanation instead of an enabled no-op. Graph links
  refer to accepted music, and dirty working text can move those source lines.
  Native canonical source identities resolve to existing editable buffers or
  readonly pinned/account-readable documents, never basename guesses or writable
  external aliases. Readonly documents retain their identity on reopen.
- Import a gist URL or ID. The page URL gains `?gist=ID` so it can be shared;
  `?gist=ID/REVISION` pins a particular version. A gist workspace has a **View gist**
  link in place of the project download button. Edits remain local and are not
  published to GitHub or included in a shared URL. Opening a `?gist=` URL fetches
  GitHub source, even for the same gist or pinned revision. Replacement safety
  applies to edited buffers. Desktop HTTP(S) links open explicitly in the OS browser;
  Markdown does not grant filesystem access or navigate the privileged webview.
- **Export audio / MIDI** exports the accepted revision, with a reminder to rebuild
  when the editor has newer changes. **Download master WAV** bounces the full written
  mix and project effect tail to stereo 48 kHz / 24-bit PCM in one click. Temporary
  listening mute/solo controls do not affect exports.
- Custom WAV exports offer individual tracks or a selected mix, 44.1/48/96 kHz,
  16/24-bit PCM, and a range in seconds (including the project tail). Selected tracks
  run through buses and master effects; isolating tracks can change shared dynamics
  and sidechains. Rendering includes the lead-in before trimming to preserve effect
  history and sustained notes, and compensates engine latency. Browser WAV output
  is limited to 256 MB and reports clipping after download. Native exports enforce
  their advertised host budgets and reject clipping before publishing output.
- MIDI export produces a type-1 `.mid` file with one named track per selected
  musical track and a conductor track containing tempo and meter. Performed note
  timing, velocity, controllers and channel messages are retained at 960 PPQ;
  instruments, audio, and mix effects are not embedded. Original MIDI channels are
  preserved, so route tracks to separate instruments in your destination DAW.
  Sampled tracks export their trigger notes, not a transcription of the sample.
  Export runs separately from playback, reports progress, and can be cancelled.
- Download folder/ZIP/new projects as ZIPs, including their unchanged binary
  assets. In browsers, asset-bearing drafts and Previous workspace use IndexedDB
  with a small localStorage marker; text-only drafts retain the legacy localStorage
  format. Clearing browser site data removes browser drafts. Native recovery is
  owned by the parent application in its app-data directory, not browser storage.
  Previous workspace offers restoration of the preceding project.
  Gist links are source-only and cannot carry asset dependencies; use
  a project ZIP for a piece that depends on binary assets.

Visualizations are read only. Selecting notes or graph objects does not edit the
music. Scope and spectrum show actual selected output; note marks show compiled
performance, not measured audio. Analysis uses mono `(L+R)/2`, so antiphase stereo
can cancel; track analysis and meters measure output before routing to buses.
Detail uses a full contiguous 2048-sample window, with source/revision/generation
resets and warmup. Native spectra use periodic Hann coherent gain 0.5 and include
DC/Nyquist; browser spectra use periodic Blackman gain 0.42 and omit Nyquist.
Linear peak amplitude 1 is 0 dBFS; frequency is `bin*sampleRate/2048`.
Acquisition negotiates at most 30 Hz detail and independently at most 20 Hz meters,
not a universal achieved-rate guarantee. Hidden detail disconnects/suspends
capture and drawing without stopping audio/meters. Native exclusive window-end
sample counters are rendered sample clocks, not DAC timestamps; Web Audio does
not expose the exact analyser window end. Paused meters clear; no synthetic
waveform or silent-clock fallback stands in for unavailable audio.

Kit tracks appear as collapsible groups with compact named voice lanes. At close
zoom, diamonds mark performed hit onsets; size and shade show attack velocity.
At wide zoom and in collapsed groups, bars show **onset density**, not invented
average velocity. Pitched tracks retain duration occupancy at every zoom: exact
notes when detail fits and bounded pitch/time occupancy for dense ranges. The
fixed MIDI 0–127 pitch scale does not shift when another page introduces a note.
Zooming into an overview restores individual notes.
Lane meters, hit inspection, analysis selection, and source navigation use the
physical voice tracks. Group membership comes from the engine's authored metadata,
so custom names work and unrelated dotted track IDs stay independent.

Drag to pan the arrangement or either graph. In the arrangement, Ctrl/Cmd + wheel
zooms around the pointer, and Shift + wheel pans horizontally. The slider and
plus/minus buttons zoom up to 512×; Fit shows the full project, and Center playhead
returns to the transport position. Follow keeps the playhead visible during
playback, loading each next note page before revealing it so notes and viewport
move in one paint. Manual horizontal scrolling or dragging turns Follow off and
cancels pending follow moves. With the arrangement focused, Left/Right pan,
+/− zoom, and Home fits the project.
The scrollable surface expands before a zoom-in applies its anchor, so native
scroll clamping cannot silently discard that position.

## Build and static hosting

```sh
npm run build
npm run preview
```

Upload the contents of `dist/` to an HTTPS static host. Relative asset paths support
subdirectory deployment; no application server, accounts, cloud saves, service
worker, cross-origin-isolation headers, or SharedArrayBuffer is required. The
server must serve JavaScript, WASM, JSON and other files with their usual MIME
types. Localhost is also a secure context for development.

`build.config.json` selects optional sidebar gist links and the muz-core checkout.
Only the core README and std/contrib/docs/examples are bundled; project contents are fetched on demand from
GitHub. No muz-projects checkout is needed to build muzpad. Each `gists` item has
`gist` (ID or URL), `title`, and optional `description`; use an empty list for no
suggestions. Set `MUZPAD_BUILD_CONFIG` for another configuration file (paths are
relative to that file). `npm run prepare:catalog` refreshes the library and links.
The configured core path must match the WASM crate's Cargo dependency.

Gists are read anonymously, including secret gists when their link is known.
**Secret means unlisted, not access-controlled**; links included in the sidebar are
visible to site visitors. Loading requires GitHub access and is subject to its
anonymous API rate limits. Without a `?gist=` URL, local drafts recover without
refetching. A failed gist request shows an error instead of opening a cached copy.
No GitHub token is stored in the application.

Gists support `.muz` and `.md` files, plus optional `muzpad.json` with `title`,
`entry`, `entries`, and `paths`. Because gist filenames cannot contain folders,
`paths` maps flat gist filenames to project-relative paths, for example
`{"paths":{"voice.muz":"parts/voice.muz"},"entry":"song.muz"}`. Files import into
an editable local workspace; Markdown is rendered with the same HTML sanitization
as local documents. Without metadata, entry selection prefers root `song.muz`,
then root `main.muz`, then lexical source path. Evaluation discovers source kind
without silently changing explicit metadata or promising resource readiness.

To explicitly publish a local piece as a **secret** gist using your authenticated
GitHub CLI account:

```sh
npm run gist:create -- ../muz-projects/my-piece song.muz "My piece"
```

This command creates a new gist each time. It includes source and Markdown,
encodes nested filenames with a path manifest, and excludes hidden directories
and generated media. Projects containing MIDI/WAV/FLAC assets are rejected with
an explanation to use ZIP export instead. Builds and deployments never create gists.

The Cloudflare configuration serves `dist/` at `muzpad.plausiblyreliable.com`.
Deploy only when requested. After signing in with Wrangler:

```sh
npm run deploy                 # build and publish the site
npm run deploy -- --dry-run    # build locally without publishing
```

The muz-core sidebar shows bundled source files without an external GitHub link.
`dist/engine-build.json` records the engine commit, clean state, and WASM SHA-256.

## Native desktop

The native shell uses Tauri 2 and an owned `muzpad-engine` child. Only the bundled
webview can invoke native commands; remote navigation and new webview windows are
denied. File/dialog grants, dirty buffers, disk-conflict handling, recovery and
preferences live in the parent, not the audio child. Engine failure interrupts
audio but leaves buffers recoverable. **Restart engine** explicitly creates a new
engine epoch and rebuilds its retained source snapshot; stale runtime handles are
not reused. A compile becomes accepted only after the audio callback acknowledges
the prepared revision.
The webview retains at most four identity/version-only source captures, matching
the parent’s capture window; repeated entry scans do not retain historical file
arrays. Current/previous accepted captures and in-flight rebuild ownership remain
explicit, and expired captures cannot be reused.

CLAP and VST3 plugins are trusted native code with engine-process privileges,
not individually sandboxed plugins. A plugin crash/hang can terminate the whole
child. The child is not an OS filesystem sandbox: trusted project read policy
constrains host loaders/resolvers, not arbitrary system calls by approved plugins.
Reading a sample or source does not approve a downloaded executable. Parent/child
separation contains ordinary engine crashes, not malicious native code.
Native exports pin the accepted revision and its resources, not newer
working edits or listening mute/solo controls. Missing, changed or unpinnable
resources fail explicitly. Plugin renders are not promised bit-identical across
future runs. Archives use working text/settings and project-owned assets; linked
libraries and plugin installations are not silently embedded.

Native development requires Rust/Cargo, C/C++ tools, Node/npm, the
`wasm32-unknown-unknown` target for shared frontend assets, GTK3/WebKitGTK 4.1
development libraries, and PipeWire/native-audio development libraries.
`npm ci` installs the locked Tauri CLI. Runtime needs GTK3/WebKitGTK 4.1, PipeWire,
and `xdg-utils` for external links. No tray/appindicator dependency or automatic
system-package installation is required.
**Reveal project** also requires the `gdbus` command and a session file manager
implementing `org.freedesktop.FileManager1`; missing, failed or hanging integration
returns an explicit error. Reveal does not open files through generic type associations.

```sh
npm run desktop:dev                      # debug engine, trusted production UI, shell
npm run desktop:build                    # release shell without installers
npm run desktop:package -- --bundles deb # local DEB installer
npm run desktop:package                  # configured DEB and AppImage installers
npm run desktop:release -- --bundles deb # local artifacts/provenance, never upload
```

Desktop development uses the bundled production frontend, not a Vite/Tauri HTTP
server. The independent static browser commands remain unchanged.
`desktop:prepare` stages the release child and library (`-- --debug` selects debug);
`desktop:resources` stages only the library/catalog. Desktop commands accept
`--target <Rust Linux triple>` and honor `CARGO_BUILD_TARGET`/`CARGO_TARGET_DIR`.
Native Cargo builds use their independent lockfile with `--locked`.

The configured core source must match both Cargo dependencies and the authoritative
pin in `src-tauri/core-revision`; do not substitute a different revision.
Native source/config must match the pin; noncompiled local `docs/` edits may remain.
Packaged library bytes come from the committed Git tree, never those local edits.
Optional `MUZPAD_CORE_REVISION` must match the pin, which both native executables
embed. Installed applications need neither a sibling checkout nor Node/npm or a
development server.

Default native output is under `src-tauri/target/{debug,release}`, with a target
triple subdirectory when explicitly selected; installers are in the profile's
`bundle/`. Local release artifacts are copied to `.artifacts/desktop/<triple>/`
(configurable), with checksums and provenance in `SHA256SUMS` and `release.json`.
Those files record inputs and artifacts, not an acceptance certificate.

Staging includes only tracked redistributable contrib source, JSON/config/docs,
core README/license, std documents and examples, retaining relative paths.
The standard library remains embedded. Downloaded sample libraries, plugin
binaries, licensed presets, untracked user files and caches are excluded.
Plugin configuration (`MUZ_PLUGIN_CONFIG`, or the core's XDG/HOME default) and
external resources remain user-owned. Trusted native projects demand-read consumed
account-accessible modules/assets, including canonical external links, without
per-library prompts or eager scans of unrelated trees. Bundled modules provide
offline fallback, not missing sample/plugin installations. Approved plugins retain
separate executable authority.

See [the native host implementation reference](docs/desktop-host.md) for resource
and safety boundaries. The production x86_64 DEB was independently extracted and
launched offline, with both source checkouts hidden and no development server.
Bundled README/std documents, native rebuild, save on safe quit, same-profile
relaunch and reopening the saved project worked. This is extracted-package
acceptance on the baseline below, not Debian apt/dpkg installation certification
or AppImage/older-distribution acceptance.

The tested native Linux baseline is x86_64 CachyOS rolling (Arch-like), glibc 2.44,
WebKitGTK 2.52.6, GTK 3.24.52, and PipeWire 1.6.9. Actual native output used
48 kHz stereo with a 256-frame period (about 5.33 ms per period); this is not
physical roundtrip latency or an audible-listening measurement. It does not
establish compatibility with older distributions or library versions.

On that baseline, the observed DEB was 10,643,306 bytes (about 10.15 MiB).
Launcher-to-ready-workbench frames took 2.368 s for a fresh profile and 2.762 s
for the same-profile relaunch; “cold” did not mean dropped OS caches. A changed-note
pointer Rebuild reached a distinct accepted-revision frame in 2.123 s, including
framebuffer/OCR sampling overhead: a workflow upper-bound observation, not pure
compiler/apply or acoustic latency. One separate idle launch using the existing
isolated profile (empty Untitled workbench, no playback/exports) measured the shell,
WebKit network/web processes and engine through sequential Linux `smaps_rollup`
reads: 707.96 MiB summed RSS, 338.31 MiB proportional set size (PSS), and
258.76 MiB private memory (`Private_Clean + Private_Dirty + Private_Hugetlb`).
PSS apportions shared pages; summed RSS counts them separately in each process.
The earlier fresh-profile RSS sample was 738.6 MiB, from a different launch.
These are measured baseline samples, not a memory-light claim or performance
guarantee.

## Runtime

In the browser host, compiler and rendering workers instantiate the same WASM library.
Compilation returns a revision summary and a checked playable snapshot. Detailed
graph, arrangement, patch, automation, diagnostic, source-location, provenance,
and revision-difference data is requested afterward in revision-checked pages of
at most 1,000 rows and 1 MiB. Complete lightweight graph/section/group catalogs
use bounded continuations independently of visible note tiles. The arrangement
stages coverage, rows, coordinates, labels and hit tests together; uncovered
targets are pending, and retained old visuals are explicitly previous revision.
Identity-sensitive actions stay disabled until presentation matches the desired
target. Its LRU cache is bounded to 128 entries, 24,000 rows and 8 MiB encoded
pages; structural catalogs have separate 32,768-row/16 MiB bounds. Dispatch stays
below host capacity (at most four), with at most 64 queued requests. Nearby covered
navigation reuses tiles; obsolete latest-target replies cannot replace them.
Patch and automation detail is loaded only when its view opens. Stale pages are
rejected rather than relabeled for a newer accepted revision.
Build phase notifications use captured source metadata without decoding assets
again; asset bytes are decoded at the actual compiler/audio transfer boundary.

A retained rendering worker prepares then applies candidates between render
blocks, checking request, base revision and transport generation. The compiler
marks a candidate accepted only after the apply acknowledgement; rejected or
discarded preparation retains the previous engine and inspectable revision.
Cancellation can wait for a synchronous WASM preparation to return, but cancelled
preparations cannot commit. Cancellation closes once apply is submitted, until
the accepted UI revision is published. Fatal worker failures are surfaced without
silently replacing the engine; explicit **Restart engine** starts a fresh engine
epoch and rebuilds the pinned accepted sources, not newer working edits.
Compiler requests have a 30-second timeout. Note inspection distinguishes its authored definition, latest
relevant edit, and occurrence context when provenance is available, and reports
fallback quality explicitly for imported assets.

The rendering worker fills a bounded queue of 1024-frame stereo PCM buffers. The
AudioWorklet drains them, returns buffers for reuse, and reports consumed positions
and corresponding track meters. Blocks retain revision identity: already queued
audio drains before the new revision becomes audible, independently of the
accepted UI revision. Structural fades use a credited boundary block, or queue
boundary ramps when the queue is full; applying never exceeds the credit budget.
Seek epochs discard obsolete queued audio. The
queue holds at most about half a second at 48 kHz; initial playback primes roughly
170 ms. Worker scheduling and host audio add latency. No real-time input is promised.

## Current limits

The desktop implementation targets Linux first; other native platforms and
packaging baselines require separate verification. Browser hosts cannot load
VST3/CLAP plugins. MIDI/WAV/FLAC project assets are portable; native linked sample
and plugin resources depend on the installed configuration and advertised
capabilities. There is no recording or note/automation/patch editing.
Browser structural preparation is synchronous on its rendering worker and can
exhaust queued audio. Expensive programs can exceed host memory/CPU budgets;
reported health and explicit errors are not a glitch-free playback guarantee.

The first timing check through the WASM bridge compiled Still Our Own in roughly
0.2 seconds, prepared it in 0.05 seconds, and rendered a 5.3-second chorus passage
in 1.2 seconds with about 79 MiB of WASM memory. These are measurements on the
development machine, not performance guarantees.

## Verification

```sh
npm test
npx playwright install chromium firefox webkit
npm run test:browser
```

Build first. Unit checks exercise actual WASM session transfer, diagnostics,
transport/tails, and the PCM worklet queue. Browser checks run the production
bundle under `/studio/` on an ordinary static server, using synthetic music for
editing, imports/exports, transport, source navigation, recovery, themes, nested
libraries and output analysis in Chromium, Firefox and WebKit. The mount test
uses real Chromium browser file handles with a substituted OS folder picker to
exercise writes, new nested files, and external-edit conflicts.
Shared UI coverage additionally exercises tab neighbor/last-close semantics,
closed-buffer export/recovery, editor/document retention, stale Format guards,
pane/focus/ARIA behavior, responsive and short-height geometry, splitter
persistence, four-theme computed contrast (including canvas token/background
pairs), denied preference storage, migration and newest-wins saves.
Native acceptance is separate and must exercise the actual Linux application,
native preferences relaunch, save/conflict/close/recovery, engine failure/restart,
analysis and export. Browser screenshots alone do not establish native acceptance.

The bounded closeout is desktop-focused, not exhaustive qualification of every
candidate-cancellation, supersession, global-retarget or dependency/alias
authorization interleaving. Small-screen and narrow-viewport qualification was
deliberately retired. The native content/remote-ingress matrix and successful
import of a live Gist containing `.muz` source were not exercised; scripted GitHub
fixtures do not establish those native paths. Existing timing/calibration results
retain their original build and fixture scopes; final smoke is not retiming.
These limits do not relax preview trust,
executable approval, accepted-resource pinning or stale-identity guards.

Native ZIP-preview qualification observed a persistent **Stale project event.**
operation diagnostic even though trust denial was enforced and Cancel restored
the exact accepted workspace/music. Its original notification was not identified in the
bounded closeout; a later global recovery notification was not established as its
cause. This remains a known status-diagnostic limit, not a claim of exhaustive
lifecycle-event ordering coverage.

Set `CHROMIUM_PATH` to use an existing Chromium executable. Engine embedding tests
live in muz-core and use small independent cases. Still Our Own is a manual
integration piece, not a frozen regression fixture.

## Changelog

### 2026-10-03 — workbench and core cutover

- Native candidate/control admission uses authoritative callback outcomes;
  independent build, playback, Save, recovery and operation status preserves
  typed rejected/partial/unknown outcomes and actionable diagnostics.
- Related-source lookup is page-independent and latest-intent guarded. Evaluated
  entry kind is separate from build readiness; explicit missing/non-song/non-source
  declarations remain visible instead of being rewritten or silently discarded.
- Deliberate native folder opens use ordinary account reads with confined writes
  and immutable accepted pins. Imports/untrusted recovery require parent Trust
  and run; retained global controls/export remain available, while score-bound
  mutations reject at parent and child admission. Executable approval is separate.
- Continuous full-window analysis, independent detail/meters, bounded latest-only
  delivery and visibility-aware drawing replace sparse capture/polling gates.
  Reported native sample clocks and browser analyser-clock limits remain explicit.
  Selected-window peak/RMS stay independent of master meters; browser readiness
  loss explicitly retires the previously displayed detail.
- Arrangement catalogs, coverage-aligned bounded caching and staged presentation
  keep labels/notes/hit tests coherent. Shrinking kit layouts clamp the viewport
  to row extents so sticky bitmaps cannot escape above the visible surface.
- Source-primary desktop defaults, four themes, single-surface narrow layouts,
  short-height pane scrolling, grouped commands and accessible live outcomes
  preserve editing/navigation state and genuine saved preferences.
- Activated grouped commands dismiss without stealing dialog/pane focus, including
  a Reload that disables itself while awaiting real folder reads. Accepted revision
  details remain visible, and automation values/cursors use the exact accepted
  models presented with their DOM rather than a newer structural catalog.
- Zoom updates the structural surface before applying its preserved scroll anchor.
  Indentation folding and retained visible scroll positions preserve real editor
  and arrangement state across source/library, theme and pane transitions.
- No speculative inspection indexes or pitch-metadata endpoint were added.
  Joint corrected-host and lock-matched producer profiling found no material core
  scan/overview/metadata blocker under unchanged budgets. The independent native
  producer's selected-page performance-plus-serialization p95 was 0.141 ms and
  largest selected overview p95 0.512 ms on the isolated 172-track/38,028-note
  fixture; these are not browser full-pipeline or universal frame-rate guarantees.
