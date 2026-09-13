import { enableGraphPanning } from "./pan";
import { color } from "./theme";
export const escapeHTML = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const time = (seconds: number) =>
  `${Math.floor(Math.max(0, seconds) / 60)}:${Math.floor(
    Math.max(0, seconds) % 60,
  )
    .toString()
    .padStart(2, "0")}`;
export const pitch = (key: number) =>
  `${["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][key % 12]}${Math.floor(key / 12) - 1}`;

export class Arrangement {
  canvas = document.createElement("canvas");
  surface = document.createElement("div");
  cursor = document.createElement("div");
  meterLayer = document.createElement("div");
  views: any;
  end = 1;
  zoom = 1;
  readonly maxZoom = 512;
  width = 600;
  selected = "";
  beat = 0;
  follow = true;
  rows: { id: string; notes: any[]; ppq: number; min: number; max: number }[] =
    [];
  onSeek: (beat: number) => void = () => {};
  onSelect: (track: string, note?: any) => void = () => {};
  onNavigation: () => void = () => {};
  get scale() {
    return (Math.max(1, this.width - 142) * this.zoom) / this.end;
  }
  get visibleBeats() {
    return Math.max(1, this.width - 142) / this.scale;
  }
  beatAt(x: number) {
    return (x - 130 + this.parent.scrollLeft) / this.scale;
  }
  constructor(public parent: HTMLElement) {
    this.canvas.setAttribute(
      "aria-label",
      "Arrangement: drag to pan, click the ruler to seek, or click a note to inspect it",
    );
    this.canvas.setAttribute("role", "img");
    parent.tabIndex = 0;
    parent.setAttribute(
      "aria-label",
      "Arrangement navigation. Arrow keys pan, plus and minus zoom, Home fits the project.",
    );
    parent.classList.add("pannable");
    this.surface.className = "arrangement-surface";
    this.cursor.className = "playhead";
    this.meterLayer.className = "track-meters";
    this.surface.append(this.canvas);
    parent.append(this.surface, this.cursor, this.meterLayer);
    enableGraphPanning(parent, () => this.setFollow(false));
    let resizeFrame = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => this.draw());
    }).observe(parent);
    parent.addEventListener("scroll", () => this.draw(), { passive: true });
    parent.addEventListener("pointerdown", (event) => {
      const rect = parent.getBoundingClientRect();
      if (event.clientY >= rect.top + parent.clientHeight)
        this.setFollow(false);
    });
    parent.addEventListener(
      "wheel",
      (event) => {
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          const unit =
            event.deltaMode === 1
              ? 16
              : event.deltaMode === 2
                ? parent.clientHeight
                : 1;
          const delta = Math.max(-240, Math.min(240, event.deltaY * unit));
          this.setZoom(
            this.zoom * Math.exp(-delta * 0.008),
            event.clientX - parent.getBoundingClientRect().left,
          );
        } else if (event.shiftKey) {
          event.preventDefault();
          this.setFollow(false);
          parent.scrollLeft +=
            event.deltaX || event.deltaY * (event.deltaMode === 1 ? 16 : 1);
        } else if (event.deltaX) this.setFollow(false);
      },
      { passive: false },
    );
    parent.addEventListener("keydown", (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "+" || event.key === "=") this.setZoom(this.zoom * 2);
      else if (event.key === "-") this.setZoom(this.zoom / 2);
      else if (event.key === "Home") this.fit();
      else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        this.setFollow(false);
        parent.scrollLeft +=
          ((event.key === "ArrowLeft" ? -1 : 1) * (this.width - 142)) / 2;
      } else return;
      event.preventDefault();
    });
    this.canvas.addEventListener("click", (event) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left,
        y = event.clientY - rect.top;
      const beat = Math.max(0, Math.min(this.end, this.beatAt(x)));
      if (y < 58) {
        if (x >= 130) this.onSeek(beat);
        return;
      }
      const row = Math.floor((y - 58 + parent.scrollTop) / 56),
        track = this.rows[row];
      if (!track) return;
      this.selected = track.id;
      const top = 58 + row * 56 - parent.scrollTop;
      const note =
        x < 130
          ? undefined
          : track.notes.find((n) => {
              const noteY =
                top +
                43 -
                ((n.key - track.min) / Math.max(1, track.max - track.min)) * 31;
              return (
                Math.abs(y - noteY) <= 6 &&
                beat >= n.start_tick / track.ppq &&
                beat <=
                  (n.start_tick + n.duration_ticks) / track.ppq + 3 / this.scale
              );
            });
      this.onSelect(track.id, note);
      this.draw();
    });
  }
  reset() {
    this.views = undefined;
    this.rows = [];
    this.end = 1;
    this.beat = 0;
    this.zoom = 1;
    this.selected = "";
    this.parent.scrollLeft = 0;
    this.parent.scrollTop = 0;
    this.meterLayer.replaceChildren();
    this.draw();
    this.onNavigation();
  }
  set(views: any, end: number) {
    this.views = views;
    this.end = Math.max(1, end);
    this.rows = views.performance.map((t: any) => {
      const notes =
        t.notes ??
        t.source?.notes?.map((n: any) => ({
          start_tick: n.start_ticks,
          duration_ticks: n.duration_ticks,
          key: n.key,
          attack_velocity: n.velocity * 127,
        })) ??
        [];
      return {
        id: t.track,
        ppq: t.ppq ?? 960,
        notes,
        min: notes.reduce((n: number, note: any) => Math.min(n, note.key), 48),
        max: notes.reduce((n: number, note: any) => Math.max(n, note.key), 60),
      };
    });
    this.meterLayer.innerHTML = this.rows
      .map(
        (row, i) =>
          `<div class="track-meter" style="top:${58 + i * 56 + 36}px" title="${escapeHTML(row.id)} output peak"><span></span></div>`,
      )
      .join("");
    this.draw();
    this.onNavigation();
  }
  setZoom(value: number, anchorX = 130 + (this.width - 142) / 2) {
    anchorX = Math.max(130, Math.min(this.width - 12, anchorX));
    const anchorBeat = this.beatAt(anchorX);
    this.zoom = Math.max(1, Math.min(this.maxZoom, value));
    this.draw();
    this.parent.scrollLeft = anchorBeat * this.scale - (anchorX - 130);
    this.draw();
    this.onNavigation();
  }
  fit() {
    this.zoom = 1;
    this.parent.scrollLeft = 0;
    this.draw();
    this.onNavigation();
  }
  setFollow(value: boolean) {
    this.follow = value;
    if (value) this.centerPlayhead();
    this.onNavigation();
  }
  centerPlayhead() {
    this.parent.scrollLeft =
      Math.min(this.beat, this.end) * this.scale - (this.width - 142) / 2;
    this.draw();
  }
  reveal() {
    const x = 130 + this.beat * this.scale - this.parent.scrollLeft;
    if (x < 130 || x > this.width - 12) this.centerPlayhead();
  }
  meters(values: { id: string; peak: number }[]) {
    const lookup = new Map(values.map((v) => [v.id, v.peak]));
    this.rows.forEach((row, i) => {
      const span = this.meterLayer.children[i]
        ?.firstElementChild as HTMLElement | null;
      if (!span) return;
      const db = 20 * Math.log10(Math.max(0.00001, lookup.get(row.id) ?? 0));
      span.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
    });
  }
  position(beat: number, playing = false) {
    this.beat = beat;
    const available = this.width - 142;
    const x = beat * this.scale - this.parent.scrollLeft;
    if (playing && this.follow && (x < 0 || x > available * 0.8)) {
      this.parent.scrollLeft = beat * this.scale - available * 0.2;
      this.draw();
    } else this.drawCursor();
  }
  drawCursor() {
    const x =
      130 + Math.min(this.beat, this.end) * this.scale - this.parent.scrollLeft;
    this.cursor.hidden = !this.views || x < 130 || x > this.width - 12;
    this.cursor.style.left = `${x + this.parent.scrollLeft}px`;
    this.cursor.style.top = `${this.parent.scrollTop + 28}px`;
    this.cursor.style.height = `${Math.max(0, this.parent.clientHeight - 28)}px`;
  }
  draw() {
    if (this.parent.clientWidth === 0 || this.parent.clientHeight === 0) return;
    const width = (this.width = this.parent.clientWidth);
    const height = this.parent.clientHeight;
    const ratio = Math.min(2, devicePixelRatio);
    this.surface.style.width = `${142 + Math.max(1, width - 142) * this.zoom}px`;
    this.surface.style.height = `${Math.max(height, 58 + this.rows.length * 56)}px`;
    // Only allocate the visible bitmap, even when the timeline spans hundreds of thousands of pixels.
    if (this.canvas.width !== Math.round(width * ratio))
      this.canvas.width = Math.round(width * ratio);
    if (this.canvas.height !== Math.round(height * ratio))
      this.canvas.height = Math.round(height * ratio);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    const c = this.canvas.getContext("2d")!;
    c.setTransform(ratio, 0, 0, ratio, 0, 0);
    c.fillStyle = color("#080808");
    c.fillRect(0, 0, width, height);
    c.font = "11px Arial, sans-serif";
    c.lineWidth = 1;
    if (!this.views) {
      c.fillStyle = color("#999");
      c.fillText("Rebuild a project to see its performed arrangement.", 24, 48);
      this.drawCursor();
      return;
    }
    const scroll = this.parent.scrollLeft,
      vertical = this.parent.scrollTop;
    const x = (beat: number) => 130 + beat * this.scale - scroll;
    const start = Math.max(0, scroll / this.scale),
      end = Math.min(this.end, (scroll + width - 130) / this.scale);
    c.save();
    c.beginPath();
    c.rect(0, 58, width, height - 58);
    c.clip();
    this.rows.forEach((track, i) => {
      const top = 58 + i * 56 - vertical;
      if (top + 56 < 58 || top > height) return;
      if (track.id === this.selected) {
        c.fillStyle = color("#181818");
        c.fillRect(0, top, width, 56);
      }
      c.strokeStyle = color("#292929");
      c.beginPath();
      c.moveTo(0, top + 0.5);
      c.lineTo(width, top + 0.5);
      c.stroke();
      c.save();
      c.beginPath();
      c.rect(130, 58, width - 130, height - 58);
      c.clip();
      for (const note of track.notes) {
        const a = note.start_tick / track.ppq,
          b = (note.start_tick + note.duration_ticks) / track.ppq;
        if (b < start || a > end) continue;
        const y =
          top +
          43 -
          ((note.key - track.min) / Math.max(1, track.max - track.min)) * 31;
        c.fillStyle = color("#fff");
        c.globalAlpha = 0.25 + (note.attack_velocity / 127) * 0.7;
        c.fillRect(x(a), y, Math.max(1.5, (b - a) * this.scale), 2.5);
      }
      c.restore();
      c.fillStyle = color("#d0d0d0");
      c.save();
      c.beginPath();
      c.rect(8, top, 118, 56);
      c.clip();
      c.fillText(track.id, 12, top + 24);
      c.fillStyle = color("#747474");
      c.fillText(`${track.notes.length} notes`, 12, top + 40);
      c.restore();
    });
    c.restore();
    const meter = this.views.graph.transport.meter ?? [4, 4],
      bar = (meter[0] * 4) / meter[1];
    const grid = Math.min(bar, 2 ** Math.ceil(Math.log2(12 / this.scale)));
    const step =
      grid * this.scale < 12
        ? bar * 2 ** Math.ceil(Math.log2(12 / (bar * this.scale)))
        : grid;
    c.save();
    c.beginPath();
    c.rect(130, 28, width - 130, height - 28);
    c.clip();
    for (let b = Math.ceil(start / step) * step; b <= end; b += step) {
      c.strokeStyle = color(
        Math.abs(b / bar - Math.round(b / bar)) < 0.0001 ? "#292929" : "#222",
      );
      c.globalAlpha = 0.55;
      c.beginPath();
      c.moveTo(Math.round(x(b)) + 0.5, 36);
      c.lineTo(Math.round(x(b)) + 0.5, height);
      c.stroke();
    }
    c.restore();
    // The ruler and track names stay fixed while musical content pans beneath them.
    c.fillStyle = color("#080808");
    c.fillRect(0, 0, width, 58);
    c.save();
    c.beginPath();
    c.rect(130, 0, width - 130, 58);
    c.clip();
    for (const section of this.views.graph.extras.sections) {
      if (section.end < start || section.start > end) continue;
      c.save();
      c.beginPath();
      c.rect(
        Math.max(130, x(section.start)),
        0,
        x(section.end) - Math.max(130, x(section.start)),
        28,
      );
      c.clip();
      c.fillStyle = color("#121212");
      c.fillRect(
        x(section.start),
        0,
        x(section.end) - x(section.start) - 1,
        28,
      );
      c.fillStyle = color("#c9c9c9");
      c.fillText(
        section.name.replaceAll("_", " "),
        Math.max(130, x(section.start)) + 7,
        18,
      );
      c.restore();
    }
    const labelStep =
      this.scale >= 64
        ? 1
        : bar * Math.max(1, 2 ** Math.ceil(Math.log2(64 / (bar * this.scale))));
    for (
      let b = Math.ceil(start / labelStep) * labelStep;
      b <= end;
      b += labelStep
    ) {
      const measure = Math.floor(b / bar) + 1,
        beat = b % bar;
      c.fillStyle = color("#909090");
      c.fillText(
        beat === 0 ? `${measure}` : `${measure}.${beat + 1}`,
        x(b) + 5,
        47,
      );
    }
    c.restore();
    c.fillStyle = color("#888");
    c.fillText("PERFORMED", 12, 19);
    c.fillText("Bar · beat", 12, 47);
    this.meterLayer.style.left = `${scroll + 96}px`;
    Array.from(this.meterLayer.children).forEach((el, i) => {
      const y = 58 + i * 56 + 36 - vertical;
      (el as HTMLElement).hidden = y < 58 || y > height;
    });
    this.drawCursor();
  }
}

type Node = {
  id: string;
  label: string;
  sub: string;
  source?: string;
  x: number;
  y: number;
};
function network(
  nodes: Node[],
  edges: { from: string; to: string; label?: string }[],
  width: number,
  height: number,
) {
  const lookup = new Map(nodes.map((n) => [n.id, n]));
  return `<svg class="network" role="img" aria-label="Read-only signal graph" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--c-aaa)"/></marker></defs>
    ${edges
      .map((e) => {
        const a = lookup.get(e.from),
          b = lookup.get(e.to);
        if (!a || !b) return "";
        return `<path d="M${a.x + 132},${a.y + 24} C${a.x + 156},${a.y + 24} ${b.x - 24},${b.y + 24} ${b.x},${b.y + 24}" fill="none" stroke="var(--c-555)" stroke-width="1" ${e.label ? 'stroke-dasharray="3 3"' : ""} marker-end="url(#arrow)"><title>${escapeHTML(e.label ?? `${e.from} → ${e.to}`)}</title></path>`;
      })
      .join("")}
    ${nodes.map((n) => `<g ${n.source ? `data-source="${escapeHTML(n.source)}" tabindex="0" role="button" aria-label="Open source for ${escapeHTML(n.label)}"` : ""}><title>${escapeHTML(n.label + ": " + n.sub)}</title><rect x="${n.x}" y="${n.y}" width="132" height="48" fill="var(--c-101010)" stroke="var(--c-aaa)"/><rect x="${n.x - 2}" y="${n.y + 21}" width="4" height="6" fill="var(--c-ddd)"/><rect x="${n.x + 130}" y="${n.y + 21}" width="4" height="6" fill="var(--c-ddd)"/><text x="${n.x + 9}" y="${n.y + 19}" fill="var(--c-fff)">${escapeHTML(n.label.length > 19 ? n.label.slice(0, 18) + "…" : n.label)}</text><text x="${n.x + 9}" y="${n.y + 36}" fill="var(--c-8e8e8e)">${escapeHTML(n.sub.slice(0, 20))}</text></g>`).join("")}
  </svg>`;
}
export function patchGraph(patch: any, source: string) {
  if (!patch?.nodes)
    return '<p class="empty">Select a track with a native voice patch.</p>';
  const nodes: Node[] = [],
    edges: { from: string; to: string }[] = [];
  const ids = new Set(patch.nodes.map((n: any) => n.id));
  const depth = new Map<string, number>();
  const columnCounts = new Map<number, number>();
  for (const n of patch.nodes) {
    const refs = Object.entries(n)
      .filter(([k]) => !["id", "op", "name"].includes(k))
      .flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
      .filter((v) => typeof v === "string" && ids.has(v)) as string[];
    const column = Math.max(0, ...refs.map((ref) => (depth.get(ref) ?? 0) + 1));
    depth.set(n.id, column);
    const row = columnCounts.get(column) ?? 0;
    columnCounts.set(column, row + 1);
    nodes.push({
      id: n.id,
      label: n.id,
      sub: n.op + (n.wave ? ` · ${n.wave}` : ""),
      x: 24 + column * 182,
      y: 26 + row * 78,
      source,
    });
    for (const ref of refs) edges.push({ from: ref, to: n.id });
  }
  return network(
    nodes,
    edges,
    Math.max(...nodes.map((n) => n.x)) + 170,
    Math.max(...nodes.map((n) => n.y)) + 80,
  );
}
export function routingGraph(graph: any) {
  const nodes: Node[] = [],
    edges: { from: string; to: string; label?: string }[] = [];
  const outputs = new Map<string, string>();
  let widest = 0;
  const deviceChain = (
    devices: any[],
    x: number,
    y: number,
    input?: string,
    track?: string,
  ) => {
    let previous = input;
    devices.forEach((d: any, i: number) => {
      nodes.push({
        id: d.id,
        label: i === 0 && track ? track : d.id.split(".").at(-1),
        sub: d.kind.replace("builtin.", ""),
        x: x + i * 180,
        y,
        source: `device.${d.id}`,
      });
      if (previous) edges.push({ from: previous, to: d.id });
      if (d.sidechain)
        edges.push({ from: d.sidechain, to: d.id, label: "Sidechain" });
      previous = d.id;
    });
    return previous!;
  };
  const routes = (owner: any, from: string) => {
    if (owner.output) edges.push({ from, to: owner.output.to });
    for (const send of owner.sends)
      edges.push({
        from,
        to: send.to,
        label: `${send.gain_db} dB ${send.pre ? "pre-fader" : "post-fader"} send`,
      });
  };
  graph.tracks.forEach((t: any, i: number) => {
    const chain = [t.instrument, ...t.inserts];
    widest = Math.max(widest, chain.length);
    const output = deviceChain(chain, 24, 24 + i * 78, undefined, t.id);
    outputs.set(t.id, output);
    routes(t, output);
  });
  const busX = 24 + widest * 180;
  let busWidth = 1;
  const bus = (b: any, x: number, y: number, master = false) => {
    nodes.push({
      id: b.id,
      label: master ? "Master" : b.name || b.id,
      sub: "Sum",
      x,
      y,
      source: `bus.${b.id}`,
    });
    const output = deviceChain(b.inserts, x + 180, y, b.id);
    outputs.set(b.id, output);
    routes(b, output);
  };
  graph.buses.forEach((b: any, i: number) => {
    busWidth = Math.max(busWidth, b.inserts.length + 1);
    bus(b, busX, 24 + i * 90);
  });
  bus(graph.master, busX + busWidth * 180, 24, true);
  // Sidechain names identify audio sources, not device IDs.
  for (const edge of edges)
    if (edge.label === "Sidechain")
      edge.from = outputs.get(edge.from) ?? edge.from;
  return network(
    nodes,
    edges,
    Math.max(0, ...nodes.map((n) => n.x)) + 170,
    Math.max(300, graph.tracks.length * 78 + 48, graph.buses.length * 90 + 48),
  );
}
export function automationValue(lane: any, seconds: number) {
  let i = 0;
  while (i + 1 < lane.points.length && lane.points[i + 1].seconds <= seconds)
    i++;
  const a = lane.points[i],
    b = lane.points[i + 1];
  if (!b || seconds <= a.seconds || lane.shape === "step") return a.value;
  let t = Math.max(
    0,
    Math.min(1, (seconds - a.seconds) / (b.seconds - a.seconds)),
  );
  if (lane.shape === "smooth") t = t * t * (3 - 2 * t);
  return a.value + (b.value - a.value) * t;
}
export function automationView(lanes: any[], duration: number) {
  if (!lanes.length)
    return '<p class="empty">This project has no automation lanes.</p>';
  return lanes
    .map((lane) => {
      const values = lane.points.map((p: any) => p.value),
        min = Math.min(...values),
        max = Math.max(...values);
      const x = (p: any) => 12 + (p.seconds / duration) * 676,
        y = (p: any) => 70 - ((p.value - min) / (max - min || 1)) * 50;
      const path = lane.points
        .map((p: any, i: number) => {
          if (i === 0) return `M${x(p)},${y(p)}`;
          const previous = lane.points[i - 1];
          if (lane.shape === "step") return `H${x(p)} V${y(p)}`;
          if (lane.shape === "smooth") {
            const dx = (x(p) - x(previous)) / 3;
            return `C${x(previous) + dx},${y(previous)} ${x(p) - dx},${y(p)} ${x(p)},${y(p)}`;
          }
          return `L${x(p)},${y(p)}`;
        })
        .join(" ");
      return `<div class="automation-lane"><div><strong>${escapeHTML(lane.target)}</strong><span><output class="automation-value">${lane.points[0].value.toFixed(3)}</output> · ${escapeHTML(lane.shape)} · ${min.toFixed(2)} — ${max.toFixed(2)}</span></div><svg viewBox="0 0 700 86" role="img" aria-label="${escapeHTML(lane.target)} control points"><path d="M12 70H688" stroke="var(--c-333)"/><path d="${path}" fill="none" stroke="var(--c-eee)" stroke-width="1.2"/>${lane.points.map((p: any) => `<circle cx="${x(p)}" cy="${y(p)}" r="2.5" fill="var(--c-fff)"><title>${p.seconds.toFixed(2)} s: ${p.value}</title></circle>`).join("")}<line class="automation-cursor" x1="12" x2="12" y1="8" y2="78" stroke="var(--c-777)"/></svg></div>`;
    })
    .join("");
}
