export type InspectionPage = {
  revision: number;
  view?: string;
  rows: any[];
  total: number;
  next?: number;
};

type Caller = { call(message: any): Promise<any> };
const PAGE_LIMIT = 1000;

/** Revision-checked, explicitly bounded access to compiler inspection state. */
export class InspectionClient {
  private pages = new Map<string, InspectionPage>();
  private compiler: Caller;
  public revision: number;
  constructor(compiler: Caller, revision: number) {
    this.compiler = compiler;
    this.revision = revision;
  }

  private accept(page: InspectionPage) {
    if (page.revision !== this.revision)
      throw new Error(
        `Stale inspection revision ${page.revision}; expected ${this.revision}.`,
      );
    if (page.rows.length > PAGE_LIMIT)
      throw new Error("Inspection response exceeds the browser row limit.");
    return page;
  }

  async inspect(
    view: string,
    page: {
      offset?: number;
      limit?: number;
      track?: string;
      start_tick?: number;
      end_tick?: number;
    } = {},
  ) {
    const request = {
      ...page,
      offset: page.offset ?? 0,
      limit: Math.min(PAGE_LIMIT, page.limit ?? PAGE_LIMIT),
    };
    const key = `${view}:${JSON.stringify(request)}`;
    const cached = this.pages.get(key);
    if (cached) return cached;
    const result = this.accept(
      await this.compiler.call({
        command: "inspect",
        revision: this.revision,
        view,
        page: request,
      }),
    );
    // Keep at most eight bounded pages. Visible arrangement requests naturally
    // evict old time ranges instead of accumulating a whole performance.
    if (this.pages.size >= 8)
      this.pages.delete(this.pages.keys().next().value!);
    this.pages.set(key, result);
    return result;
  }

  async explain(track: string, offset = 0, limit = 100, key?: string) {
    const result = await this.compiler.call({
      command: "explain",
      revision: this.revision,
      track,
      key,
      page: { offset, limit: Math.min(PAGE_LIMIT, limit) },
    });
    if (result.revision !== this.revision)
      throw new Error("Stale note explanation response.");
    return result.page as InspectionPage;
  }

  async diff(category: string, offset = 0, limit = 100) {
    const result = await this.compiler.call({
      command: "diff",
      revision: this.revision,
      category,
      page: { offset, limit: Math.min(PAGE_LIMIT, limit) },
    });
    if (result.revision !== this.revision)
      throw new Error("Stale revision difference response.");
    return result;
  }

  async location(key: string) {
    const result = await this.compiler.call({
      command: "location",
      revision: this.revision,
      key,
    });
    if (result.revision !== this.revision)
      throw new Error("Stale source location response.");
    return result.location;
  }

  clear() {
    this.pages.clear();
  }
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
