import type {
  WorkbenchRuntime, RevisionRef, InspectionPage, InspectionView, PageRequest,
  DiffCategory, RowPage,
} from "./host/contracts";
export type { InspectionPage } from "./host/contracts";

const PAGE_LIMIT = 1000;
const identity = (ref: RevisionRef) =>
  JSON.stringify([ref.project, ref.epoch, ref.engineEpoch, ref.revision, ref.sourceVersion, ref.entry]);

/** Revision-checked, explicitly bounded access to host inspection state. */
export class InspectionClient {
  private pages = new Map<string, InspectionPage>();
  private runtime: WorkbenchRuntime;
  readonly ref: RevisionRef;
  constructor(runtime: WorkbenchRuntime, ref: RevisionRef) {
    this.runtime = runtime;
    this.ref = { ...ref };
  }
  private operation() {
    return { requestId: crypto.randomUUID() };
  }
  private accept<T extends RowPage & { ref: RevisionRef }>(page: T): T {
    if (identity(page.ref) !== identity(this.ref))
      throw new Error("Stale inspection revision.");
    if (page.rows.length > PAGE_LIMIT)
      throw new Error("Inspection response exceeds the row limit.");
    return page;
  }
  async inspect(view: InspectionView, page: PageRequest = {}) {
    const request = { ...page, offset: page.offset ?? 0,
      limit: Math.min(PAGE_LIMIT, page.limit ?? PAGE_LIMIT) };
    const key = `${identity(this.ref)}:${view}:${JSON.stringify(request)}`;
    const cached = this.pages.get(key);
    if (cached) return cached;
    const result = this.accept(await this.runtime.inspect(this.ref, view, request, this.operation()));
    if (this.pages.size >= 8) this.pages.delete(this.pages.keys().next().value!);
    this.pages.set(key, result);
    return result;
  }
  async explain(track: string, offset = 0, limit = 100, key?: string) {
    return this.accept(await this.runtime.explain(this.ref, track,
      { ...(key === undefined ? {} : { key }), offset, limit: Math.min(PAGE_LIMIT, limit) },
      this.operation()));
  }
  async diff(category: DiffCategory, offset = 0, limit = 100) {
    return this.accept(await this.runtime.diff(this.ref, category,
      { offset, limit: Math.min(PAGE_LIMIT, limit) }, this.operation()));
  }
  async location(key: string) {
    return this.runtime.location(this.ref, key, this.operation());
  }
  clear() { this.pages.clear(); }
}

export function graphFromRows(rows: any[], sections: any[], groups: any[]) {
  const graph: any = {
    transport: { meter: [4, 4] },
    master: { id: "master", inserts: [], sends: [] },
    buses: [],
    tracks: [],
    extras: { sections, track_groups: groups, automation: [] },
  };
  for (const row of rows) {
    if (row.kind === "transport") graph.transport = row.detail;
    else if (row.kind === "master")
      graph.master = { id: row.id, ...row.detail };
    else if (row.kind === "bus")
      graph.buses.push({ id: row.id, ...row.detail });
    else if (row.kind === "track")
      graph.tracks.push({ id: row.id, ...row.detail });
  }
  return graph;
}

export function performanceFromRows(rows: any[]) {
  const tracks = new Map<string, any>();
  for (const row of rows) {
    if (row.stream !== "notes") continue;
    const track = tracks.get(row.track) ?? {
      track: row.track,
      ppq: 960_000,
      notes: [],
    };
    track.notes.push(row.event);
    tracks.set(row.track, track);
  }
  return [...tracks.values()];
}
