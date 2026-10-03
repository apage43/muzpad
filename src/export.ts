import { escapeHTML as esc } from "./views";
import type { AcceptedRevision, ExportSpec, Operation, WorkbenchRuntime } from "./host/contracts";
import { revisionIdentity } from "./inspection";
import { describeActionFailure, technicalDetails } from "./workbench-status";
import type { ActionStatus } from "./workbench-status";

type ExportRevision = AcceptedRevision & { name: string };

/** Retains the exact accepted assets even when the working copy changes. */
export class ProjectExporter {
  private accepted?: ExportRevision;
  private request?: AbortController;
  private unsubscribe?: () => void;
  private dialog?: HTMLDialogElement;
  constructor(private runtime: WorkbenchRuntime, private operation: (signal?: AbortSignal) => Operation, private createOutcomeReporter: (revision: ExportRevision) => (status: ActionStatus) => void) {}
  set(value?: ExportRevision) {
    this.accepted = value;
    const button = document.getElementById("export-media") as HTMLButtonElement;
    if (button) button.disabled = !value;
  }
  open(edited: boolean) {
    const revision = this.accepted;
    if (!revision) return;
    this.close();
    const tracks = revision.exportTracks;
    const fullEnd = revision.status.duration + revision.status.tail;
    const dialog = document.createElement("dialog");
    this.dialog = dialog;
    dialog.className = "export-dialog";
    dialog.setAttribute("aria-labelledby", "export-title");
    dialog.innerHTML = `<h2 id="export-title">Export audio & MIDI</h2>
      <p>Accepted revision ${esc(revision.ref.revision)}${edited ? " · Rebuild first to include your latest edits." : "."}</p>
      <button id="export-master" class="primary">Download master WAV</button>
      <p class="export-help">Full song and effect tail · stereo · 48 kHz / 24-bit. Uses the written mix; temporary mute and solo are ignored.</p>
      <form id="export-form">
      <fieldset><legend>Custom export</legend>
      <label>Format <select id="export-format"><option value="wav">WAV audio</option><option value="midi">Multitrack MIDI (.mid)</option></select></label>
      <div class="export-tracks"><strong>Tracks</strong><div><button type="button" id="export-all">Select all</button> <button type="button" id="export-none">Clear</button></div>
      ${tracks.map((t, i) => `<label><input type="checkbox" name="export-track" value="${i}" checked> ${esc(t.name || t.id)}</label>`).join("")}</div>
      <p id="export-routing" class="export-help">Selected tracks mixed through their buses and master effects into one stereo WAV. Soloed exports may change shared effects and sidechains.</p>
      <div id="export-wav-settings" class="export-settings">
      <label>Sample rate <select id="export-rate"><option value="44100">44.1 kHz</option><option value="48000" selected>48 kHz</option><option value="96000">96 kHz</option></select></label>
      <label>Bit depth <select id="export-bits"><option value="16">16-bit PCM</option><option value="24" selected>24-bit PCM</option></select></label>
      <label>Start (seconds) <input id="export-start" type="number" min="0" step="any" value="0" required></label>
      <label>End (seconds, including tail) <input id="export-end" type="number" min="0" step="any" value="${fullEnd}" required></label>
      </div></fieldset><button id="export-submit" class="primary" type="submit">Download WAV</button></form>
      <p id="export-status" role="status" aria-live="polite"></p><progress id="export-progress" max="1" value="0" hidden></progress>
      <p id="export-usable" hidden></p><details id="export-diagnostics" hidden><summary>Technical diagnostics</summary><button id="export-copy-diagnostics" type="button">Copy diagnostics</button><pre id="export-technical" tabindex="0"></pre></details>
      <div class="export-footer"><button id="export-cancel" hidden>Cancel export</button><button id="export-close">Close</button></div>`;
    document.body.append(dialog);
    const get = <T extends HTMLElement = HTMLElement>(id: string) =>
      dialog.querySelector(`#${id}`) as T;
    const inputs = [
      ...dialog.querySelectorAll<HTMLInputElement>(
        'input[name="export-track"]',
      ),
    ];
    const format = get<HTMLSelectElement>("export-format");
    const report = (text: string) => {
      get("export-status").textContent = text;
    };
    let technical: unknown;
    const showTechnical = (value: unknown) => {
      technical = value;
      get("export-diagnostics").hidden = false;
      get("export-technical").textContent = technicalDetails(value);
      get("export-copy-diagnostics").textContent = "Copy diagnostics";
    };
    get("export-copy-diagnostics").onclick = () => {
      void navigator.clipboard.writeText(technicalDetails(technical))
        .then(() => { get("export-copy-diagnostics").textContent = "Copied"; })
        .catch(() => { get("export-copy-diagnostics").textContent = "Select diagnostics to copy"; });
    };
    const setBusy = (busy: boolean) => {
      dialog
        .querySelectorAll<
          HTMLButtonElement | HTMLInputElement | HTMLSelectElement
        >("fieldset, #export-master, #export-submit")
        .forEach((el) => {
          el.disabled = busy;
        });
      get("export-cancel").hidden = !busy;
      get("export-progress").hidden = !busy;
    };
    const cancel = () => {
      this.request?.abort();
      report("Cancelling export…");
    };
    get("export-cancel").onclick = cancel;
    get("export-close").onclick = () => this.close();
    dialog.oncancel = (event) => {
      event.preventDefault();
      this.close();
    };
    get("export-all").onclick = () =>
      inputs.forEach((input) => {
        input.checked = !input.disabled;
      });
    get("export-none").onclick = () =>
      inputs.forEach((input) => {
        input.checked = false;
      });
    format.onchange = () => {
      const midi = format.value === "midi";
      get("export-wav-settings").hidden = midi;
      get("export-wav-settings")
        .querySelectorAll<HTMLInputElement>("input")
        .forEach((el) => {
          el.disabled = midi;
        });
      get("export-routing").textContent = midi
        ? "One named MIDI track per selected track, plus tempo and meter. Includes performed notes, controllers and channel messages. Instruments, audio and mix effects are not included; original MIDI channels are preserved. Sampled tracks export trigger notes."
        : "Selected tracks mixed through their buses and master effects into one stereo WAV. Soloed exports may change shared effects and sidechains.";
      get("export-submit").textContent = midi
        ? "Download MIDI"
        : "Download WAV";
      inputs.forEach((input) => {
        input.disabled =
          midi && !tracks[Number(input.value)].midi;
      });
    };
    const start = (master: boolean) => {
      if (this.request) return;
      const kind = master ? "wav" : format.value;
      const selected = master
        ? tracks.map((t) => t.id)
        : inputs
            .filter((input) => input.checked && !input.disabled)
            .map((input) => tracks[Number(input.value)].id);
      const from = master
        ? 0
        : Number(get<HTMLInputElement>("export-start").value);
      const end = master
        ? fullEnd
        : Number(get<HTMLInputElement>("export-end").value);
      if (!selected.length) {
        report("Select at least one track.");
        return;
      }
      if (
        kind === "wav" &&
        (!Number.isFinite(from) ||
          !Number.isFinite(end) ||
          from < 0 ||
          end <= from ||
          end > fullEnd + 0.000001)
      ) {
        report(
          `Choose a range from 0 to ${fullEnd.toFixed(3)} seconds, with end after start.`,
        );
        return;
      }
      const request = new AbortController();
      const op = this.operation(request.signal);
      const requestId = op.requestId;
      const onOutcome = this.createOutcomeReporter(revision);
      this.request = request;
      setBusy(true);
      get<HTMLProgressElement>("export-progress").value = 0;
      report("Preparing export…");
      get("export-usable").hidden = true;
      let phase: string | undefined;
      this.unsubscribe = this.runtime.subscribe((event) => {
        if (event.kind !== "exportProgress" || event.requestId !== requestId || revisionIdentity(event.ref) !== revisionIdentity(revision.ref)) return;
        const progress = get<HTMLProgressElement>("export-progress");
        if (event.progress === null) progress.removeAttribute("value");
        else progress.value = event.progress;
        if (phase !== event.phase) { phase = event.phase; report(`${event.phase} export…`); }
      });
      const spec: ExportSpec = master ? { kind: "masterWav" }
        : kind === "midi" ? { kind: "midi", tracks: selected }
        : { kind: "wav", tracks: selected,
          rate: Number(get<HTMLSelectElement>("export-rate").value) as 44100 | 48000 | 96000,
          bits: Number(get<HTMLSelectElement>("export-bits").value) as 16 | 24,
          start: from, end };
      const action = master ? "Export master WAV" : kind === "midi" ? "Export MIDI" : "Export selected WAV";
      const requested = { action, requestId, ref: revision.ref, spec };
      showTechnical(requested);
      onOutcome({ channel: "operation", requestId, action, outcome: "pending", summary: "Preparing accepted snapshot export.", nextAction: "You can continue editing.", technical: requested });
      void this.runtime.export(revision.ref, spec, op)
        .then((result) => {
          const summary = result.clipped
            ? "Exported. Some samples clipped above 0 dBFS; lower the mix level and export again."
            : `Exported ${result.name}.`;
          const receipt = { ...requested, ref: result.ref, result };
          showTechnical(receipt); report(summary);
          onOutcome({ channel: "operation", requestId, action, outcome: "applied", summary, nextAction: "Continue editing or export another accepted snapshot.", technical: receipt });
        }, (error: unknown) => {
          const failure = describeActionFailure(error);
          const detail = { ...requested, outcome: failure.outcome, diagnostic: failure.diagnostic };
          showTechnical(detail);
          const summary = failure.outcome === "cancelled" ? "Export cancelled."
            : failure.outcome === "superseded" ? `Export superseded: ${failure.detail}`
            : failure.outcome === "unknown" ? `Export outcome unknown: ${failure.detail}`
            : failure.outcome === "partial" ? `Export partly applied: ${failure.detail}`
            : failure.outcome === "applied" ? `Export applied with a reported issue: ${failure.detail}`
            : `Export ${failure.outcome === "rejected" ? "rejected" : "failed"}: ${failure.detail}`;
          const nextAction = failure.outcome === "unknown" || failure.outcome === "partial" ? "Do not assume a file was published; inspect diagnostics before choosing another action." : "Inspect diagnostics, then retry explicitly if appropriate.";
          report(summary);
          onOutcome({ channel: "operation", requestId, action, outcome: failure.outcome, summary, nextAction, technical: detail, location: failure.location });
          get("export-usable").hidden = false;
          get("export-usable").textContent = `Working buffers remain usable. This export uses accepted revision ${revision.ref.revision}, not unsaved edits. ${nextAction}`;
        }).finally(() => {
          if (this.request !== request) return;
          this.request = undefined;
          this.unsubscribe?.();
          this.unsubscribe = undefined;
          setBusy(false);
        });
    };
    get("export-master").onclick = () => start(true);
    get<HTMLFormElement>("export-form").onsubmit = (event) => {
      event.preventDefault();
      start(false);
    };
    dialog.showModal();
  }
  close() {
    this.request?.abort();
    this.request = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.dialog?.close();
    this.dialog?.remove();
    this.dialog = undefined;
  }
}
