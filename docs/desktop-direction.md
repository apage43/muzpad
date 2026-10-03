# Desktop muzpad: high-level direction

This is pending product direction, before the detailed plan and implementation
breakdown. It describes intended behavior, not shipped capabilities.

## Outcome and scope

Make muzpad both a static web workbench and a lightweight desktop muz IDE. The
desktop application must open real local projects and execute native muz,
including installed CLAP/VST3 plugins and local sample dependencies. Packaging
the WASM workbench in a window alone does not meet this goal.

The first desktop target is **Linux**, with portable application boundaries.
macOS/Windows packaging and native verification are deferred, not claimed.
Keep the web application independently usable and statically deployable.

Also deliver shared workbench improvements:

- Close buttons on file tabs.
- Collapsible explorer, source/document, and visualization panes, retaining the
  existing inspector collapse behavior.
- Two additional restrained color themes: a softer light palette and a softer
  dark palette. Preserve the existing themes and saved selections.
- A lightweight settings pane for appearance and layout, plus desktop-specific
  controls only where the native workflow needs them.

## Architecture direction

Reuse the workbench UI across two explicit environments:

- **Web:** portable WASM engine, workers, Web Audio, browser drafts and optional
  browser folder connections. Native plugins remain unsupported here.
- **Desktop:** native project access and a Rust host using muz-core's embedding
  APIs, native audio and installed plugin support. Source buffers may be edited
  without saving before a rebuild; the host must compile that coherent revision,
  not silently substitute the disk version.

Keep a narrow boundary for runtime operations, filesystem/project access, and
host capabilities. Extract it around existing behavior rather than introducing a
universal backend framework. Share workbench semantics, not browser PCM plumbing:
compiled revisions, diagnostics, inspection, transport and export need native
implementations; streaming PCM through UI IPC is not the desktop audio design.
Bound inspection/analysis traffic and keep it outside the audio callback.

Prefer direct Rust library integration over scraping CLI output. Evaluate a
lightweight system-webview shell (Tauri is a candidate) against Linux dependencies,
startup/resource cost, packaging and the actual embedding requirements before
selecting it. A larger bundled-browser shell needs a demonstrated benefit.

Resolve engine process ownership during the architecture spike: in-process
integration is simpler, but a crashing native plugin could terminate the editor.
A separate engine host adds lifecycle/IPC work but can preserve the UI and buffers
when the engine dies. Prefer an application-owned engine process if the spike
shows the existing APIs can support it without disproportionate complexity.
Do not mistake this for per-plugin sandboxing or promise universal plugin safety.
The existing `muz serve` control socket is a reuse candidate, not assumed to be a
complete editor protocol.

Compilation, asset decoding and plugin construction stay off the audio callback;
prepared changes apply at block boundaries and retired state is destroyed off
that callback. Failed rebuilds preserve the last accepted session. Preserve
revision identity, cancellation and stale-response rejection across the boundary.

## Make local operation meaningfully better

- Open folders with native dialogs; save directly and safely, including new files.
  Keep unsaved-to-disk status distinct from not-yet-rebuilt status.
- Retain project identity across launches and offer recent projects. Restore
  recoverable edits without silently overwriting newer disk content.
- Observe external edits: refresh clean buffers, surface conflicts for edited
  buffers, and never silently discard either version. Avoid accidental rebuilds
  against a mixture of disk and editor revisions.
- Resolve local imports, samples and plugin configuration using native muz
  semantics. Do not copy entire native sample libraries into browser storage or
  impose browser upload limits on native projects. Preserve explicit resource
  limits where needed rather than promising unlimited memory use.
- Use native save/export dialogs and a reveal-in-file-manager action. Support
  ordinary desktop shortcuts and safe project/window/application close.
- Work offline for local projects and bundled documentation. GitHub/gist actions
  remain explicitly network-dependent.
- Show actual runtime capabilities and actionable missing-plugin/sample/audio
  errors. Do not display browser-only dependency warnings in native mode.

Keep privileges narrow: only bundled trusted UI may call native host commands;
project Markdown, imported content and external links must not gain filesystem or
process privileges. Native plugins execute trusted local code, not sandboxed data.
No plugin downloading, credential storage or arbitrary shell execution is implied.

## Tabs and panes

Closing a tab closes its view, not the file or its project buffer. Preserve edits
and editor state so reopening is lossless; closing a tab must neither save nor
rebuild implicitly. Closing the active tab selects a predictable neighbor; closing
the last tab produces a useful empty source pane without stopping playback or
changing the selected entrypoint. Keep library tabs read-only. Protect unsaved
work when replacing a project or quitting, separately from tab closure.

Every major pane gets a discoverable collapse action and an always-reachable
restore action. Hidden panes consume no layout space; restoration retains useful
size and state. Keep transport and restore controls accessible even when all
content panes are hidden. Support keyboard operation, focus movement and narrow
stacked layouts, not just the wide desktop grid. Persist layout preferences and
offer reset layout; collapsing a view must not reset the runtime or project.

## Appearance and settings

Add soft light and soft dark palettes through the existing CSS-token mechanism.
Apply each theme consistently to CodeMirror, arrangement, graphs, meters, analysis,
menus and native-control color scheme. Lower surface contrast must not make text,
selection, focus or diagnostics illegible; check normal text at WCAG AA contrast.
Do not replace the current light/dark choices or add a second styling system.

Use a compact settings pane, not a new settings framework. Initial shared controls
are theme selection and layout visibility/reset. Keep preferences separate from
project content and exports; unavailable preference storage must not prevent
startup. Desktop preference storage must survive normal relaunches without
claiming synchronization with the web app. Add native audio/plugin configuration
controls only after identifying what existing muz configuration cannot adequately
expose; do not invent nonfunctional device/latency settings in advance.

## Repository ownership and live-document protocol

- **muzpad:** desktop application host/bridge, UI, project workflows, packaging,
  shared settings and presentation; its pending plan lives under `docs/`.
- **muz-core:** reusable engine/API changes only where the integration proves a
  gap. Existing native support is not evidence that core changes are unnecessary,
  nor a reason to duplicate engine logic in muzpad. Before core implementation,
  commit its concrete pending plan under `../muz-core/docs/`, following its repo
  instructions. Update its embedding/live docs with changed contracts.
- Do not mirror task lists across repos. Each detailed task has one owner; record
  only the required cross-repository interface/dependency in the consuming plan.
- Commit plans before implementation. Update them during decomposition. Every
  implementation commit removes the implemented scope from planning documents
  and updates affected live documentation in that same owning repository.
- Planning documents contain only remaining work, not completed checklists,
  progress journals or historical architecture decisions. Delete exhausted plans;
  source control retains history. Replace this direction document as detailed
  plans absorb its outstanding scope rather than leaving redundant promises.
- Commit coherent changes in their owning repos, exclude unrelated changes, and
  keep everything local unless deployment is explicitly requested.

## Gates before the proper plan and decomposition

1. Exercise a minimal Linux native-host path: local project plus unsaved-source
   overlay, an installed supported plugin, audio output, rebuild and inspection.
   Compare current library embedding with the control-socket route; choose shell,
   process ownership and the smallest complete host contract from that evidence.
2. Inventory parity against the existing workbench: source formatting, entrypoint
   discovery, accepted/rejected rebuilds, transport/seek/loop, audition, mute/solo,
   inspection/analysis, exports, assets and recovery. Assign every operation to a
   shared or environment-specific implementation; no silent desktop omissions.
3. Identify exact core gaps and platform prerequisites, document cross-repository
   interfaces and dependency order, and commit the remaining-work plans in the
   appropriate repositories before implementing those changes.
4. Decompose around runnable vertical slices: native execution and project safety;
   shared tab/layout controls; appearance/settings; packaging and integration.
   Parallelize only after contracts and file ownership are clear. Tabs/layout and
   themes/settings both currently touch `src/main.ts` and `src/style.css`; they
   are not safe concurrent edits without an explicit integration owner.

## Acceptance evidence required by the detailed plan

Run the actual Linux desktop application against a real folder with a supported
installed native plugin and local assets. Demonstrate edit/rebuild/playback,
inspection, export, external-edit conflict handling, recovery and clean shutdown.
Exercise native-engine failure behavior according to the chosen process model;
report plugin coverage and latency measurements without generalizing guarantees.
A missing plugin/audio service is a visible failure, never a silent WASM fallback.

Exercise close/reopen (including modified, inactive, library and last tabs), pane
collapse/restore at wide and narrow widths, keyboard focus, theme consistency and
settings persistence on the actual UI. Retain browser behavior and run relevant
existing browser/core checks after integration. Packaging must launch outside the
development server without requiring a sibling source checkout. Record findings
in the work report, not as permanent completed-plan entries.

Plugin GUI embedding, recording, DAW-style note editing, new plugin formats,
per-plugin isolation, cloud synchronization and an extension marketplace are not
part of this direction. Revisit only if a demonstrated requirement changes scope.
