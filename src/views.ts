import {
  arrangementRows,
  hitDensity,
  type ArrangementRow,
  type ArrangementViews,
  type ArrangementGraph,
  type PerformedNote,
} from "./arrangement-layout";
import { enableGraphPanning } from "./pan";
import { color } from "./theme";
import { AuditionState } from "./audition";
import type { RevisionRef, AnalysisFrame } from "./host/contracts";
import { spectrumPixelBins, displaySmoothingAlpha } from "./analysis-layout";
import { coversArrangementRange } from "./inspection";
export const ARRANGEMENT_GUTTER = 154;

export type ArrangementTarget = {
  key: string; start: number; end: number; scale: number; scrollLeft: number; scrollTop: number;
  width: number; height: number; zoom: number; layoutGeneration: number; navigationGeneration: number;
  tracks: string[]; groups: { id: string; members: string[] }[]; follow: boolean;
};
export type ArrangementFrame = {
  ref: RevisionRef; views: ArrangementViews; end: number; target: ArrangementTarget;
  coverage: { start: number; end: number; span: number }; coveredTracks: Set<string>; coveredGroups: Set<string>;
};
const sameRevision = (a: RevisionRef | undefined, b: RevisionRef | undefined) =>
  !!a && !!b && a.project === b.project && a.epoch === b.epoch && a.engineEpoch === b.engineEpoch &&
  a.revision === b.revision && a.sourceVersion === b.sourceVersion && a.entry === b.entry;
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
  groupLayer = document.createElement("div");
  auditionLayer = document.createElement("div");
  audition = new AuditionState();
  private controlsLayout = "";
  onAudition: (muted: string[], solo: string[]) => void = () => {};
  onPresented: () => void = () => {};
  onPending: () => void = () => {};
  collapsed = new Set<string>();
  views?: ArrangementViews;
  end = 1;
  zoom = 1;
  readonly maxZoom = 512;
  width = 600;
  selected = "";
  private selectedNoteId = "";
  beat = 0;
  follow = true;
  private visible = true;
  private playing = false;
  private retainedScroll: { left: number; top: number } | null = null;
  private lastVisibleScroll = { left: 0, top: 0 };
  private latestMeters: { id: string; peak: number }[] = [];
  private desiredRef?: RevisionRef;
  private frame?: ArrangementFrame;
  private drawFrame = 0;
  private navigationFrame = 0;
  private layoutGeneration = 0;
  private navigationGeneration = 0;
  private internalScroll?: { left: number; top: number };
  private pending = false;
  private prepared?: ArrangementFrame;
  private preparedScroll?: { ref: RevisionRef; target: ArrangementTarget };
  private desiredTarget?: ArrangementTarget;
  private geometryGraph?: ArrangementGraph;
  private geometryCollapsed = "";
  private geometryRows: ArrangementRow[] = [];
  private telemetryFrame = 0;
  get identityActionsEnabled() {
    const target = this.frame?.target;
    return sameRevision(this.desiredRef, this.frame?.ref) && !this.pending && !!target &&
      target.width === this.parent.clientWidth && target.height === this.parent.clientHeight &&
      target.scrollLeft === this.parent.scrollLeft && target.scrollTop === this.parent.scrollTop &&
      target.scale === this.scale;
  }
  get displayedRef() { return this.frame?.ref; }
  private get canDraw() {
    return this.visible && this.parent.clientWidth > 0 && this.parent.clientHeight > 0;
  }
  rows: ArrangementRow[] = [];
  get densityMode() {
    return this.scale < 24;
  }
  onSeek: (beat: number) => void = () => {};
  onSelect: (track: string, note?: PerformedNote) => void = () => {};
  onNavigation: () => void = () => {};
  onFollowScroll: (scrollLeft: number) => void = () => {};
  get scale() {
    return (Math.max(1, this.width - ARRANGEMENT_GUTTER - 12) * this.zoom) / this.end;
  }
  get visibleBeats() {
    return Math.max(1, this.width - ARRANGEMENT_GUTTER) / this.scale;
  }
  visibleRange(scrollLeft = this.parent.scrollLeft) {
    const start = Math.max(0, scrollLeft / this.scale);
    return { start, end: Math.min(this.end, start + this.visibleBeats) };
  }
  visibleTrackIds() {
    const top = this.parent.scrollTop;
    const bottom = top + this.parent.clientHeight;
    return this.rows
      .filter((row) => row.top + row.height >= top + 58 && row.top <= bottom)
      .flatMap((row) =>
        row.kind === "group" ? (row.members ?? []) : [row.id],
      );
  }
  beatAt(x: number) {
    return (x - ARRANGEMENT_GUTTER + this.parent.scrollLeft) / this.scale;
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
      "Arrangement. Left and right pan; up and down select tracks; brackets select visible notes; Enter inspects a note; plus and minus zoom; Home fits.",
    );
    parent.classList.add("pannable");
    this.surface.className = "arrangement-surface";
    this.cursor.className = "playhead";
    this.meterLayer.className = "track-meters";
    this.surface.append(this.canvas);
    this.groupLayer.className = "kit-groups";
    parent.append(this.surface, this.cursor, this.meterLayer, this.groupLayer);
    this.auditionLayer.className = "track-audition";
    parent.append(this.auditionLayer);
    enableGraphPanning(parent, () => this.setFollow(false));
    let resizeFrame = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (!this.canDraw) return;
        this.navigationGeneration++;
        if (this.desiredRef) this.markPending();
        this.redraw();
        this.onNavigation();
      });
    }).observe(parent);
    parent.addEventListener(
      "scroll",
      () => {
        if (!this.canDraw) return;
        this.lastVisibleScroll.left = this.parent.scrollLeft;
        this.lastVisibleScroll.top = this.parent.scrollTop;
        const internal = this.internalScroll;
        this.internalScroll = undefined;
        if (internal && internal.left === this.parent.scrollLeft && internal.top === this.parent.scrollTop) {
          this.draw();
          return;
        }
        this.navigationGeneration++;
        this.markPending();
        this.draw();
        this.scheduleNavigation();
      },
      { passive: true },
    );
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
      if (event.target !== parent && event.target !== this.canvas) return;
      if (event.key === "+" || event.key === "=") this.setZoom(this.zoom * 2);
      else if (event.key === "-") this.setZoom(this.zoom / 2);
      else if (event.key === "Home") this.fit();
      else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        this.setFollow(false);
        parent.scrollLeft +=
          ((event.key === "ArrowLeft" ? -1 : 1) * (this.width - ARRANGEMENT_GUTTER - 12)) / 2;
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        if (!this.identityActionsEnabled) return;
        const tracks = this.rows.filter((row) => row.kind !== "group");
        const current = tracks.findIndex((row) => row.id === this.selected);
        const index = Math.max(0, Math.min(tracks.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
        const track = tracks[index];
        if (!track) return;
        this.selected = track.id; this.selectedNoteId = ""; this.onSelect(track.id);
        if (track.top < parent.scrollTop + 58) parent.scrollTop = Math.max(0, track.top - 58);
        else if (track.top + track.height > parent.scrollTop + parent.clientHeight)
          parent.scrollTop = track.top + track.height - parent.clientHeight;
        this.draw();
      } else if (event.key === "[" || event.key === "]" || event.key === "Enter") {
        if (!this.identityActionsEnabled) return;
        const track = this.rows.find((row) => row.id === this.selected && row.kind !== "group");
        if (!track) return;
        const range = this.visibleRange();
        const notes = track.notes.filter((note) => note.start_tick / track.ppq <= range.end &&
          (track.kind === "kit" ? note.start_tick / track.ppq : (note.start_tick + note.duration_ticks) / track.ppq) >= range.start);
        const current = notes.findIndex((note) => note.id === this.selectedNoteId);
        const index = event.key === "Enter" ? Math.max(0, current) :
          Math.max(0, Math.min(notes.length - 1, current + (event.key === "]" ? 1 : -1)));
        const note = notes[index];
        if (!note) return;
        this.selectedNoteId = note.id ?? ""; this.onSelect(track.id, note); this.draw();
      } else return;
      event.preventDefault();
    });
    this.canvas.addEventListener("click", (event) => {
      if (!this.identityActionsEnabled) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left,
        y = event.clientY - rect.top;
      const beat = Math.max(0, Math.min(this.end, this.beatAt(x)));
      if (y < 58) {
        if (x >= ARRANGEMENT_GUTTER) this.onSeek(beat);
        return;
      }
      const track = this.rows.find(
        (row) =>
          y + parent.scrollTop >= row.top &&
          y + parent.scrollTop < row.top + row.height,
      );
      if (!track) return;
      if (track.kind === "group") {
        if (x >= ARRANGEMENT_GUTTER) this.onSeek(beat);
        else this.toggleGroup(track.id);
        return;
      }
      this.selected = track.id;
      const top = track.top - parent.scrollTop;
      let note: PerformedNote | undefined;
      if (x >= ARRANGEMENT_GUTTER && track.kind === "kit") {
        // Select the nearest onset, including markers that extend left of their exact beat.
        const candidates = track.notes.filter(
          (n) => Math.abs((n.start_tick / track.ppq - beat) * this.scale) <= 6,
        );
        if (Math.abs(y - (top + 14)) <= 11)
          note = candidates.sort(
            (a, b) =>
              Math.abs(a.start_tick / track.ppq - beat) -
              Math.abs(b.start_tick / track.ppq - beat),
          )[0];
      } else if (x >= ARRANGEMENT_GUTTER) {
        let distance = Infinity;
        for (const candidate of track.notes) {
          const noteY = top + 43 -
            ((candidate.key - track.min) / Math.max(1, track.max - track.min)) * 31;
          const verticalDistance = Math.abs(y - (noteY + 1.25));
          const start = candidate.start_tick / track.ppq;
          const end = Math.max((candidate.start_tick + candidate.duration_ticks) / track.ppq,
            start + 1.5 / this.scale);
          if (verticalDistance <= 6 && verticalDistance < distance && beat >= start && beat <= end + 3 / this.scale) {
            distance = verticalDistance; note = candidate;
          }
        }
      }
      this.onSelect(track.id, note);
      this.selectedNoteId = note?.id ?? "";
      this.draw();
    });
  }
  setVisible(visible: boolean) {
    if (visible === this.visible) return;
    if (!visible) {
      // Pane CSS/media-query changes can hide the DOM before this notification,
      // at which point browser scroll offsets have already become zero.
      this.retainedScroll = this.canDraw
        ? { left: this.parent.scrollLeft, top: this.parent.scrollTop }
        : { ...this.lastVisibleScroll };
    }
    this.visible = visible;
    if (visible) {
      this.redraw();
      if (this.canDraw) this.onNavigation();
    }
  }
  private scheduleNavigation() {
    if (this.navigationFrame || !this.canDraw) return;
    this.navigationFrame = requestAnimationFrame(() => {
      this.navigationFrame = 0;
      if (this.canDraw) this.onNavigation();
    });
  }
  beginRevision(ref: RevisionRef) {
    this.desiredRef = { ...ref };
    this.markPending();
  }
  markPending() {
    this.pending = true;
    this.parent.dataset.inspectionState = this.frame && !sameRevision(this.desiredRef, this.frame.ref) ? "previous-revision" : "pending";
    this.auditionLayer.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { button.disabled = true; });
    this.groupLayer.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { button.disabled = true; });
    this.onPending();
    this.draw();
  }
  private structuralRows(views: ArrangementViews) {
    const collapsed = [...this.collapsed].sort().join("\0");
    if (this.geometryGraph !== views.graph || this.geometryCollapsed !== collapsed) {
      this.geometryGraph = views.graph; this.geometryCollapsed = collapsed;
      this.geometryRows = arrangementRows(views, this.collapsed);
    }
    return this.geometryRows;
  }
  target(views: ArrangementViews, end: number, followScrollLeft?: number): ArrangementTarget {
    const width = this.parent.clientWidth || this.width;
    const height = this.parent.clientHeight;
    const scale = Math.max(1, width - ARRANGEMENT_GUTTER - 12) * this.zoom / Math.max(1, end);
    const contentWidth = ARRANGEMENT_GUTTER + 12 + Math.max(1, width - ARRANGEMENT_GUTTER - 12) * this.zoom;
    const scrollLeft = followScrollLeft ?? (this.retainedScroll
      ? Math.min(this.retainedScroll.left, Math.max(0, contentWidth - width))
      : this.parent.scrollLeft);
    const structuralRows = this.structuralRows(views);
    const lastRow = structuralRows.at(-1);
    const contentHeight = Math.max(height, (lastRow?.top ?? 58) + (lastRow?.height ?? 0));
    const scrollTop = Math.min(this.retainedScroll?.top ?? this.parent.scrollTop, Math.max(0, contentHeight - height));
    const start = Math.max(0, scrollLeft / scale);
    const finish = Math.min(end, start + Math.max(1, width - ARRANGEMENT_GUTTER) / scale);
    const rows = structuralRows.filter((row) =>
      row.top + row.height >= scrollTop + 58 && row.top <= scrollTop + height);
    const groups = rows.filter((row) => row.kind === "group" && this.collapsed.has(row.id))
      .map((row) => ({ id: row.id, members: row.members ?? [] }));
    const tracks = [...new Set(rows.flatMap((row) => row.kind === "group"
      ? (this.collapsed.has(row.id) ? row.members ?? [] : []) : [row.id]))];
    const key = JSON.stringify([start, finish, scrollTop, width, height, this.zoom, this.layoutGeneration,
      this.navigationGeneration, tracks, groups]);
    return { key, start, end: finish, scale, scrollLeft, scrollTop, width, height, zoom: this.zoom,
      layoutGeneration: this.layoutGeneration, navigationGeneration: this.navigationGeneration,
      tracks, groups, follow: followScrollLeft !== undefined };
  }
  setDesiredTarget(target?: ArrangementTarget) {
    this.desiredTarget = target;
    if (!target || this.prepared?.target.key !== target.key) this.prepared = undefined;
    if (!target || this.preparedScroll?.target.key !== target.key) this.preparedScroll = undefined;
  }
  targetMatches(target: ArrangementTarget, views: ArrangementViews, end: number) {
    if (target.follow && !this.follow) return false;
    return this.target(views, end, target.follow ? target.scrollLeft : undefined).key === target.key;
  }
  isCovered(target: ArrangementTarget) {
    const frame = this.frame;
    return !!frame && sameRevision(this.desiredRef, frame.ref) &&
      frame.target.layoutGeneration === target.layoutGeneration &&
      (frame.target.scale < 24) === (target.scale < 24) &&
      coversArrangementRange(frame.coverage, target, frame.end) &&
      target.tracks.every((id) => frame.coveredTracks.has(id) || target.groups.some((group) =>
        frame.coveredGroups.has(group.id) && group.members.includes(id)));
  }
  commitScroll(target: ArrangementTarget) {
    if (!this.desiredRef || !this.isCovered(target)) return;
    this.prepared = undefined;
    this.preparedScroll = { ref: this.desiredRef, target };
    this.draw();
  }
  commitFrame(frame: ArrangementFrame) {
    if (!sameRevision(this.desiredRef, frame.ref)) return;
    this.prepared = frame;
    this.draw();
  }
  redraw() {
    if (!this.canDraw) return;
    this.draw();
    this.position(this.beat, this.playing);
    this.meters(this.latestMeters);
  }
  reset() {
    this.views = undefined;
    this.frame = undefined; this.desiredRef = undefined; this.pending = false;
    this.prepared = undefined; this.preparedScroll = undefined;
    this.desiredTarget = undefined;
    this.geometryGraph = undefined; this.geometryRows = [];
    this.layoutGeneration++; this.navigationGeneration++;
    this.parent.removeAttribute("data-displayed-revision");
    this.rows = [];
    this.end = 1;
    this.beat = 0;
    this.playing = false;
    this.retainedScroll = null;
    this.lastVisibleScroll.left = 0; this.lastVisibleScroll.top = 0;
    this.latestMeters = [];
    this.zoom = 1;
    this.selected = "";
    this.parent.scrollLeft = 0;
    this.parent.scrollTop = 0;
    this.meterLayer.replaceChildren();
    this.groupLayer.replaceChildren();
    this.auditionLayer.replaceChildren();
    this.audition.clear();
    this.controlsLayout = "";
    this.collapsed.clear();
    this.draw();
    if (this.canDraw) this.onNavigation();
  }
  toggleGroup(id: string) {
    if (!this.identityActionsEnabled && this.frame) return;
    this.layoutGeneration++; this.navigationGeneration++;
    this.markPending();
    if (this.collapsed.has(id)) this.collapsed.delete(id);
    else this.collapsed.add(id);
    this.layout();
    this.draw();
    if (this.canDraw) this.onNavigation();
  }
  layout() {
    if (!this.views) return;
    this.rows = this.structuralRows(this.views);
    const performance = new Map(this.views.performance.map((track) => [track.track, track]));
    const physicalRows = new Set(this.rows.flatMap((row) => row.memberRows ?? [row]));
    for (const row of physicalRows) {
      const track = performance.get(row.id);
      row.notes = track?.notes ?? []; row.overview = track?.overview;
      row.pending = track?.pending ?? !track; row.ppq = track?.ppq ?? 960_000;
    }
    for (const row of this.rows) {
      if (row.kind !== "group") continue;
      row.overview = this.views.groupOverviews?.[row.id];
      row.pending = this.collapsed.has(row.id) && !row.overview && !!row.memberRows?.some((member) => member.pending);
    }
    this.audition.retain((this.views.graph.tracks ?? []).map((track) => track.id));
    this.renderControls();
  }
  private renderControls() {
    const focused = (document.activeElement as HTMLElement)?.dataset.kit;
    const visibleRows = this.rows.filter((row) => row.top + row.height >= this.parent.scrollTop + 58 &&
      row.top <= this.parent.scrollTop + this.parent.clientHeight);
    const controlsLayout = JSON.stringify(
      visibleRows.map((row) => [
        row.id,
        row.kind,
        row.label,
        row.top,
        row.height,
        row.members,
        this.collapsed.has(row.id),
      ]),
    );
    // Detail refreshes must not replace buttons between pointerdown and click.
    if (controlsLayout === this.controlsLayout) return;
    this.controlsLayout = controlsLayout;
    this.renderAudition();
    this.meterLayer.innerHTML = visibleRows
      .map(
        (row) =>
          `<div class="track-meter" data-track="${escapeHTML(row.id)}" style="left:${row.kind === "kit" ? -64 : 0}px;top:${row.top + (row.kind === "kit" ? 32 : 36)}px" title="${escapeHTML(row.id)} output peak"><span></span></div>`,
      )
      .join("");
    this.groupLayer.innerHTML = visibleRows
      .filter((row) => row.kind === "group")
      .map(
        (row) =>
          `<button data-kit="${escapeHTML(row.id)}" style="top:${row.top}px" aria-label="${this.collapsed.has(row.id) ? "Expand" : "Collapse"} ${escapeHTML(row.label)} kit" aria-expanded="${!this.collapsed.has(row.id)}" title="${escapeHTML(row.label)} · ${row.members!.length} lanes"><span aria-hidden="true">${this.collapsed.has(row.id) ? "▸" : "▾"}</span> ${escapeHTML(row.label)} <small>Kit</small></button>`,
      )
      .join("");
    this.groupLayer
      .querySelectorAll<HTMLButtonElement>("[data-kit]")
      .forEach((button) => {
        button.onclick = () => this.toggleGroup(button.dataset.kit!);
        button.onkeydown = (e) => {
          if (["ArrowLeft", "ArrowRight", "Home"].includes(e.key))
            e.stopPropagation();
        };
        if (button.dataset.kit === focused)
          button.focus({ preventScroll: true });
      });
    if (!this.identityActionsEnabled) this.groupLayer.querySelectorAll<HTMLButtonElement>("button")
      .forEach((button) => { button.disabled = true; });
  }
  renderAudition() {
    const focused = (document.activeElement as HTMLElement)?.dataset
      .auditionKey;
    this.auditionLayer.innerHTML = this.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.top + row.height >= this.parent.scrollTop + 58 && row.top <= this.parent.scrollTop + this.parent.clientHeight)
      .map(({ row, index }) => {
        const ids = row.kind === "group" ? row.members! : [row.id];
        return `<div data-audition-row="${index}" style="top:${row.top + 4}px">${(
          ["muted", "solo"] as const
        )
          .map((kind) => {
            const label = `${kind === "muted" ? "Mute" : "Solo"} ${row.id}${row.kind === "group" ? " kit" : ""}`;
            return `<button data-audition="${kind}" data-row="${index}" data-audition-key="${escapeHTML(`${kind}:${row.id}`)}" aria-label="${escapeHTML(label)}" title="${escapeHTML(label)}" aria-pressed="${this.audition.state(kind, ids)}" ${ids.length && this.identityActionsEnabled ? "" : "disabled"}>${kind === "muted" ? "M" : "S"}</button>`;
          })
          .join("")}</div>`;
      })
      .join("");
    this.auditionLayer
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((button) => {
        button.onclick = () => {
          if (!this.identityActionsEnabled) return;
          const row = this.rows[Number(button.dataset.row)];
          this.audition.toggle(
            button.dataset.audition as "muted" | "solo",
            row.kind === "group" ? row.members! : [row.id],
          );
          this.renderAudition();
          this.draw();
          this.onAudition([...this.audition.muted], [...this.audition.solo]);
        };
        button.onkeydown = (event) => event.stopPropagation();
        if (button.dataset.auditionKey === focused)
          button.focus({ preventScroll: true });
      });
  }
  private resizeSurfaceWidth() {
    this.surface.style.width = `${ARRANGEMENT_GUTTER + 12 + Math.max(1, this.width - ARRANGEMENT_GUTTER - 12) * this.zoom}px`;
  }
  setZoom(value: number, anchorX = ARRANGEMENT_GUTTER + (this.width - ARRANGEMENT_GUTTER - 12) / 2) {
    if (this.canDraw) this.width = this.parent.clientWidth;
    anchorX = Math.max(ARRANGEMENT_GUTTER, Math.min(this.width - 12, anchorX));
    const anchorBeat = this.beatAt(anchorX);
    this.layoutGeneration++; this.navigationGeneration++;
    this.markPending();
    this.zoom = Math.max(1, Math.min(this.maxZoom, value));
    // Expand the actual scrollable surface before applying the new anchor;
    // otherwise the browser clamps a zoom-in against the previous width.
    this.resizeSurfaceWidth();
    this.draw();
    this.parent.scrollLeft = anchorBeat * this.scale - (anchorX - ARRANGEMENT_GUTTER);
    this.draw();
    this.onNavigation();
  }
  fit() {
    this.zoom = 1;
    this.layoutGeneration++; this.navigationGeneration++;
    this.markPending();
    this.parent.scrollLeft = 0;
    this.draw();
    this.onNavigation();
  }
  setFollow(value: boolean) {
    this.navigationGeneration++;
    this.follow = value;
    if (value) this.centerPlayhead();
    this.onNavigation();
  }
  centerPlayhead() {
    if (!this.canDraw) return;
    this.parent.scrollLeft =
      Math.min(this.beat, this.end) * this.scale - (this.width - ARRANGEMENT_GUTTER - 12) / 2;
    this.draw();
  }
  reveal() {
    if (!this.canDraw) return;
    const x = ARRANGEMENT_GUTTER + this.beat * this.scale - this.parent.scrollLeft;
    if (x < ARRANGEMENT_GUTTER || x > this.width - 12) this.centerPlayhead();
  }
  meters(values: { id: string; peak: number }[]) {
    this.latestMeters = values;
    this.scheduleTelemetry();
  }
  private scheduleTelemetry() {
    if (!this.canDraw || this.telemetryFrame) return;
    this.telemetryFrame = requestAnimationFrame(() => {
      this.telemetryFrame = 0;
      if (!this.canDraw) return;
      const lookup = new Map(this.latestMeters.map((value) => [value.id, value.peak]));
      this.meterLayer.querySelectorAll<HTMLElement>("[data-track]").forEach((element) => {
        const span = element.firstElementChild as HTMLElement | null;
        if (!span) return;
        const db = 20 * Math.log10(Math.max(0.00001, lookup.get(element.dataset.track ?? "") ?? 0));
        span.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
      });
      this.drawCursor();
    });
  }
  position(beat: number, playing = false) {
    this.beat = beat;
    this.playing = playing;
    if (!this.canDraw) return;
    const available = this.width - ARRANGEMENT_GUTTER - 12;
    const x = beat * this.scale - this.parent.scrollLeft;
    if (playing && this.follow && (x < 0 || x > available * 0.8)) {
      const scrollLeft = Math.max(
        0,
        Math.min(
          this.parent.scrollWidth - this.parent.clientWidth,
          beat * this.scale - available * 0.2,
        ),
      );
      if (scrollLeft !== this.parent.scrollLeft)
        this.onFollowScroll(scrollLeft);
    }
    this.scheduleTelemetry();
  }
  drawCursor() {
    if (!this.canDraw) return;
    const x =
      ARRANGEMENT_GUTTER + Math.min(this.beat, this.end) * this.scale - this.parent.scrollLeft;
    this.cursor.hidden = !this.views || x < ARRANGEMENT_GUTTER || x > this.width - 12;
    this.cursor.style.left = `${x + this.parent.scrollLeft}px`;
    this.cursor.style.top = `${this.parent.scrollTop + 28}px`;
    this.cursor.style.height = `${Math.max(0, this.parent.clientHeight - 28)}px`;
  }
  draw() {
    if (this.drawFrame || !this.canDraw) return;
    this.drawFrame = requestAnimationFrame(() => {
      this.drawFrame = 0;
      this.paint();
    });
  }
  requestDraw() { this.draw(); }
  private paint() {
    if (!this.canDraw) return;
    const width = (this.width = this.parent.clientWidth);
    let presented = false;
    const prepared = this.prepared;
    if (prepared) {
      this.prepared = undefined;
      if (sameRevision(this.desiredRef, prepared.ref) && prepared.target.key === this.desiredTarget?.key &&
        this.targetMatches(prepared.target, prepared.views, prepared.end)) {
        this.frame = prepared; this.views = prepared.views; this.end = Math.max(1, prepared.end);
        this.pending = false; this.layout(); presented = true;
        if (prepared.target.follow) this.preparedScroll = { ref: prepared.ref, target: prepared.target };
        this.parent.dataset.displayedRevision = prepared.ref.revision;
        this.parent.dataset.inspectionState = "ready";
        const modes = new Set(prepared.views.performance.filter((track) => !track.pending).map((track) => track.representation));
        this.parent.dataset.representation = modes.size > 1 ? "mixed" : modes.has("detail") ? "detail" : "overview";
      }
    }
    const height = this.parent.clientHeight;
    const ratio = Math.min(2, devicePixelRatio);
    this.resizeSurfaceWidth();
    const contentHeight = Math.max(height, (this.rows.at(-1)?.top ?? 58) + (this.rows.at(-1)?.height ?? 0));
    const previousTop = this.parent.scrollTop;
    this.surface.style.height = `${contentHeight}px`;
    // Absolute controls/playhead can keep scrollHeight larger than a shrinking
    // surface. Clamp to the actual row extent, not that stale overflow, so the
    // viewport-sized sticky bitmap cannot slide above its container's bottom.
    this.parent.scrollTop = Math.min(this.parent.scrollTop, Math.max(0, contentHeight - height));
    if (this.parent.scrollTop !== previousTop)
      this.internalScroll = { left: this.parent.scrollLeft, top: this.parent.scrollTop };
    if (this.retainedScroll) {
      this.parent.scrollLeft = Math.min(this.retainedScroll.left, Math.max(0, this.surface.offsetWidth - width));
      this.parent.scrollTop = Math.min(this.retainedScroll.top, Math.max(0, contentHeight - height));
      this.retainedScroll = null;
    }
    const scrollIntent = this.preparedScroll;
    this.preparedScroll = undefined;
    if (scrollIntent && this.views && sameRevision(this.desiredRef, scrollIntent.ref) &&
      scrollIntent.target.key === this.desiredTarget?.key && this.targetMatches(scrollIntent.target, this.views, this.end) &&
      this.isCovered(scrollIntent.target)) {
      if (this.parent.scrollLeft !== scrollIntent.target.scrollLeft) {
        const left = this.parent.scrollLeft, top = this.parent.scrollTop;
        this.parent.scrollLeft = scrollIntent.target.scrollLeft;
        this.internalScroll = this.parent.scrollLeft === left ? undefined : { left: this.parent.scrollLeft, top };
      }
      const target = this.target(this.views, this.end);
      if (this.frame && this.isCovered(target)) {
        this.frame = { ...this.frame, target };
        this.pending = false; this.parent.dataset.inspectionState = "ready"; presented = true;
      }
    }
    this.lastVisibleScroll.left = this.parent.scrollLeft;
    this.lastVisibleScroll.top = this.parent.scrollTop;
    if (this.views) this.renderControls();
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
      c.fillStyle = color("text-muted");
      c.fillText("Rebuild a project to see its performed arrangement.", 24, 48);
      this.drawCursor();
      return;
    }
    const scroll = this.parent.scrollLeft,
      vertical = this.parent.scrollTop;
    const x = (beat: number) => ARRANGEMENT_GUTTER + beat * this.scale - scroll;
    const { start, end } = this.visibleRange(scroll);
    const meter = this.views.graph.transport.meter ?? [4, 4],
      bar = (meter[0] * 4) / meter[1];
    const grid = Math.min(bar, 2 ** Math.ceil(Math.log2(12 / this.scale)));
    const step =
      grid * this.scale < 12
        ? bar * 2 ** Math.ceil(Math.log2(12 / (bar * this.scale)))
        : grid;
    c.save();
    c.beginPath();
    c.rect(0, 58, width, height - 58);
    c.clip();
    // Lane shading first: the grid is a backdrop guide, never a splitter.
    for (const track of this.rows) {
      const top = track.top - vertical;
      if (top + track.height < 58 || top > height) continue;
      if (track.kind === "group") {
        c.fillStyle = color("#151515");
        c.fillRect(0, top, width, track.height);
      }
      if (
        track.id === this.selected ||
        track.members?.includes(this.selected)
      ) {
        c.fillStyle = color("#181818");
        c.fillRect(0, top, width, track.height);
      }
      c.strokeStyle = color("#292929");
      c.beginPath();
      c.moveTo(0, top + 0.5);
      c.lineTo(width, top + 0.5);
      c.stroke();
    }
    c.save();
    c.beginPath();
    c.rect(ARRANGEMENT_GUTTER, 58, width - ARRANGEMENT_GUTTER, height - 58);
    c.clip();
    for (let b = Math.ceil(start / step) * step; b <= end; b += step) {
      c.strokeStyle = color(
        Math.abs(b / bar - Math.round(b / bar)) < 0.0001 ? "#292929" : "#222",
      );
      c.globalAlpha = 0.55;
      c.beginPath();
      c.moveTo(Math.round(x(b)) + 0.5, 58);
      c.lineTo(Math.round(x(b)) + 0.5, height);
      c.stroke();
    }
    c.globalAlpha = 1;
    c.restore();
    // Notes and lane text overlay the grid so a bar line never cuts a hit in half.
    for (const track of this.rows) {
      const top = track.top - vertical;
      if (top + track.height < 58 || top > height) continue;
      c.save();
      c.beginPath();
      c.rect(ARRANGEMENT_GUTTER, 58, width - ARRANGEMENT_GUTTER, height - 58);
      c.clip();
      if (track.kind === "group" && !this.collapsed.has(track.id)) {
        c.fillStyle = color("text-muted");
        c.fillText(
          `${track.members!.length} lanes`,
          ARRANGEMENT_GUTTER + 10,
          top + 20,
        );
      } else if (track.pending || (this.frame && (start < this.frame.coverage.start || end > this.frame.coverage.end))) {
        c.fillStyle = color("text-muted");
        c.fillText("Pending viewport data", ARRANGEMENT_GUTTER + 10, top + track.height / 2);
      } else if (track.kind === "pitched" && track.overview?.length) {
        // Bounded pitch occupancy preserves melody/chord shape, rather than
        // turning pitched material into a count-only density graph.
        c.fillStyle = color("#fff");
        c.globalAlpha = 0.7;
        for (const bin of track.overview) {
          const a = bin.start_tick / track.ppq;
          const b = bin.end_tick / track.ppq;
          for (const key of bin.pitches ?? []) {
            const y =
              top +
              43 -
              ((key - track.min) / Math.max(1, track.max - track.min)) * 31;
            c.fillRect(x(a), y, Math.max(1.5, (b - a) * this.scale), 2.5);
          }
        }
      } else if (
        track.overview?.length ||
        (track.kind !== "pitched" &&
          (this.densityMode || track.kind === "group"))
      ) {
        const center = top + track.height / 2;
        const bins = track.overview?.length
          ? track.overview.map((bin) => ({
              beat: bin.start_tick / track.ppq,
              count: bin.onsets ?? 0,
            }))
          : hitDensity(track, this.scale, start, end);
        for (const bin of bins) {
          if (!bin.count) continue;
          const h = 3 + 17 * (1 - Math.exp(-bin.count / 3));
          // Overview count is onset density, not a fabricated velocity aggregate.
          c.globalAlpha = "velocity" in bin ? 0.25 + (0.7 * Number(bin.velocity)) / bin.count : 0.75;
          c.fillStyle = color("#fff");
          c.fillRect(x(bin.beat), center - h / 2, 3, h);
        }
      } else {
        for (const note of track.notes) {
          const a = note.start_tick / track.ppq,
            b = (note.start_tick + note.duration_ticks) / track.ppq;
          if (
            (track.kind === "kit" ? a + 6 / this.scale : b) < start ||
            a > end + 6 / this.scale
          )
            continue;
          const velocity = Math.max(0, Math.min(1, note.attack_velocity / 127));
          c.fillStyle = color("#fff");
          c.globalAlpha = 0.25 + velocity * 0.7;
          if (track.kind === "kit") {
            const y = top + 14,
              radius = 2 + velocity * 3;
            c.beginPath();
            c.moveTo(x(a), y - radius);
            c.lineTo(x(a) + radius, y);
            c.lineTo(x(a), y + radius);
            c.lineTo(x(a) - radius, y);
            c.closePath();
            c.fill();
          } else {
            const y =
              top +
              43 -
              ((note.key - track.min) / Math.max(1, track.max - track.min)) *
                31;
            c.fillRect(x(a), y, Math.max(1.5, (b - a) * this.scale), 2.5);
          }
        }
      }
      c.restore();
      c.fillStyle = color("#d0d0d0");
      c.save();
      c.beginPath();
      c.rect(8, top, 70, track.height);
      c.clip();
      if (track.kind === "kit") {
        c.strokeStyle = color("#555");
        c.beginPath();
        c.moveTo(14.5, top);
        c.lineTo(14.5, top + 14);
        c.lineTo(21, top + 14);
        c.stroke();
        c.fillText(track.label, 27, top + 17);
      } else if (track.kind === "pitched") {
        c.fillText(track.id, 12, top + 24);
        c.fillStyle = color("text-muted");
        c.fillText(
          track.pending ? "Pending data" : track.overview?.length
            ? "Pitch overview · zoom for notes"
            : `${track.notes.length} queried notes`,
          12,
          top + 40,
        );
      }
      c.restore();
    }
    c.restore();
    // The ruler and track names stay fixed while musical content pans beneath them.
    c.fillStyle = color("#080808");
    c.fillRect(0, 0, width, 58);
    c.save();
    c.beginPath();
    c.rect(ARRANGEMENT_GUTTER, 0, width - ARRANGEMENT_GUTTER, 58);
    c.clip();
    for (const section of this.views.graph.extras.sections ?? []) {
      if (section.end < start || section.start > end) continue;
      c.save();
      c.beginPath();
      c.rect(
        Math.max(ARRANGEMENT_GUTTER, x(section.start)),
        0,
        x(section.end) - Math.max(ARRANGEMENT_GUTTER, x(section.start)),
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
        Math.max(ARRANGEMENT_GUTTER, x(section.start)) + 7,
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
      c.fillStyle = color("text-muted");
      c.fillText(
        beat === 0 ? `${measure}` : `${measure}.${beat + 1}`,
        x(b) + 5,
        47,
      );
    }
    c.restore();
    c.fillStyle = color("text-muted");
    c.fillText("PERFORMED", 12, 19);
    c.fillText("Bar · beat", 12, 47);
    if (this.pending) {
      c.fillStyle = color("text-muted");
      c.fillText(sameRevision(this.desiredRef, this.frame?.ref) ? "Viewport pending" :
        this.frame ? `Previous displayed revision ${this.frame.ref.revision} · loading accepted revision` : "Loading accepted revision", ARRANGEMENT_GUTTER + 10, 19);
    }
    this.meterLayer.style.left = `${scroll + 96}px`;
    this.groupLayer.style.left = `${scroll}px`;
    this.auditionLayer.style.left = `${scroll + 88}px`;
    Array.from(this.auditionLayer.children).forEach((element) => {
      const row = this.rows[Number((element as HTMLElement).dataset.auditionRow)];
      const y = row.top - vertical;
      (element as HTMLElement).hidden = y < 58 || y > height;
    });
    Array.from(this.meterLayer.children).forEach((element) => {
      const row = this.rows.find((row) => row.id === (element as HTMLElement).dataset.track);
      if (!row) return;
      const y = row.top + (row.kind === "kit" ? 32 : 36) - vertical;
      (element as HTMLElement).hidden = row.kind === "group" || y < 58 || y > height;
    });
    this.groupLayer
      .querySelectorAll<HTMLButtonElement>("[data-kit]")
      .forEach((button) => {
        const row = this.rows.find(
          (row) => row.kind === "group" && row.id === button.dataset.kit,
        )!;
        const y = row.top - vertical;
        button.hidden = y < 58 || y > height;
        button.classList.toggle(
          "active",
          !!row.members?.includes(this.selected),
        );
      });
    this.parent.dataset.kitView = this.densityMode ? "density" : "hits";
    if (!this.pending) {
      this.auditionLayer.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { button.disabled = false; });
      this.groupLayer.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { button.disabled = false; });
    }
    if (presented) this.onPresented();
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
    ${nodes.map((n) => `<g ${n.source ? `data-source="${escapeHTML(n.source)}" tabindex="0" role="button" aria-label="Open source for ${escapeHTML(n.label)}"` : ""}><title>${escapeHTML(n.label + ": " + n.sub)}</title><rect x="${n.x}" y="${n.y}" width="132" height="48" fill="var(--c-101010)" stroke="var(--c-aaa)"/><rect x="${n.x - 2}" y="${n.y + 21}" width="4" height="6" fill="var(--c-ddd)"/><rect x="${n.x + 130}" y="${n.y + 21}" width="4" height="6" fill="var(--c-ddd)"/><text x="${n.x + 9}" y="${n.y + 19}" fill="var(--c-fff)">${escapeHTML(n.label.length > 19 ? n.label.slice(0, 18) + "…" : n.label)}</text><text x="${n.x + 9}" y="${n.y + 36}" fill="var(--text-muted)">${escapeHTML(n.sub.slice(0, 20))}</text></g>`).join("")}
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


/** Display smoothing only: raw host measurements remain immutable and latest-only. */
export class AnalysisRenderer {
  private frame?: AnalysisFrame;
  private playing = false;
  private visible = true;
  private pending = 0;
  private identity = "";
  private geometry = "";
  private first = new Int32Array();
  private last = new Int32Array();
  private smoothed = new Float32Array();
  private lastPaint = 0;
  private ingress = 0;
  private foreground = "";
  private baseline = "";
  readonly metrics = { received: 0, painted: 0, replaced: 0, ingressToPaintMs: 0, paintMs: 0, paintedSequence: "" };
  constructor(private scope: HTMLCanvasElement, private spectrum: HTMLCanvasElement) {
    scope.setAttribute("aria-label", "Selected audio waveform");
    spectrum.setAttribute("aria-label", "Selected audio spectrum, logarithmic frequency, linear peak amplitude shown in decibels");
    new ResizeObserver(() => this.redraw()).observe(scope);
    new ResizeObserver(() => this.redraw()).observe(spectrum);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { cancelAnimationFrame(this.pending); this.pending = 0; }
      else this.redraw();
    });
  }
  update(frame: AnalysisFrame | undefined, playing: boolean) {
    const identity = frame ? JSON.stringify([frame.ref.project, frame.ref.epoch, frame.ref.engineEpoch,
      frame.ref.revision, frame.ref.sourceVersion, frame.ref.entry, frame.generation, frame.captureId,
      frame.source, frame.sampleRate, frame.sampleCount]) : "";
    if (identity !== this.identity || !playing || frame?.warmup) {
      this.smoothed.fill(0); this.lastPaint = 0;
      this.identity = identity;
    }
    if (this.pending) this.metrics.replaced++;
    this.frame = frame; this.playing = playing; this.ingress = performance.now();
    this.metrics.received++;
    this.schedule();
  }
  setVisible(visible: boolean) {
    this.visible = visible;
    if (!visible) {
      cancelAnimationFrame(this.pending); this.pending = 0; this.frame = undefined;
      this.smoothed.fill(0); this.lastPaint = 0;
    } else this.redraw();
  }
  reset() {
    this.frame = undefined; this.identity = ""; this.smoothed.fill(0); this.lastPaint = 0;
    this.schedule();
  }
  redraw() { this.geometry = ""; this.schedule(); }
  private schedule() {
    if (this.pending || !this.visible || document.hidden) return;
    this.pending = requestAnimationFrame((now) => { this.pending = 0; this.paint(now); });
  }
  private paint(now: number) {
    if (!this.visible || document.hidden) return;
    const started = performance.now();
    const frame = this.playing && !this.frame?.warmup ? this.frame : undefined;
    const sampleRate = frame?.sampleRate ?? 48_000, sampleCount = frame?.sampleCount ?? 2048;
    const bins = frame?.spectrum.length ?? 1025;
    const ratio = Math.min(2, devicePixelRatio);
    const width = Math.max(1, Math.min(4096, Math.round(this.spectrum.clientWidth || this.spectrum.width / ratio)));
    const height = Math.max(1, Math.round(this.spectrum.clientHeight || this.spectrum.height / ratio));
    const geometry = JSON.stringify([width, height, ratio, sampleRate, sampleCount, bins]);
    if (geometry !== this.geometry) {
      this.geometry = geometry;
      const mapping = spectrumPixelBins(width, sampleRate, sampleCount, bins);
      this.first = mapping.first; this.last = mapping.last;
      this.smoothed = new Float32Array(width); this.lastPaint = 0;
      this.foreground = color("#ddd"); this.baseline = color("#333");
    }
    const alpha = this.lastPaint ? displaySmoothingAlpha(now - this.lastPaint) : 1;
    for (const [canvas, data, isSpectrum] of [
      [this.scope, frame?.waveform ?? [], false],
      [this.spectrum, frame?.spectrum ?? [], true],
    ] as const) {
      const w = isSpectrum ? width : Math.max(1, Math.min(4096, Math.round(canvas.clientWidth || canvas.width / ratio)));
      const h = isSpectrum ? height : Math.max(1, Math.round(canvas.clientHeight || canvas.height / ratio));
      if (canvas.width !== Math.round(w * ratio)) canvas.width = Math.round(w * ratio);
      if (canvas.height !== Math.round(h * ratio)) canvas.height = Math.round(h * ratio);
      const context = canvas.getContext("2d");
      if (!context) continue;
      context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, w, h);
      context.strokeStyle = this.baseline;
      context.beginPath(); context.moveTo(0, isSpectrum ? h - .5 : h / 2);
      context.lineTo(w, isSpectrum ? h - .5 : h / 2); context.stroke();
      canvas.dataset.sequence = frame?.sequence ?? "";
      if (!data.length) {
        context.fillStyle = color("text-muted"); context.font = "12px sans-serif";
        context.fillText(!this.playing ? "Stopped" : this.frame?.warmup ? "Warming analysis window" : "Waiting for analysis", 8, 18);
        continue;
      }
      context.strokeStyle = this.foreground; context.lineWidth = 1; context.beginPath();
      for (let x = 0; x < w; x++) {
        let value = 0;
        if (isSpectrum) {
          for (let bin = this.first[x]; bin <= this.last[x]; bin++) value = Math.max(value, data[bin] ?? 0);
          this.smoothed[x] += (value - this.smoothed[x]) * alpha;
          value = this.smoothed[x];
        } else value = data[Math.min(data.length - 1, Math.floor(x * data.length / w))] ?? 0;
        const y = isSpectrum
          ? h * (1 - Math.max(0, Math.min(1, (20 * Math.log10(Math.max(1e-5, value)) + 100) / 100)))
          : (1 - Math.max(-1, Math.min(1, value))) * h / 2;
        if (!x) context.moveTo(x, y); else context.lineTo(x, y);
      }
      context.stroke();
    }
    this.lastPaint = now; this.metrics.painted++;
    this.metrics.paintedSequence = frame?.sequence ?? "";
    this.metrics.ingressToPaintMs = performance.now() - this.ingress;
    this.metrics.paintMs = performance.now() - started;
  }
}
