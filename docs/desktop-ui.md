# Shared workbench UI: remaining work

Owner and dependency boundaries are in [desktop-direction.md](desktop-direction.md).
Use the frozen host contract; implement shared UI first against the web adapter,
then integrate native capabilities/project safety in the same owned files.

## Tabs and canonical buffers

- Replace independent mutable file/library selection with `activeTab: TabKey|null`
  and ordered unique `openTabs`, using `project:${path}` / `library:${path}` keys.
  Implement `openTab(key, focusIntent)`, `closeTab(key)`, `renderTabs()` and
  `renderActiveSource()`. Scope caches to project lifetime, not basename.
- Keep edits in canonical project buffers immediately, independently of tabs.
  Closing a view never deletes text, saves, rebuilds, scans entries, resets runtime,
  changes entry, accepted revision, loop, audition, selection or dirty status.
  Open existing tabs without reordering; append reopened tabs once. Close active
  tabs to the pre-removal right neighbor, otherwise left; inactive close does not
  switch source. Last close leaves active-null and a useful No file open panel
  with Open entrypoint and Show explorer, disabled Format/Use as entry and usable
  Entrypoints, Rebuild and transport. Library tabs remain read-only.
- Add SourceEditor checkpoint/detach with CodeMirror state, undo/redo, selections
  and scroll. Checkpoint before source/document switches and active/last close;
  detach late edit routing. Restore read-only/theme configuration without edits.
  Retain document scroll/details state; explicit fragment/location navigation wins.
  Externally refreshed clean text invalidates only incompatible per-file cache;
  never restore stale cached text over canonical buffers.
- Same-project refresh preserves open order and active-null; apply right-then-left
  selection when a selected clean file disappears. Only successful project
  replacement clears caches. Guard async Format by project epoch, project tab,
  bufferVersion and captured text; stale replies and detached/null edit callbacks
  must not edit another file or create an empty-path file.
- Render sibling activation/close buttons with full-path/kind accessible names,
  existing `data-tab` activation keys and tab/panel ARIA. Arrow Left/Right and
  Home/End activate tabs; Delete closes focused tab; Enter/Space operate close.
  Preserve unrelated focus; removing focused controls selects surviving active
  tab or empty action and scrolls selected tab into view. Desktop close-tab shortcut
  uses this operation, not window close; leave browser Ctrl/Cmd+W alone.

## Panes, focus and layout

- Add collapse controls and an always-visible Panes toolbar outside all content,
  adjacent to transport/settings. Expose Explorer, Source, Visualization, Inspector
  with accurate effective ARIA state. Source includes Markdown; inspector lives
  inside visualization. Hiding visualization preserves inspector preference;
  restoring inspector also reveals visualization.
- Hidden panes occupy no grid column/row/min-height/gutter; hide splitter unless
  source and visualization are both visible at wide widths. Single visible content
  fills available area; all-hidden retains transport, diagnostics, settings and
  restore actions. At <=800px use only visible stacked Explorer/Source/Visualization
  sections; bounded explorer scroll and usable content heights, no 390px horizontal
  page overflow, wrapping global controls and usable short-height layout.
- Measure splitter against actual combined source/visual region, not a fixed
  explorer width. Persist sourceFraction default .46, clamp .25–.70; visual minimum
  widths do not overwrite preference. Pointer release/cancel and keyboard arrows/
  Home/End commit/release correctly; expose separator min/max/current. Restore
  fraction through hide/show and responsive transitions.
- On hiding a focused pane remember its descendant and focus external restore;
  direct restore returns to connected visible descendant or meaningful pane
  fallback. Do not steal unrelated/startup/settings focus. Source navigation reveals
  source and focuses destination. Settings close returns safe invoker/global focus.
- Retain explorer search/expansion, editor/document state, graph page/pan/selection,
  arrangement zoom/groups/follow, inspector, analysis target, audition and loop.
  Suspend hidden expensive drawing/follow/detail capture without runtime reset.
  Reveal remeasures editor and redraws current data once: follow-off preserves
  viewport, follow-on may catch up. Inspector-only hide does not hide analysis.
  Reset layout restores all four true and .46 without changing theme or project.

## Preferences, settings and themes

- Add `src/preferences.ts` as the single normalizer/controller over host
  PreferencesStore. Use version 1, theme light/dark/soft-light/soft-dark and layout
  booleans/sourceFraction; defaults light/all visible/.46. Validate fields
  individually, finite fraction/clamping, unknown/version-invalid data safely.
  Initialize before pane application; persistence failure never blocks startup,
  editing, rebuild or controls. Show nonblocking Preferences are temporary in
  settings, separate from engine diagnostics. Serialize newest-wins saves.
- Replace binary theme button with compact Settings dialog: four-choice theme,
  four pane checkboxes, Reset layout, Close; immediate application, Escape and
  contained focus, safe focus restoration. No second storage provider or invented
  native device controls. Preferences never enter files, muzpad.json, archives,
  gists, recovery text, dirty counters or compiler inputs. Web migration/storage
  and native config persistence are supplied by host adapters.
- Retain light/dark identity/appearance and add exactly soft-light/soft-dark through
  complete existing `--c-*` token maps. Centralize `isDarkTheme`; remove literal-dark
  checks. Theme application sets meta color, color-scheme, tokens and cache
  invalidation only; persistence lives in preferences. Reconfigure editors and
  redraw canvas/analysis even idle or after hidden reveal without source edits,
  graph refetch/reset or lost visual navigation.
- Add narrowly scoped semantic muted-text/focus tokens where decorative/text roles
  conflict. Meet actual computed WCAG contrast: normal text 4.5:1; qualified large
  text 3:1; focus/essential control/selection boundaries 3:1 with adjacent surfaces.
  Selected text stays 4.5:1. Include alpha compositing and explicit canvas token/
  background pairs, not screenshots alone. Preserve recognizable legacy themes.

## Shared host integration and live documentation

- Replace main's direct player/compiler/worker/analyser/export snapshot access with
  host operations and event identities. Use project snapshots as canonical buffers;
  display unsaved-to-disk separately from unbuilt and accepted-entry state. Make
  capabilities, engine death/restart, dependency diagnostics, native save/reveal,
  recents/recovery and conflict/close workflows reachable, without routing native
  work into browser storage or WASM. Keep inspection continuations, source navigation,
  export dialogs, arrangement/listening/loop controls and all existing web actions.
- Preserve sanitized Markdown. Local links use authorized project/library identities;
  desktop external links call explicit host HTTP(S) opener, never privileged webview
  navigation. Retain plain web link behavior through the web host.
- Route project replacement/window close through prepareClose with save/discard/
  cancel, conflicts and jobs; save failure vetoes close. Dialogs offer use disk,
  keep local or merged text without implicit disk write; recovery restore is an
  offer. UI answers parent close requests; do not rely on pagehide/beforeunload.
- Update README for actual environment capabilities/setup, four themes/settings,
  tab neighbor/last-close/keyboard semantics, collapse/restore/reset, storage failure,
  native projects/safety/recovery and engine lifecycle. Explain live-session undo/
  scroll retention versus no promised cross-launch undo/tab persistence. Reconcile
  packaging instructions through its owner; do not document unverified behavior as
  verified. Prune delivered tasks from this plan in implementation commits.

## Acceptance implementation to add

Extend real production-bundle Chromium/Firefox/WebKit tests, including
`tests/browser/workbench-layout.spec.ts`, `appearance.spec.ts` and existing
`workbench.spec.ts`; run only at integrated verification, not during this slice.

Cover duplicate-basename project/library/Markdown tabs; modified inactive and
active close/right-left selection; undo/selection/scroll/details restoration;
read-only reopen; all-tabs-closed playback with loop/audition/nondefault entry;
closed-buffer rebuild/export/recovery; async formatting/project-switch guards;
refresh deletion and active-null; cancelled replacement; reload recovery without
claiming durable view history. Assert closure causes no runtime/save/build call.

Exercise 1512x982, ~1000px and 390x844 plus short heights, each/all pane visibility,
zero hidden geometry, keyboard-only focus/ARIA, pointer/cancel/keyboard splitter,
responsive transitions/reload/reset, playback and paused hide/reveal with follow
on/off and preserved graph/analysis/selection. Test all four themes across editor,
Markdown, menus/dialogs, graph/canvas/meter/analysis and idle/playing/hidden modes.
Contrast assertions report numeric failing pairs for ordinary/muted/error text,
tabs, syntax/comments/line numbers/selection, links/code, buttons/focus, inspector,
analysis and canvas/SVG labels on actual backgrounds. Screenshots supplement them.

Exercise all legacy light/dark and inspector migration combinations; malformed,
partial, unsupported and nonfinite preferences; denied getters/setters and newest
rapid save wins. ZIP/settings exclusion and project switches must not reset global
preferences. Actual Linux WebKit close/reopen/pane/focus/theme/settings relaunch
acceptance is owned by the integration plan, not replaced by browser tests.
