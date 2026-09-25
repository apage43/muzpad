import { escapeHTML as esc } from "./views";

type ExportRevision = {
  snapshot: any;
  assets: any[];
  duration: number;
  revision: number;
  name: string;
};

/** Retains the exact accepted assets even when the working copy changes. */
export class ProjectExporter {
  private accepted?: ExportRevision;
  private worker?: Worker;
  private dialog?: HTMLDialogElement;
  set(value?: ExportRevision) {
    this.accepted = value;
    const button = document.getElementById("export-media") as HTMLButtonElement;
    button.disabled = !value;
  }
  open(edited: boolean) {
    const revision = this.accepted;
    if (!revision) return;
    this.close();
    const tracks = revision.snapshot.description.tracks;
    const fullEnd =
      revision.duration + revision.snapshot.description.extras.tail;
    const dialog = document.createElement("dialog");
    this.dialog = dialog;
    dialog.className = "export-dialog";
    dialog.setAttribute("aria-labelledby", "export-title");
    dialog.innerHTML = `<h2 id="export-title">Export audio & MIDI</h2>
      <p>Accepted revision ${revision.revision + 1}${edited ? " · Rebuild first to include your latest edits." : "."}</p>
      <button id="export-master" class="primary">Download master WAV</button>
      <p class="export-help">Full song and effect tail · stereo · 48 kHz / 24-bit. Uses the written mix; temporary mute and solo are ignored.</p>
      <form id="export-form">
      <fieldset><legend>Custom export</legend>
      <label>Format <select id="export-format"><option value="wav">WAV audio</option><option value="midi">Multitrack MIDI (.mid)</option></select></label>
      <div class="export-tracks"><strong>Tracks</strong><div><button type="button" id="export-all">Select all</button> <button type="button" id="export-none">Clear</button></div>
      ${tracks.map((t: any, i: number) => `<label><input type="checkbox" name="export-track" value="${i}" checked> ${esc(t.name || t.id)}</label>`).join("")}</div>
      <p id="export-routing" class="export-help">Selected tracks mixed through their buses and master effects into one stereo WAV. Soloed exports may change shared effects and sidechains.</p>
      <div id="export-wav-settings" class="export-settings">
      <label>Sample rate <select id="export-rate"><option value="44100">44.1 kHz</option><option value="48000" selected>48 kHz</option><option value="96000">96 kHz</option></select></label>
      <label>Bit depth <select id="export-bits"><option value="16">16-bit PCM</option><option value="24" selected>24-bit PCM</option></select></label>
      <label>Start (seconds) <input id="export-start" type="number" min="0" step="any" value="0" required></label>
      <label>End (seconds, including tail) <input id="export-end" type="number" min="0" step="any" value="${fullEnd}" required></label>
      </div></fieldset><button id="export-submit" class="primary" type="submit">Download WAV</button></form>
      <p id="export-status" role="status" aria-live="polite"></p><progress id="export-progress" max="1" value="0" hidden></progress>
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
      this.worker?.terminate();
      this.worker = undefined;
      setBusy(false);
      report("Export cancelled.");
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
          midi && tracks[Number(input.value)].source.kind !== "midi";
      });
    };
    const start = (master: boolean) => {
      if (this.worker) return;
      const kind = master ? "wav" : format.value;
      const selected = master
        ? tracks.map((t: any) => t.id)
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
      const worker = new Worker(
        new URL("./export.worker.ts", import.meta.url),
        { type: "module" },
      );
      this.worker = worker;
      setBusy(true);
      get<HTMLProgressElement>("export-progress").value = 0;
      report("Preparing export…");
      const finish = () => {
        worker.terminate();
        this.worker = undefined;
        setBusy(false);
      };
      worker.onerror = (event) => {
        finish();
        report(`Export failed: ${event.message}`);
      };
      worker.onmessage = ({ data }) => {
        if (data.progress !== undefined) {
          get<HTMLProgressElement>("export-progress").value = data.progress;
          report(`Rendering WAV… ${Math.round(data.progress * 100)}%`);
          return;
        }
        finish();
        if (data.error) {
          report(`Export failed: ${data.error}`);
          return;
        }
        const blob = new Blob([data.bytes], {
          type: kind === "wav" ? "audio/wav" : "audio/midi",
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        const name =
          revision.name.replace(/[^a-zA-Z0-9._-]+/g, "-") || "muz-project";
        const scope = master
          ? "master"
          : selected.length === 1
            ? selected[0].replace(/[^a-zA-Z0-9._-]+/g, "-")
            : "mix";
        link.download = `${name}-${scope}.${kind === "wav" ? "wav" : "mid"}`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        report(
          data.clipped
            ? "Downloaded. Some samples clipped above 0 dBFS; lower the mix level and export again."
            : "Downloaded.",
        );
      };
      worker.postMessage({
        format: kind,
        snapshot: revision.snapshot,
        assets: kind === "wav" ? revision.assets : [],
        tracks: selected,
        rate: master
          ? 48000
          : Number(get<HTMLSelectElement>("export-rate").value),
        bits: master ? 24 : Number(get<HTMLSelectElement>("export-bits").value),
        start: from,
        end,
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
    this.worker?.terminate();
    this.worker = undefined;
    this.dialog?.close();
    this.dialog?.remove();
    this.dialog = undefined;
  }
}
