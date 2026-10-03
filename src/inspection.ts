import type {
  WorkbenchRuntime, RevisionRef, InspectionPage, InspectionView, PageRequest,
  DiffCategory, RowPage, AcceptedRevision,
} from "./host/contracts";
import type { Arrangement, ArrangementTarget, ArrangementFrame } from "./views";
import type { ArrangementViews, ArrangementGraph, PerformedTrack, PerformedNote, OverviewBin, TrackGroup, CatalogTrack } from "./arrangement-layout";

type WorkbenchViews = ArrangementViews & {
  summary: unknown; locations: Record<string, unknown>; diagnostics: unknown[]; catalogComplete: boolean;
  continuations: { graph: null; sections: null; track_groups: null; locations: number | null; diagnostics: number | null };
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function overviewBins(rows: unknown[]): OverviewBin[] {
  return rows.map((row) => {
    if (!record(row) || typeof row.start_tick !== "number" || typeof row.end_tick !== "number" ||
      (row.onsets !== undefined && typeof row.onsets !== "number") ||
      (row.notes !== undefined && typeof row.notes !== "number") ||
      (row.pitches !== undefined && (!Array.isArray(row.pitches) || !row.pitches.every((pitch) => typeof pitch === "number"))))
      throw new Error("Invalid arrangement overview bin.");
    return { ...row, start_tick: row.start_tick, end_tick: row.end_tick,
      notes: typeof row.notes === "number" ? row.notes : undefined,
      onsets: typeof row.onsets === "number" ? row.onsets : undefined,
      pitches: Array.isArray(row.pitches) ? row.pitches : undefined };
  });
}
export type { InspectionPage } from "./host/contracts";

const PAGE_LIMIT = 1000;
export const revisionIdentity = (ref: RevisionRef) =>
  JSON.stringify([ref.project, ref.epoch, ref.engineEpoch, ref.revision, ref.sourceVersion, ref.entry]);
const abortError = () => new DOMException("Inspection target retired.", "AbortError");
type Subscriber = { resolve: (page: InspectionPage) => void; reject: (error: unknown) => void;
  detach: () => void; retain: () => boolean };
type Job = { key: string; view: InspectionView; request: PageRequest; priority: number;
  abort: AbortController; subscribers: Set<Subscriber> };
type CachedPage = { page: InspectionPage; rows: number; bytes: number };

/** Revision-owned, coalesced inspection with bounded dispatch and actual LRU retention. */
export class InspectionClient {
  private pages = new Map<string, CachedPage>();
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private active = 0;
  private retired = false;
  private pinned = new Set<string>();
  private bytes = 0;
  private rows = 0;
  readonly ref: RevisionRef;
  readonly metrics = { dispatched: 0, coalesced: 0, cacheHits: 0, obsolete: 0, peakBytes: 0, peakActive: 0 };
  get retention() { return { entries: this.pages.size, rows: this.rows, bytes: this.bytes, queued: this.queue.length, active: this.active }; }
  readonly concurrency: number;
  private readonly pageLimit: number;
  constructor(private runtime: WorkbenchRuntime, ref: RevisionRef) {
    this.ref = Object.freeze({ ...ref });
    this.concurrency = Math.max(1, Math.min(4, (runtime.capabilities?.limits.outstandingRequests ?? 8) - 2));
    this.pageLimit = Math.min(PAGE_LIMIT, runtime.capabilities?.limits.inspectionRows ?? PAGE_LIMIT);
  }
  private operation(signal?: AbortSignal) { return { requestId: crypto.randomUUID(), signal }; }
  private accept<T extends RowPage & { ref: RevisionRef }>(page: T): T {
    if (revisionIdentity(page.ref) !== revisionIdentity(this.ref))
      throw new Error("Stale inspection revision.");
    if (page.rows.length > PAGE_LIMIT) throw new Error("Inspection response exceeds the row limit.");
    return page;
  }
  private request(page: PageRequest): PageRequest {
    return { ...(page.track === undefined ? {} : { track: page.track }),
      ...(page.start_tick === undefined ? {} : { start_tick: BigInt(page.start_tick).toString() }),
      ...(page.end_tick === undefined ? {} : { end_tick: BigInt(page.end_tick).toString() }),
      offset: page.offset ?? 0, limit: Math.min(this.pageLimit, page.limit ?? this.pageLimit) };
  }
  key(view: InspectionView, page: PageRequest = {}) {
    return `${revisionIdentity(this.ref)}:${view}:${JSON.stringify(this.request(page))}`;
  }
  pin(keys: Iterable<string>) { this.pinned = new Set(keys); this.evict(); }
  private evict() {
    // Iteration order is recency: reads move entries to the end, not insertion-only FIFO.
    for (const [key, value] of this.pages) {
      if (this.pages.size <= 128 && this.rows <= 24_000 && this.bytes <= 8 * 1024 * 1024) break;
      if (this.pinned.has(key)) continue;
      this.pages.delete(key); this.rows -= value.rows; this.bytes -= value.bytes;
    }
    // Presented data also lives in its bounded frame; cache pins cannot defeat hard retention limits.
    for (const [key, value] of this.pages) {
      if (this.pages.size <= 128 && this.rows <= 24_000 && this.bytes <= 8 * 1024 * 1024) break;
      this.pages.delete(key); this.rows -= value.rows; this.bytes -= value.bytes; this.pinned.delete(key);
    }
  }
  inspect(view: InspectionView, page: PageRequest = {}, options: { signal?: AbortSignal; priority?: "visible" | "prefetch"; retain?: () => boolean } = {}): Promise<InspectionPage> {
    if (this.retired || options.signal?.aborted) return Promise.reject(abortError());
    const request = this.request(page), key = this.key(view, request);
    const cached = this.pages.get(key);
    if (cached) {
      this.pages.delete(key); this.pages.set(key, cached); this.metrics.cacheHits++;
      return Promise.resolve(cached.page);
    }
    let job = this.jobs.get(key);
    if (!job) {
      if (this.queue.length >= 64) return Promise.reject(new Error("Inspection queue is full."));
      job = { key, view, request, priority: options.priority === "prefetch" ? 1 : 0,
        abort: new AbortController(), subscribers: new Set() };
      this.jobs.set(key, job); this.queue.push(job);
    } else {
      this.metrics.coalesced++;
      if (options.priority !== "prefetch") job.priority = 0;
    }
    const pending = job;
    const promise = new Promise<InspectionPage>((resolve, reject) => {
      const subscriber: Subscriber = { resolve, reject, retain: options.retain ?? (() => true),
        detach: () => options.signal?.removeEventListener("abort", cancel) };
      const cancel = () => {
        pending.subscribers.delete(subscriber); subscriber.detach(); reject(abortError());
        if (!pending.subscribers.size) {
          pending.abort.abort(); this.jobs.delete(key);
          this.queue = this.queue.filter((queued) => queued !== pending);
        }
      };
      pending.subscribers.add(subscriber);
      options.signal?.addEventListener("abort", cancel, { once: true });
    });
    this.dispatch();
    return promise;
  }
  private dispatch() {
    this.queue.sort((a, b) => a.priority - b.priority);
    while (!this.retired && this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      if (!job.subscribers.size) continue;
      this.active++;
      this.metrics.peakActive = Math.max(this.metrics.peakActive, this.active);
      const inspect = async () => {
        let limit = job.request.limit ?? this.pageLimit;
        for (;;) {
          if (this.retired || job.abort.signal.aborted || !job.subscribers.size) throw abortError();
          this.metrics.dispatched++;
          try {
            return await this.runtime.inspect(this.ref, job.view, { ...job.request, limit }, this.operation(job.abort.signal));
          } catch (error) {
            // Native complete_page rejects a byte-shrunk batch. Only this typed
            // inspection budget outcome reduces rows, without advancing offset.
            if (!record(error) || error.code !== "too_large" || limit <= 1) throw error;
            limit = Math.max(1, Math.floor(limit / 2));
          }
        }
      };
      void inspect().then((result) => {
        const page = this.accept(result);
        if (this.retired || !job.subscribers.size || job.abort.signal.aborted) { this.metrics.obsolete++; return; }
        const bytes = new TextEncoder().encode(JSON.stringify(page)).byteLength;
        if (bytes <= 8 * 1024 * 1024 && [...job.subscribers].some((subscriber) => subscriber.retain())) {
          this.pages.set(job.key, { page, rows: page.rows.length, bytes });
          this.rows += page.rows.length; this.bytes += bytes; this.evict();
          this.metrics.peakBytes = Math.max(this.metrics.peakBytes, this.bytes);
        }
        for (const subscriber of job.subscribers) { subscriber.detach(); subscriber.resolve(page); }
      }).catch((error) => {
        for (const subscriber of job.subscribers) { subscriber.detach(); subscriber.reject(error); }
      }).finally(() => {
        job.subscribers.clear();
        if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
        this.active--; this.dispatch();
      });
    }
  }
  /** Complete structural catalogs only. Never restore an unbounded note snapshot. */
  async catalog(view: "graph" | "sections" | "track_groups", initial: InspectionPage, signal?: AbortSignal) {
    let page = this.accept(initial);
    const rows = [...page.rows];
    let bytes = new TextEncoder().encode(JSON.stringify(rows)).byteLength;
    if (rows.length > 32_768 || bytes > 16 * 1024 * 1024)
      throw new Error("Structural catalog exceeds its aggregate limit; it is not complete.");
    const offsets = new Set<number>([0]);
    while (page.next !== null) {
      if (signal?.aborted || this.retired) throw abortError();
      if (offsets.has(page.next)) throw new Error("Inspection catalog continuation did not advance.");
      offsets.add(page.next);
      page = await this.inspect(view, { offset: page.next }, { signal });
      bytes += new TextEncoder().encode(JSON.stringify(page.rows)).byteLength;
      if (rows.length + page.rows.length > 32_768 || bytes > 16 * 1024 * 1024)
        throw new Error("Structural catalog exceeds its aggregate limit; it is not complete.");
      rows.push(...page.rows);
    }
    return rows;
  }
  async explain(track: string, offset = 0, limit = 100, key?: string) {
    return this.accept(await this.runtime.explain(this.ref, track,
      { ...(key === undefined ? {} : { key }), offset, limit: Math.min(PAGE_LIMIT, limit) }, this.operation()));
  }
  async diff(category: DiffCategory, offset = 0, limit = 100) {
    return this.accept(await this.runtime.diff(this.ref, category,
      { offset, limit: Math.min(PAGE_LIMIT, limit) }, this.operation()));
  }
  async location(key: string) { return this.runtime.location(this.ref, key, this.operation()); }
  clear() { this.pages.clear(); this.pinned.clear(); this.bytes = this.rows = 0; }
  retire() {
    this.retired = true;
    for (const job of this.jobs.values()) {
      job.abort.abort();
      for (const subscriber of job.subscribers) { subscriber.detach(); subscriber.reject(abortError()); }
      job.subscribers.clear();
    }
    this.jobs.clear(); this.queue = []; this.clear();
  }
}

export function graphFromRows(rows: unknown[], sections: unknown[], groups: unknown[]): ArrangementGraph & { tracks: CatalogTrack[]; buses: unknown[] } {
  const parsedSections = sections.map((section) => {
    if (!record(section) || typeof section.name !== "string" || typeof section.start !== "number" || typeof section.end !== "number")
      throw new Error("Invalid arrangement section.");
    return { ...section, name: section.name, start: section.start, end: section.end };
  });
  const parsedGroups: TrackGroup[] = groups.map((group) => {
    if (!record(group) || typeof group.id !== "string" || typeof group.kind !== "string" || !Array.isArray(group.members))
      throw new Error("Invalid arrangement group.");
    const members = group.members.map((member: unknown) => {
      if (!record(member) || typeof member.track !== "string" || typeof member.label !== "string")
        throw new Error("Invalid arrangement group member.");
      return { track: member.track, label: member.label };
    });
    return { id: group.id, kind: group.kind, members };
  });
  const graph: ArrangementGraph & { tracks: CatalogTrack[]; buses: unknown[] } = {
    transport: { meter: [4, 4] }, master: { id: "master", inserts: [], sends: [] },
    buses: [], tracks: [], extras: { sections: parsedSections, track_groups: parsedGroups, automation: [] } };
  for (const row of rows) {
    if (!record(row) || typeof row.kind !== "string" || !record(row.detail)) throw new Error("Invalid graph catalog row.");
    if (row.kind === "transport") {
      const meter = row.detail.meter;
      if (meter !== undefined && (!Array.isArray(meter) || !meter.every((beat) => typeof beat === "number")))
        throw new Error("Invalid transport meter.");
      graph.transport = { ...row.detail, meter: Array.isArray(meter) ? meter : undefined };
    } else if (row.kind === "master") graph.master = { id: row.id, ...row.detail };
    else if (row.kind === "bus") graph.buses.push({ id: row.id, ...row.detail });
    else if (row.kind === "track") {
      if (typeof row.id !== "string") throw new Error("Invalid graph track identity.");
      const source = record(row.detail.source) ? row.detail.source : undefined;
      const summary = source && record(source.summary) ? source.summary : undefined;
      const ppq = summary?.ppq;
      if (ppq !== undefined && (typeof ppq !== "number" || !Number.isFinite(ppq) || ppq <= 0))
        throw new Error("Invalid track PPQ.");
      graph.tracks.push({ ...row.detail, id: row.id,
        source: source ? { ...source, summary: summary ? { ...summary, ppq: typeof ppq === "number" ? ppq : undefined } : undefined } : undefined });
    }
  }
  return graph;
}
export function performanceFromRows(rows: unknown[]) {
  const tracks = new Map<string, { track: string; ppq: number; notes: PerformedNote[] }>();
  for (const row of rows) {
    if (!record(row) || row.stream !== "notes") continue;
    if (typeof row.track !== "string" || !record(row.event)) throw new Error("Invalid performed note.");
    const event = row.event;
    if (typeof event.start_tick !== "number" || typeof event.duration_ticks !== "number" ||
      typeof event.key !== "number" || typeof event.attack_velocity !== "number")
      throw new Error("Invalid performed note coordinates.");
    const track = tracks.get(row.track) ?? { track: row.track, ppq: 960_000, notes: [] };
    track.notes.push({ ...event, id: typeof event.id === "string" ? event.id : undefined,
      start_tick: event.start_tick, duration_ticks: event.duration_ticks, key: event.key, attack_velocity: event.attack_velocity });
    tracks.set(row.track, track);
  }
  return [...tracks.values()];
}
/** Detail markers/hit tests extend six pixels outside the visible beat interval. */
export function coversArrangementRange(
  coverage: { start: number; end: number },
  target: { start: number; end: number; scale: number },
  projectEnd: number,
) {
  return Math.max(0, target.start - 6 / target.scale) >= coverage.start &&
    Math.min(projectEnd, target.end + 6 / target.scale) <= coverage.end;
}

/** Aligned two-tile coverage includes marker overhang and reuses nearby navigation. */
export function arrangementCoverage(start: number, end: number, scale: number) {
  const span = 2 ** Math.ceil(Math.log2(Math.max(1 / 1024, end - start + 12 / scale)));
  const left = Math.max(0, Math.floor(Math.max(0, start - 6 / scale) / span) * span);
  return { start: left, end: Math.max(end + 6 / scale, left + 2 * span), span };
}

/** One executing target and one latest intent. No trailing-only drag debounce. */
export class ArrangementInspection {
  private client?: InspectionClient;
  private views?: WorkbenchViews;
  private end = 1;
  private visible = true;
  private latest?: ArrangementTarget;
  private desired?: ArrangementTarget;
  private running?: Promise<void>;
  private abort?: AbortController;
  private catalogAbort?: AbortController;
  private requestFrame = 0;
  private requestedScroll?: number;
  private followTarget = false;
  private followStart = 0;
  private followTime = 0;
  private followSpeed = 0;
  private epoch = 0;
  private latency = 0;
  readonly metrics = { targets: 0, replaced: 0, committed: 0, obsolete: 0, latencyMs: 0 };
  constructor(private arrangement: Arrangement, private onError: (error: unknown) => void) {}
  async accept(client: InspectionClient, pages: AcceptedRevision["initialPages"], end: number) {
    this.client?.retire(); this.abort?.abort(); this.catalogAbort?.abort(); this.epoch++;
    cancelAnimationFrame(this.requestFrame); this.requestFrame = 0;
    this.views = undefined;
    const epoch = this.epoch;
    this.client = client; this.latest = undefined; this.desired = undefined;
    this.arrangement.beginRevision(client.ref);
    const abort = this.catalogAbort = new AbortController();
    const [graph, sections, groups] = await Promise.all([
      client.catalog("graph", pages.graph, abort.signal),
      client.catalog("sections", pages.sections, abort.signal),
      client.catalog("track_groups", pages.track_groups, abort.signal),
    ]);
    if (epoch !== this.epoch) throw abortError();
    if (this.running) await this.running.catch(() => {});
    if (epoch !== this.epoch) throw abortError();
    this.end = Math.max(1, end);
    this.views = { summary: pages.summary.rows[0], graph: graphFromRows(graph, sections, groups),
      performance: [], locations: Object.fromEntries(pages.locations.rows.map((row) => {
        if (!record(row) || typeof row.key !== "string") throw new Error("Invalid location catalog row.");
        return [row.key, row.location];
      })),
      diagnostics: pages.diagnostics.rows, catalogComplete: true,
      continuations: { graph: null, sections: null, track_groups: null, locations: pages.locations.next, diagnostics: pages.diagnostics.next } };
    this.views.performance = (this.views.graph.tracks ?? []).map((track) => ({ track: track.id,
      ppq: track.source?.summary?.ppq ?? 960_000, notes: [], pending: true }));
    // A previous revision stays displayed until this complete frame is prepared.
    if (this.visible) {
      this.desired = this.latest = this.arrangement.target(this.views, this.end);
      this.arrangement.setDesiredTarget(this.desired);
      try { await this.drain(); }
      catch (error) {
        if ((error as Error)?.name !== "AbortError" || this.visible || epoch !== this.epoch) throw error;
      }
    }
    if (epoch !== this.epoch) throw abortError();
    return this.views;
  }
  request(followScrollLeft?: number) {
    if (!this.visible || !this.client || !this.views) return;
    if (followScrollLeft === undefined || followScrollLeft !== this.desired?.scrollLeft || !this.desired?.follow)
      this.arrangement.setDesiredTarget(undefined);
    this.requestedScroll = followScrollLeft;
    if (this.requestFrame) return;
    this.requestFrame = requestAnimationFrame(() => {
      this.requestFrame = 0;
      if (!this.visible || !this.client || !this.views) return;
      const target = this.arrangement.target(this.views, this.end, this.requestedScroll);
      this.desired = target;
      this.arrangement.setDesiredTarget(target);
      this.requestedScroll = undefined;
      if (target.follow) {
        const now = performance.now();
        if (this.followTime && target.start >= this.followStart)
          this.followSpeed = (target.start - this.followStart) * 1000 / Math.max(1, now - this.followTime);
        this.followStart = target.start; this.followTime = now;
      } else {
        this.followTime = this.followSpeed = 0;
        if (this.followTarget) this.abort?.abort();
      }
      if (this.arrangement.isCovered(target)) {
        this.latest = undefined;
        this.abort?.abort();
        this.arrangement.commitScroll(target);
        return;
      }
      this.metrics.targets++;
      if (this.latest) this.metrics.replaced++;
      this.latest = target; this.arrangement.markPending();
      void this.drain().catch((error) => { if ((error as Error)?.name !== "AbortError") this.onError(error); });
    });
  }
  setVisible(visible: boolean) {
    this.visible = visible; this.arrangement.setVisible(visible);
    if (!visible) {
      cancelAnimationFrame(this.requestFrame); this.requestFrame = 0;
      this.latest = undefined; this.abort?.abort();
    }
    else this.request();
  }
  retire() {
    this.epoch++; this.client?.retire(); this.client = undefined;
    cancelAnimationFrame(this.requestFrame); this.requestFrame = 0;
    this.abort?.abort(); this.latest = undefined; this.views = undefined;
    this.desired = undefined;
    this.catalogAbort?.abort();
    this.arrangement.reset();
  }
  private drain(): Promise<void> {
    if (this.running) return this.running;
    const work = async () => {
      while (this.visible && this.latest && this.client && this.views) {
        const target = this.latest; this.latest = undefined;
        this.followTarget = target.follow;
        const client = this.client, epoch = this.epoch, model = this.views;
        const abort = this.abort = new AbortController();
        const started = performance.now();
        const coverage = arrangementCoverage(target.start, target.end, target.scale);
        const performed = new Map<string, PerformedTrack>();
        const keys: string[] = [];
        const kit = new Set<string>((model.graph.extras.track_groups ?? []).filter((group) => group.kind === "kit")
          .flatMap((group) => group.members.map((member) => member.track)));
        const groups = new Map<string, Map<number, OverviewBin & { onsets: number }>>();
        let retainedRows = 0, retainedBytes = 0;
        const fetch = async (id: string) => {
          const retain = () => {
            const desired = this.requestFrame ? this.arrangement.target(model, this.end, this.requestedScroll) : this.desired;
            return !!desired && epoch === this.epoch && client === this.client && this.visible &&
              desired.layoutGeneration === target.layoutGeneration &&
              desired.start < coverage.end && desired.end > coverage.start && desired.tracks.includes(id);
          };
          const track = (model.graph.tracks ?? []).find((track) => track.id === id);
          const ppq = track?.source?.summary?.ppq ?? 960_000;
          const request = { track: id, start_tick: String(Math.floor(coverage.start * ppq)),
            end_tick: String(Math.max(Math.floor(coverage.start * ppq) + 1, Math.ceil(coverage.end * ppq))) };
          const collapsedGroup = target.groups.find((group) => group.members.includes(id));
          let overview = (target.scale < 24 && kit.has(id)) || !!collapsedGroup;
          let view: InspectionView = overview ? "performance_overview" : "performance";
          let page = await client.inspect(view, request, { signal: abort.signal, retain });
          if (!overview && (page.next !== null || retainedRows + page.rows.length > 12_000)) {
            overview = true; view = "performance_overview";
            page = await client.inspect(view, request, { signal: abort.signal, retain });
          }
          const rows = [...page.rows];
          // Byte-shrunk overview pages must complete too; never claim a partial range.
          const offsets = new Set<number>();
          while (overview && page.next !== null) {
            if (offsets.has(page.next)) throw new Error("Overview continuation did not advance.");
            offsets.add(page.next);
            page = await client.inspect(view, { ...request, offset: page.next }, { signal: abort.signal, retain });
            if (rows.length + page.rows.length > 1000) throw new Error("Overview exceeds its bounded bin budget.");
            rows.push(...page.rows);
          }
          const bins = overview ? overviewBins(rows) : undefined;
          if (kit.has(id) && bins?.some((bin) => typeof bin.onsets !== "number"))
            throw new Error("Kit onset density is unavailable from this engine.");
          if (collapsedGroup) {
            const aggregate = groups.get(collapsedGroup.id) ?? new Map<number, OverviewBin & { onsets: number }>();
            const binWidth = (coverage.end - coverage.start) / 128;
            for (const row of bins ?? []) {
              const index = Math.min(127, Math.floor((row.start_tick / ppq - coverage.start) / binWidth));
              const beat = coverage.start + index * binWidth;
              const bin = aggregate.get(index) ?? { start_tick: beat, end_tick: beat + binWidth, onsets: 0 };
              bin.onsets += row.onsets ?? 0; aggregate.set(index, bin);
            }
            groups.set(collapsedGroup.id, aggregate);
            return;
          }
          retainedRows += rows.length;
          retainedBytes += new TextEncoder().encode(JSON.stringify(rows)).byteLength;
          if (retainedRows > 24_000 || retainedBytes > 8 * 1024 * 1024)
            throw new Error("Visible arrangement exceeds its retained data budget.");
          keys.push(client.key(view, request));
          performed.set(id, { track: id, ppq, notes: overview ? [] : (performanceFromRows(rows)[0]?.notes ?? []),
            overview: bins, representation: overview ? (kit.has(id) ? "onsets" : "occupancy") : "detail" });
        };
        // Only a bounded worker wave; a collapsed kit never queues all its members.
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(client.concurrency, target.tracks.length) }, async () => {
          while (next < target.tracks.length) await fetch(target.tracks[next++]);
        }));
        if (epoch !== this.epoch || client !== this.client || !this.visible) return;
        const commitTarget = this.desired ?? target;
        const stillCovered = coversArrangementRange(coverage, commitTarget, this.end) &&
          commitTarget.layoutGeneration === target.layoutGeneration &&
          (commitTarget.scale < 24) === (target.scale < 24) &&
          commitTarget.tracks.every((id) => performed.has(id) ||
            commitTarget.groups.some((group) => groups.has(group.id) && group.members.includes(id)));
        if (!stillCovered || !this.arrangement.targetMatches(commitTarget, model, this.end)) {
          this.metrics.obsolete++; continue;
        }
        this.latest = undefined;
        const performanceRows = (model.graph.tracks ?? []).map((track) => performed.get(track.id) ?? {
          track: track.id, ppq: track.source?.summary?.ppq ?? 960_000, notes: [], pending: true });
        const groupOverviews = Object.fromEntries([...groups].map(([id, bins]) => [id, [...bins.values()]]));
        const preparedViews = { ...model, performance: performanceRows, groupOverviews };
        const frame: ArrangementFrame = { ref: client.ref, views: preparedViews, end: this.end, target: commitTarget, coverage,
          coveredTracks: new Set(performed.keys()), coveredGroups: new Set(groups.keys()) };
        this.arrangement.commitFrame(frame);
        model.performance = performanceRows; model.groupOverviews = groupOverviews;
        client.pin(keys);
        this.metrics.committed++;
        this.latency = this.latency ? this.latency * .8 + (performance.now() - started) * .2 : performance.now() - started;
        this.metrics.latencyMs = this.latency;
        // Measured follow velocity/latency prefetches at most four visible rows
        // on the same aligned tile keys used by real requests.
        if (commitTarget.follow && !this.latest && this.followSpeed > 0 &&
          coverage.end - commitTarget.end <= this.followSpeed * (this.latency + 100) / 1000) {
          const nextStart = coverage.start + coverage.span, nextEnd = nextStart + 2 * coverage.span;
          for (const id of commitTarget.tracks.slice(0, 4)) {
            const ppq = (model.graph.tracks ?? []).find((track) => track.id === id)?.source?.summary?.ppq ?? 960_000;
            const view = performed.get(id)?.representation === "detail" ? "performance" : "performance_overview";
            void client.inspect(view, { track: id, start_tick: String(Math.floor(nextStart * ppq)),
              end_tick: String(Math.ceil(nextEnd * ppq)) }, { signal: abort.signal, priority: "prefetch",
              retain: () => {
                const desired = this.requestFrame ? this.arrangement.target(model, this.end, this.requestedScroll) : this.desired;
                return epoch === this.epoch && this.visible && this.arrangement.follow && !!desired &&
                  desired.tracks.includes(id) && desired.start < nextEnd && desired.end > nextStart;
              } }).catch(() => {});
          }
        }
      }
    };
    this.running = work().finally(() => {
      this.running = undefined;
      if (this.visible && this.latest) void this.drain().catch((error) => { if ((error as Error)?.name !== "AbortError") this.onError(error); });
    });
    return this.running;
  }
}
