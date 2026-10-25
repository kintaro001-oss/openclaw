import { hasLiveAgentRunContext } from "../../../infra/agent-run-registry.js";
import { ownsSwarmRunReservation } from "../swarm/swarm-scheduler.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  getSubagentRunRuntimeKey,
  isSameSubagentRunOwner,
  type SubagentRunIdentity,
} from "./subagent-run-generation.js";

/** Routing metadata alone does not own an execution. */
export function isSubagentRunLiveFromRuns(
  runs: ReadonlyMap<string, SubagentRunRecord>,
  entry:
    | (SubagentRunIdentity & { execution: Pick<SubagentRunRecord["execution"], "endedAt"> })
    | null
    | undefined,
): boolean {
  if (!entry || typeof entry.execution.endedAt === "number") {
    return false;
  }
  const current = runs.get(entry.runId);
  return Boolean(
    current &&
    typeof current.execution.endedAt !== "number" &&
    isSameSubagentRunOwner(current, entry) &&
    hasLiveAgentRunContext(entry.runId),
  );
}

/** Queued admission belongs to the exact current registration and scheduler reservation. */
export function isSubagentRunQueuedFromRuns(
  runs: ReadonlyMap<string, SubagentRunRecord>,
  entry: SubagentRunIdentity | null | undefined,
): boolean {
  const current = entry ? runs.get(entry.runId) : undefined;
  return Boolean(
    current &&
    current.collect &&
    current.execution.status === "queued" &&
    isSameSubagentRunOwner(current, entry) &&
    ownsSwarmRunReservation(
      current.schedulerSlotId ?? current.runId,
      getSubagentRunRuntimeKey(current),
    ),
  );
}
