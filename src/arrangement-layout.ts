export type ArrangementRow = {
  id: string;
  label: string;
  kind: "pitched" | "kit" | "group";
  group?: string;
  members?: string[];
  notes: any[];
  overview?: any[];
  ppq: number;
  min: number;
  max: number;
  top: number;
  height: number;
};

export function arrangementRows(
  views: any,
  collapsed: Set<string>,
): ArrangementRow[] {
  const tracks = new Map<string, ArrangementRow>(
    views.performance.map((t: any) => {
      const notes =
        t.notes ??
        t.source?.notes?.map((n: any) => ({
          start_tick: n.start_ticks,
          duration_ticks: n.duration_ticks,
          key: n.key,
          attack_velocity: n.velocity * 127,
        })) ??
        [];
      return [
        t.track,
        {
          id: t.track,
          label: t.track,
          kind: "pitched",
          notes,
          overview: t.overview,
          ppq: t.ppq ?? 960_000,
          min: notes.reduce(
            (n: number, note: any) => Math.min(n, note.key),
            48,
          ),
          max: notes.reduce(
            (n: number, note: any) => Math.max(n, note.key),
            60,
          ),
          top: 0,
          height: 56,
        },
      ];
    }),
  );
  const membership = new Map<string, any>();
  for (const group of views.graph.extras.track_groups ?? []) {
    if (group.kind !== "kit") continue;
    for (const member of group.members) {
      const track = tracks.get(member.track);
      if (!track || membership.has(member.track)) continue;
      track.kind = "kit";
      track.group = group.id;
      track.label = member.label;
      track.height = 28;
      membership.set(member.track, group);
    }
  }
  const rows: ArrangementRow[] = [],
    seen = new Set<string>();
  for (const track of tracks.values()) {
    const group = membership.get(track.id);
    if (!group) {
      rows.push(track);
      continue;
    }
    if (seen.has(group.id)) continue;
    seen.add(group.id);
    const members = group.members
      .map((m: any) => tracks.get(m.track))
      .filter(
        (t: ArrangementRow | undefined) => t?.group === group.id,
      ) as ArrangementRow[];
    rows.push({
      id: group.id,
      label: group.id,
      kind: "group",
      members: members.map((t) => t.id),
      // Group overview uses beats, independent of each physical track's PPQ.
      notes: members.flatMap((t) =>
        t.notes.map((n) => ({
          ...n,
          start_tick: n.start_tick / t.ppq,
          duration_ticks: n.duration_ticks / t.ppq,
        })),
      ),
      overview: members.flatMap((t) =>
        (t.overview ?? []).map((bin) => ({
          ...bin,
          start_tick: bin.start_tick / t.ppq,
          end_tick: bin.end_tick / t.ppq,
        })),
      ),
      ppq: 1,
      min: 0,
      max: 0,
      top: 0,
      height: 32,
    });
    if (!collapsed.has(group.id)) rows.push(...members);
  }
  let top = 58;
  for (const row of rows) {
    row.top = top;
    top += row.height;
  }
  return rows;
}

/** Fixed screen-width bins accumulate performed onsets; note duration is irrelevant. */
export function hitDensity(
  row: ArrangementRow,
  scale: number,
  start: number,
  end: number,
) {
  const beatsPerBin = 4 / scale;
  const bins = new Map<
    number,
    { beat: number; count: number; velocity: number }
  >();
  for (const note of row.notes) {
    const beat = note.start_tick / row.ppq;
    if (beat < start - beatsPerBin || beat > end + beatsPerBin) continue;
    const index = Math.floor(beat / beatsPerBin);
    const bin = bins.get(index) ?? {
      beat: index * beatsPerBin,
      count: 0,
      velocity: 0,
    };
    bin.count++;
    bin.velocity += Math.max(0, Math.min(1, note.attack_velocity / 127));
    bins.set(index, bin);
  }
  return [...bins.values()];
}
