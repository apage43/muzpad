# Desktop implementation: remaining work

Implement a Linux-first Tauri 2 application with trusted bundled UI and an owned
`muzpad-engine` Rust child embedding muz-core. Keep the static web workbench
independent: its WASM workers/Web Audio are a separate adapter, never a native
failure fallback. Native plugins are trusted executable code; process isolation
protects editor state from engine death, not individual plugins from each other.
macOS/Windows boundaries should remain portable; their packaging and native
verification are not part of the Linux acceptance claim.

## Owning plans and edit boundaries

| Owner | Pending plan | Exclusive implementation files |
| --- | --- | --- |
| Shared UI/integration | [desktop-ui.md](desktop-ui.md) | `src/main.ts`, `src/style.css`, `src/editor.ts`, `src/theme.ts`, `src/preferences.ts`, `src/views.ts`, `src/document.ts`, shared UI browser specs, `README.md` |
| TS host adapters | [desktop-adapters.md](desktop-adapters.md) | `src/host/`, `src/audio.ts`, `src/inspection.ts`, `src/export.ts`, web worker/engine modules as necessary, `src/folder.ts`, `src/project-storage.js`, `src/assets.js`, adapter/unit tests |
| Rust desktop host | [desktop-host.md](desktop-host.md) | all `src-tauri/`, including crate roots, protocol, parent services, engine child, Cargo/config/capabilities/resources and Rust host tests |
| Packaging/integration | [desktop-integration.md](desktop-integration.md) | package scripts/lockfile, catalog/build configuration, release resources outside `src-tauri/`, release smoke automation; starts after UI/adapter/host integration |

Do not edit another owner's files concurrently. The packaging owner routes
`src-tauri/` changes through its owner and README changes through the UI owner.
The UI owner integrates both web and native adapters in the same main/style
ownership; there is no second native UI implementation.

## Frozen consuming boundaries

Implement `createWorkbenchHost(): Promise<WorkbenchHost>` in `src/host/index.ts`;
`WorkbenchHost` contains `runtime`, `projects`, `preferences`, `subscribe`,
`restartEngine`, `openExternal` and `dispose`. Declarations live only in
`src/host/contracts.ts`. `WorkbenchRuntime` methods are `rebuild`, `format`,
`checkEntries`, `inspect`, `explain`, `location`, `diff`, `transport`, `audition`,
`analysis`, `export`, `subscribe`, `dispose`. UI must not access Compiler,
AudioPlayer, workers, playable snapshots, audio asset bytes, or native invoke.
`ProjectStore.snapshotSources` returns an immutable opaque source snapshot;
`rebuild` contains compile/prepare/apply/receipt promotion as one operation.
`RevisionRef` binds project ID, project epoch, engine epoch, opaque string
revision, sourceVersion and entry. Request-scoped abort is not a global cancel.
Only an authoritative applied receipt promotes accepted state.

The implementation handoff `local://desktop-frozen-contract.md` fixes exact DTOs,
Tauri command names, event names and child wire commands. Transcribe those
interfaces without alternate spellings or compatibility aliases. Every request
and event is identity-bound; reject stale epochs/revisions and explicitly expire
unretained handles. Retain accepted and previous Compiled metadata, with bounded
job pins. Preserve core JSON inspection rows/diagnostics instead of inventing a
second compiler representation.

The Tauri parent owns project authority, immutable source capture, grants,
watching, safe writes, dialogs, recovery, recents, preferences and close decisions.
The child owns native compile/runtime/inspection/export; it receives only
parent-authorized immutable sources/resources/output grants. Use private
length-framed inherited protocol pipes distinct from plugin stdout/stderr, not
`muz serve`, CLI scraping, an exposed socket, or general shell commands.

Consume muz-core's source-independent `native::NativeRuntime`: `start`,
`audio_config`, `status`, `plugin_stamp`, `prepare_revision`, `submit_revision`,
`cancel_operation`, `poll`, `service_plugins`, `prepare_plugin_restart`,
`set_running`, `restart`, `panic`, `seek_ticks`, `set_loop`, `set_audibility`,
`set_observation`, `drain_observations`, `shutdown`, and `PluginStamp::apply`.
The core-owned [pending plan](../../muz-core/docs/native-runtime-plan.md)
determines Rust signatures and realtime/plugin/replay internals; do not duplicate
its work here.
Muzpad retains Compiled and promotes it on `NativeEvent::RevisionApplied`;
borrow accepted/candidate Sessions rather than cloning graphs for coordination.

Initial desktop ceilings: 2 MiB encoded frame; 256 KiB source chunks; 8 MiB per
source and 64 MiB captured source text per revision; 64 small control requests;
one preparing candidate plus one coalesced latest; inspection 1,000 rows/1 MiB;
status/meters 20 Hz; detailed analysis 10 Hz, 2,048 waveform values, 1,024 bins,
1,000 track meters and 128 KiB/frame; two export workers/32 queued jobs; core
checked playable transfers 256 MiB. Negotiate actual limits and expose explicit
busy/too-large errors. Core graph/expansion/decode limits remain separate from
project text policy; native samples do not inherit browser upload limits.

## Landing protocol

Commit these plans and the core-owned plan before feature edits. Then the shared
UI, TS adapters and Rust host may implement their disjoint files against the
frozen contract while core delivers NativeRuntime. Native acceptance depends on
that real runtime; no fake backend or narrower parity cut is acceptable. Integrate
UI/host first, then package and verify once using the owning plan scenarios.
Workers do not run builds, tests, formatters or linters mid-flight; the integration
owner runs the checks after all changes land.

Each implementation commit removes its delivered scope from its owning pending
plan and updates affected live documentation in that repository. Delete exhausted
plans and remove their index rows; do not turn them into completed checklists or
history. Keep any still-unexercised acceptance work in the integration plan until
it is actually exercised. Preserve unrelated edits, commit coherent owned files,
and do not deploy.

No plugin GUI, recording, piano-roll editing, new plugin format, per-plugin
sandbox, cloud sync, extension marketplace, automatic plugin download, credentials,
or speculative audio-device/latency controls are required.
