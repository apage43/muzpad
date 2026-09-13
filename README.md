# muzpad

A static, local music workbench for [muz](../muz-core). Write source, run it in
WebAssembly, and inspect the performed music while it plays. Black on white is
the default; the theme switch also updates the editor, arrangement, graphs, and
audio displays. Interface text uses proportional fonts; monospace is confined to
source code.

## Run locally

Requires current Node.js/npm, Rust, and the sibling muz-core checkout with its
portable embedding interfaces. No desktop audio service is needed in the browser.

```sh
rustup target add wasm32-unknown-unknown
npm ci
npm run prepare:engine
npm run dev
```

Open the URL printed by Vite. The initial build includes Still Our Own from the
sibling muz-projects checkout. It compiles locally on opening; press Play to
enable browser audio. Rebuild, or Cmd/Ctrl+Enter in the editor, accepts a new source
revision. Invalid edits retain the previous accepted session. A successful run
rebuilds audio at the current position; held voices and effect tails are not
preserved across revisions.

## Workspace

- Browse project files, bundled projects, and muz-core's std, contrib, and docs
  together under one section. Markdown opens as formatted documentation, with
  relative links to included documents and source files opening in the workbench.
- Open a local folder or project ZIP. Relative imports stay relative to their
  declaring module. Only muz source, Markdown documentation, and muzpad metadata
  are imported. Up to 500 files and 4 MB of text are supported.
- Mount a folder in browsers with the writable directory picker. **Save to
  folder** (Cmd/Ctrl+S) writes changed files and entry metadata back to that folder,
  including new nested source files. Saving checks for outside edits before
  writing; conflicts leave browser edits available for ZIP download. Mounts last
  for this tab session. After reloading, the recovered draft is a browser copy;
  mount the folder again to reconnect to disk. Folder import and ZIP download
  remain available in browsers without mounting support.
- Edit multiple source files, format them with muz's formatter, add files, and
  choose the compilation entry. Bundled libraries are read only.
- The Entry chooser lists only files the compiler validates as playable entry
  points, with declared entries first. Validation refreshes after source edits.
  Choosing one changes what the next Rebuild compiles.
- Play/pause, stop, restart, seek on the ruler or by section, and loop a section
  or an explicit beat range. Range values use zero-based musical beats.
- Inspect arrangement notes, note performance data, routing, native voice graphs,
  automation curves, master/track peak meters, and output waveform/spectrum.
- Select a track to analyze its output, or choose Master in the analysis menu.
  The analysis signal is separate from the audible mix. Collapse the inspector
  to give the arrangement more room. Contrib folders show sample and plugin
  requirements; these dependencies are browseable but unavailable in the browser.
- Click a diagnostic or the related-source action to navigate to a declaration.
  Source attribution is best effort for generated material. Graph links refer
  to the accepted revision; unsaved edits can move those source lines.
- Download your own project as a ZIP; bundled demos do not offer ZIP downloads. Local draft recovery is browser storage,
  not a replacement for downloads; clearing site data removes drafts. Previous
  workspace restores the preceding project when switching projects.

Visualizations are read only. Selecting notes or graph objects does not edit the
music. Scope and spectrum show actual selected output; note marks show compiled
performance, not measured audio. Analysis is mono downmixed by Web Audio; track
analysis and meters measure output before routing to buses. Switching analysis
briefly clears the display while queued audio drains, without restarting playback
or changing the audible mix.

Drag to pan the arrangement or either graph. In the arrangement, Ctrl/Cmd + wheel
zooms around the pointer, and Shift + wheel pans horizontally. The slider and
plus/minus buttons zoom up to 512×; Fit shows the full project, and Center playhead
returns to the transport position. Follow keeps the playhead visible during
playback; manual horizontal scrolling or dragging turns it off. With the
arrangement focused, Left/Right pan, +/− zoom, and Home fits the project.

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

`build.config.json` selects demo directories and their entry files. The build
reads source from those directories and bundles std/contrib/docs from muz-core. It
excludes hidden directories, asset folders, and generated media. Music remains
in muz-projects; the browser bundle is generated and ignored by git. The default
demo needs no external samples or plugins. Customize the demo list for builds
that should include different projects or no projects.

Each `demos` entry has `id`, `title`, `directory`, `entry`, optional `entries`, and
optional `description`. There is no project-specific runtime code. Paths are
relative to the configuration file. Set `MUZPAD_BUILD_CONFIG` to use a different
configuration; `npm run prepare:catalog` refreshes just the bundled files.

The production Cloudflare configuration serves `dist/` as static assets at
`muzpad.plausiblyreliable.com`, without application code or storage bindings.
After signing in with Wrangler, `npm run deploy` builds and publishes it, or use
`npx wrangler deploy` to publish an already validated build.

## Runtime

The compiler and rendering workers each instantiate the same WASM library.
Compilation returns inspection data plus a session snapshot with performed event
arrays explicitly included. A replacement rendering worker prepares the candidate
before the accepted worker is replaced. Rejected compilation/preparation retains
the previous engine. Compiler work has a cancel action and a 30-second timeout.

The rendering worker fills a bounded queue of 1024-frame stereo PCM buffers. The
AudioWorklet drains them, returns buffers for reuse, and reports consumed positions
and corresponding track meters. Seek epochs discard obsolete queued audio. The
queue holds at most about half a second at 48 kHz; initial playback primes roughly
170 ms. Worker scheduling and host audio add latency. No real-time input is promised.

## Current limits

Desktop browsers are the initial target. Native VST3/CLAP plugins are unavailable.
Local sample, audio-clip and MIDI-file imports are not implemented; contrib packs
that need those assets are browseable but cannot play. There is no recording,
note/automation/patch editing, or seamless live device
reconciliation. Large or expensive programs can exceed browser memory/CPU budgets;
the UI reports audio underruns rather than claiming glitch-free playback.

The first timing check through the WASM bridge compiled the full demo in roughly
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
Set `CHROMIUM_PATH` to use an existing Chromium executable. Engine embedding tests
live in muz-core and use small independent cases. Still Our Own is a manual
integration demo, not a frozen regression fixture.
