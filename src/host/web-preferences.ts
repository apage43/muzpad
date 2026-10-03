import type { Failure, PreferencesStore, WorkbenchPreferences } from "./contracts";

const KEY = "muzpad-preferences-v1";

/** Storage denial never prevents the workbench from retaining this session's settings. */
export class WebPreferencesStore implements PreferencesStore {
  private memory: unknown | null = null;
  private storage: Storage | undefined;
  private readonly report: (failure: Failure) => void;
  constructor(report: (failure: Failure) => void, storage?: Storage) {
    this.report = report;
    try { this.storage = storage ?? globalThis.localStorage; }
    catch (error) { this.failed(error); }
  }
  private failed(error: unknown) {
    const failure: Failure = { code: "permission_denied", phase: "project", continuity: "preserved",
      message: `Preferences could not be stored: ${error instanceof Error ? error.message : String(error)}. Settings remain available for this session; allow browser storage to persist them.` };
    this.report(failure);
    return Object.assign(new Error(failure.message), failure);
  }
  async load(): Promise<unknown | null> {
    if (!this.storage) return this.memory;
    try {
      const stored = this.storage.getItem(KEY);
      if (stored) {
        try {
          const value = JSON.parse(stored);
          if (value && typeof value === "object" && !Array.isArray(value) && value.version === 1) {
            this.memory = value;
            return value;
          }
        } catch { /* An invalid versioned record may still have valid legacy settings. */ }
      }
      const theme = this.storage.getItem("muzpad-theme");
      const inspector = this.storage.getItem("muzpad-inspector");
      const value: WorkbenchPreferences = {
        version: 1,
        theme: theme === "light" || theme === "dark" ? theme : "light",
        layout: { explorer: true, source: true, visualization: true,
          inspector: inspector !== "closed", sourceFraction: 0.46 },
      };
      this.memory = value;
      await this.save(value);
      return value;
    } catch (error) { this.failed(error); return this.memory; }
  }
  async save(value: WorkbenchPreferences): Promise<void> {
    this.memory = structuredClone(value);
    if (!this.storage) throw this.failed(new Error("Browser storage is unavailable"));
    try {
      this.storage.setItem(KEY, JSON.stringify(value));
      this.storage.removeItem("muzpad-theme");
      this.storage.removeItem("muzpad-inspector");
    } catch (error) { throw this.failed(error); }
  }
}
