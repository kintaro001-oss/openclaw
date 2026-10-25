import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { compareSubagentRunGeneration } from "./subagent-run-generation.js";

export class SubagentRunIndex extends Map<string, Map<string, SubagentRunRecord>> {
  private readonly latest = new Map<string, SubagentRunRecord>();

  constructor(private readonly keyFor: (entry: SubagentRunRecord) => string | undefined) {
    super();
  }

  update(runId: string, previous?: SubagentRunRecord, entry?: SubagentRunRecord): void {
    const previousKey = previous && this.keyFor(previous);
    const key = entry && this.keyFor(entry);
    if (previousKey && previousKey !== key) {
      const bucket = this.get(previousKey);
      if (bucket?.get(runId) === previous) {
        bucket.delete(runId);
        if (bucket.size === 0) {
          this.delete(previousKey);
          this.latest.delete(previousKey);
        } else if (this.latest.get(previousKey) === previous) {
          for (const remaining of bucket.values()) {
            this.latest.set(previousKey, remaining);
          }
        }
      }
    }
    if (!key || !entry) {
      return;
    }
    const bucket = this.get(key);
    if (bucket) {
      // Singleton status updates retain their bucket; larger groups keep replacement order.
      if (bucket.size > 1) {
        bucket.delete(runId);
      }
      bucket.set(runId, entry);
    } else {
      this.set(key, new Map([[runId, entry]]));
    }
    this.latest.set(key, entry);
  }

  getLatest(key: string): SubagentRunRecord | undefined {
    return this.latest.get(key);
  }

  override clear(): void {
    super.clear();
    this.latest.clear();
  }
}

type ChildController = { run: SubagentRunRecord; key: string | undefined };

function newerController(left: ChildController | undefined, right: ChildController | undefined) {
  return right && (!left || compareSubagentRunGeneration(right.run, left.run) > 0) ? right : left;
}

/** Derived controller facts share the registry's existing child membership and lifetime. */
export class SubagentChildControllerIndex {
  private readonly controllers = new Map<string, Map<string, Map<string, ChildController>>>();

  constructor(
    private readonly runs: ReadonlyMap<string, ReadonlyMap<string, SubagentRunRecord>>,
    private readonly eligible: (run: SubagentRunRecord, childSessionKey: string) => boolean,
  ) {}

  refresh(childSessionKey: string): void {
    let sessions: Map<string, Map<string, ChildController>> | undefined;
    for (const run of this.runs.get(childSessionKey)?.values() ?? []) {
      if (!this.eligible(run, childSessionKey)) {
        continue;
      }
      // Missing original fields are wildcards; comparison uses the recorded, untrimmed identity.
      const session = run.childSessionIdentity?.sessionId || "";
      const revision = run.childSessionIdentity?.lifecycleRevision || "";
      sessions ??= new Map();
      const revisions = sessions.get(session) ?? new Map<string, ChildController>();
      const previous = revisions.get(revision);
      if (!previous || compareSubagentRunGeneration(run, previous.run) > 0) {
        revisions.set(revision, {
          run,
          key:
            normalizeOptionalString(run.controllerSessionKey) ??
            normalizeOptionalString(run.requesterSessionKey),
        });
      }
      sessions.set(session, revisions);
    }
    if (sessions) {
      this.controllers.set(childSessionKey, sessions);
    } else {
      this.controllers.delete(childSessionKey);
    }
  }

  /** Four incarnation classes replace the live run scan, including partial legacy identities. */
  get(
    childSessionKey: string,
    session: { sessionId: string; lifecycleRevision?: string },
  ): string | undefined {
    const sessions = this.controllers.get(childSessionKey.trim());
    const wildcard = sessions?.get("");
    const exact = sessions?.get(session.sessionId);
    return newerController(
      newerController(wildcard?.get(""), wildcard?.get(session.lifecycleRevision ?? "")),
      newerController(exact?.get(""), exact?.get(session.lifecycleRevision ?? "")),
    )?.key;
  }

  clear(): void {
    this.controllers.clear();
  }
}
