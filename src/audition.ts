/** Session-local listening controls; group policy uses explicit physical IDs. */
export class AuditionState {
  muted = new Set<string>();
  solo = new Set<string>();

  state(kind: "muted" | "solo", ids: string[]): "true" | "false" | "mixed" {
    const count = ids.filter((id) => this[kind].has(id)).length;
    return count === 0 ? "false" : count === ids.length ? "true" : "mixed";
  }
  toggle(kind: "muted" | "solo", ids: string[]) {
    const remove = this.state(kind, ids) === "true";
    for (const id of ids) {
      if (remove) this[kind].delete(id);
      else this[kind].add(id);
    }
  }
  retain(ids: string[]) {
    const keep = new Set(ids);
    for (const set of [this.muted, this.solo])
      for (const id of set) if (!keep.has(id)) set.delete(id);
  }
  clear() {
    this.muted.clear();
    this.solo.clear();
  }
}
