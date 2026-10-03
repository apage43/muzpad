export type StatusChannel = "build" | "playback" | "save" | "recovery" | "operation";
export type ActionOutcome = "pending" | "applied" | "failed" | "rejected" | "partial" | "cancelled" | "superseded" | "unknown";
export interface ActionStatus {
  channel: StatusChannel;
  requestId: string;
  action: string;
  outcome: ActionOutcome;
  summary: string;
  nextAction: string;
  technical?: unknown;
  origin?: { project: string; epoch: string; title: string };
  location?: unknown;
}
/** A channel is changed only by its newest owned request, never by telemetry. */
export class WorkbenchStatus {
  readonly channels = new Map<StatusChannel, ActionStatus>();
  readonly issues = new Map<string, ActionStatus>();
  private readonly latest = new Map<StatusChannel, string>();
  begin(channel: StatusChannel, action: string, requestId: string = crypto.randomUUID()): string {
    const prior = this.channels.get(channel);
    if (prior && ["failed", "rejected", "partial", "unknown"].includes(prior.outcome)) this.retain(prior);
    this.latest.set(channel, requestId);
    this.channels.set(channel, { channel, requestId, action, outcome: "pending", summary: "Waiting for the authoritative outcome", nextAction: "You can continue editing." });
    return requestId;
  }
  /** Explicit terminal receipts remain visible even after a newer request owns the channel. */
  settle(status: ActionStatus, ownership: "explicit" | "background" = "explicit"): boolean {
    if (this.latest.get(status.channel) !== status.requestId) {
      if (ownership === "explicit" && status.outcome !== "pending") { this.retain(status); return true; }
      return false;
    }
    if (status.outcome === "applied" && (status.channel === "save" || status.channel === "recovery" || status.channel === "build"))
      for (const [id, issue] of this.issues)
        if (issue.channel === status.channel && issue.origin?.project === status.origin?.project && issue.origin?.epoch === status.origin?.epoch)
          this.issues.delete(id);
    this.channels.set(status.channel, status);
    return true;
  }
  report(status: ActionStatus): void { this.retain(status); }
  private retain(status: ActionStatus): void {
    this.issues.set(status.requestId, status);
    while (this.issues.size > 32) this.issues.delete(this.issues.keys().next().value!);
  }
  reset(): void { this.channels.clear(); this.latest.clear(); this.issues.clear(); }
}
export function describeActionFailure(error: unknown) {
  const outer = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const diagnostic = outer.diagnostic && typeof outer.diagnostic === "object" ? outer.diagnostic : error;
  const data = diagnostic && typeof diagnostic === "object" ? diagnostic as Record<string, unknown> : {};
  const operation = data.operation && typeof data.operation === "object" ? data.operation as Record<string, unknown> : {};
  const authoritative = operation.outcome;
  const outcome: ActionOutcome = authoritative === "applied" || authoritative === "rejected" || authoritative === "cancelled"
    || authoritative === "superseded" || authoritative === "unknown" || authoritative === "partial" ? authoritative
    : data.code === "cancelled" || outer.name === "AbortError" ? "cancelled" : "failed";
  return { diagnostic, operation, outcome,
    detail: typeof data.message === "string" ? data.message : error instanceof Error ? error.message : String(error),
    location: data.location, continuity: data.continuity,
    requestId: typeof operation.requestId === "string" ? operation.requestId : typeof data.requestId === "string" ? data.requestId : null };
}
export function technicalDetails(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item instanceof Error ? { ...item, name: item.name, message: item.message } : typeof item === "bigint" ? item.toString() : item, 2) ?? String(value);
}
/** Compare observation tickets only after the complete revision identity matches. */
export function olderObservation(candidate: { generation: string; sequence: string }, current: { generation: string; sequence: string }): boolean {
  const candidateGeneration = BigInt(candidate.generation), currentGeneration = BigInt(current.generation);
  return candidateGeneration < currentGeneration || (candidateGeneration === currentGeneration && BigInt(candidate.sequence) < BigInt(current.sequence));
}
