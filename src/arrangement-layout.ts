export type PerformedNote = {
  id?: string; start_tick: number; duration_ticks: number; key: number; attack_velocity: number;
  [key: string]: unknown;
};
export type OverviewBin = {
  start_tick: number; end_tick: number; notes?: number; pitches?: number[]; onsets?: number;
  [key: string]: unknown;
};
export type PerformedTrack = {
  track: string; notes?: PerformedNote[]; overview?: OverviewBin[]; ppq?: number;
  pending?: boolean; representation?: string;
  source?: { notes?: { start_ticks: number; duration_ticks: number; key: number; velocity: number }[] };
};
export type CatalogTrack = { id: string; source?: { summary?: { ppq?: number } }; [key: string]: unknown };
export type TrackGroup = { id: string; kind: string; members: { track: string; label: string }[] };
export type ArrangementGraph = {
  transport: { meter?: number[]; [key: string]: unknown };
  tracks?: CatalogTrack[]; buses?: unknown[]; master?: unknown;
  extras: { track_groups?: TrackGroup[]; sections?: { name: string; start: number; end: number }[]; automation?: unknown[] };
};
export type ArrangementViews = {
  graph: ArrangementGraph; performance: PerformedTrack[];
  groupOverviews?: Record<string, OverviewBin[]>;
};
export type ArrangementRow = {
  id: string; label: string; kind: "pitched" | "kit" | "group";
  group?: string; members?: string[]; memberRows?: ArrangementRow[];
  notes: PerformedNote[]; overview?: OverviewBin[]; pending?: boolean;
  ppq: number; min: number; max: number; top: number; height: number;
};

/** Fixed MIDI 0..127 is deliberate: browsing pages cannot redefine pitch geometry. */
export function arrangementRows(views: ArrangementViews, collapsed: Set<string>): ArrangementRow[] {
  const performed = new Map(views.performance.map((track) => [track.track, track]));
  const catalog = views.graph.tracks ?? views.performance.map((track) => ({ id: track.track }));
  const tracks = new Map<string, ArrangementRow>(catalog.map((catalogTrack) => {
    const track = performed.get(catalogTrack.id);
    const notes = track?.notes ?? track?.source?.notes?.map((note) => ({
      start_tick: note.start_ticks, duration_ticks: note.duration_ticks, key: note.key, attack_velocity: note.velocity * 127,
    })) ?? [];
    return [catalogTrack.id, { id: catalogTrack.id, label: catalogTrack.id, kind: "pitched", notes,
      overview: track?.overview, pending: track?.pending ?? !track,
      ppq: track?.ppq ?? 960_000, min: 0, max: 127, top: 0, height: 56 }];
  }));
  const membership = new Map<string, TrackGroup>();
  for (const group of views.graph.extras.track_groups ?? []) {
    if (group.kind !== "kit") continue;
    for (const member of group.members) {
      const track = tracks.get(member.track);
      if (!track || membership.has(member.track)) continue;
      track.kind = "kit"; track.group = group.id; track.label = member.label; track.height = 36;
      membership.set(member.track, group);
    }
  }
  const rows: ArrangementRow[] = [], seen = new Set<string>();
  for (const track of tracks.values()) {
    const group = membership.get(track.id);
    if (!group) { rows.push(track); continue; }
    if (seen.has(group.id)) continue;
    seen.add(group.id);
    const members = group.members.map((member) => tracks.get(member.track))
      .filter((member): member is ArrangementRow => member?.group === group.id);
    rows.push({ id: group.id, label: group.id, kind: "group", members: members.map((member) => member.id),
      // Reference member data, never clone every group note on a tile refresh.
      memberRows: members, notes: [], overview: views.groupOverviews?.[group.id],
      pending: collapsed.has(group.id) ? !views.groupOverviews?.[group.id] && members.some((member) => member.pending) : false,
      ppq: 1, min: 0, max: 0, top: 0, height: 36 });
    if (!collapsed.has(group.id)) rows.push(...members);
  }
  let top = 58;
  for (const row of rows) { row.top = top; top += row.height; }
  return rows;
}


/** Screen-width bins count performed onsets; real velocities exist only in detail. */
export function hitDensity(row: ArrangementRow, scale: number, start: number, end: number) {
  const beatsPerBin = 4 / scale;
  const bins = new Map<number, { beat: number; count: number; velocity: number }>();
  for (const member of row.memberRows ?? [row]) {
    for (const note of member.notes) {
      const beat = note.start_tick / member.ppq;
      if (beat < start - beatsPerBin || beat > end + beatsPerBin) continue;
      const index = Math.floor(beat / beatsPerBin);
      const bin = bins.get(index) ?? { beat: index * beatsPerBin, count: 0, velocity: 0 };
      bin.count++; bin.velocity += Math.max(0, Math.min(1, note.attack_velocity / 127)); bins.set(index, bin);
    }
  }
  return [...bins.values()];
}
