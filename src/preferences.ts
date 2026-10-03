import type {
  PreferencesStore,
  ThemeId,
  WorkbenchPreferences,
} from "./host/contracts";

type Layout = WorkbenchPreferences["layout"];
type PreferenceUpdate = { theme?: ThemeId; layout?: Partial<Layout> };
type PreferenceListener = (value: WorkbenchPreferences, temporary: boolean) => void;

export function normalizePreferences(input: unknown): WorkbenchPreferences {
  const value: WorkbenchPreferences = {
    version: 1,
    theme: "light",
    layout: {
      explorer: true,
      source: true,
      visualization: true,
      inspector: true,
      sourceFraction: 0.46,
    },
  };
  if (!input || typeof input !== "object" || Array.isArray(input)) return value;
  const record = input as Record<string, unknown>;
  if (record.version !== 1) return value;
  if (
    record.theme === "light" || record.theme === "dark" ||
    record.theme === "soft-light" || record.theme === "soft-dark"
  ) value.theme = record.theme;
  if (record.layout && typeof record.layout === "object" && !Array.isArray(record.layout)) {
    const layout = record.layout as Record<string, unknown>;
    for (const key of ["explorer", "source", "visualization", "inspector"] as const) {
      if (typeof layout[key] === "boolean") value.layout[key] = layout[key];
    }
    if (typeof layout.sourceFraction === "number" && Number.isFinite(layout.sourceFraction)) {
      value.layout.sourceFraction = Math.max(0.25, Math.min(0.7, layout.sourceFraction));
    }
  }
  return value;
}

/** Global preferences only; project buffers and runtime state never enter this record. */
export class PreferencesController {
  private state: WorkbenchPreferences;
  private failed = false;
  private readonly listeners = new Set<PreferenceListener>();
  private pending: WorkbenchPreferences | null = null;
  private saving = false;
  private failureGeneration = 0;
  private readonly store: PreferencesStore;

  private constructor(store: PreferencesStore, value: WorkbenchPreferences) {
    this.store = store;
    Object.freeze(value.layout);
    this.state = Object.freeze(value);
  }

  static async load(store: PreferencesStore): Promise<PreferencesController> {
    try {
      return new PreferencesController(store, normalizePreferences(await store.load()));
    } catch {
      const controller = new PreferencesController(store, normalizePreferences(null));
      controller.failed = true;
      return controller;
    }
  }

  get value(): WorkbenchPreferences {
    return this.state;
  }

  get temporary(): boolean {
    return this.failed;
  }

  subscribe(listener: PreferenceListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  update(partial: PreferenceUpdate): void {
    const next = normalizePreferences({
      version: 1,
      theme: partial.theme ?? this.state.theme,
      layout: { ...this.state.layout, ...partial.layout },
    });
    const previous = this.state;
    const unchanged = next.theme === previous.theme &&
      next.layout.explorer === previous.layout.explorer &&
      next.layout.source === previous.layout.source &&
      next.layout.visualization === previous.layout.visualization &&
      next.layout.inspector === previous.layout.inspector &&
      next.layout.sourceFraction === previous.layout.sourceFraction;
    if (unchanged && !this.failed) return;
    Object.freeze(next.layout);
    this.state = Object.freeze(next);
    // Replace queued writes, but never run a second write alongside the active one.
    this.pending = next;
    this.notify();
    void this.persist();
  }

  resetLayout(): void {
    this.update({ layout: normalizePreferences(null).layout });
  }

  reportFailure(): void {
    this.failureGeneration++;
    if (!this.failed) {
      this.failed = true;
      this.notify();
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.state, this.failed);
  }

  private async persist(): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    try {
      while (this.pending) {
        const value = this.pending;
        const generation = this.failureGeneration;
        this.pending = null;
        try {
          await this.store.save(value);
          if (!this.pending && generation === this.failureGeneration && this.failed) {
            this.failed = false;
            this.notify();
          }
        } catch {
          this.reportFailure();
        }
      }
    } finally {
      this.saving = false;
    }
  }
}
