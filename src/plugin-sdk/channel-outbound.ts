import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { resolveTextChunkLimit } from "../auto-reply/chunk.js";
import {
  getReplyPayloadMetadata,
  type ReplyPayload as CoreReplyPayload,
} from "../auto-reply/reply-payload.js";
import type {
  DurableMessageBatchSendResult,
  DurableMessageSendContext,
  DurableMessageSendContextParams,
} from "../channels/message/runtime.js";
import {
  type ChannelMessageAdapterShape,
  type ChannelMessageLiveCapability,
  type ChannelMessageReceiveAckPolicy,
  type DurableFinalDeliveryCapability,
  type DurableFinalDeliveryRequirementMap,
  type LivePreviewFinalizerCapability,
  channelMessageLiveCapabilities,
  channelMessageReceiveAckPolicies,
  durableFinalDeliveryCapabilities,
  livePreviewFinalizerCapabilities,
} from "../channels/message/types.js";
import type { ChannelId } from "../channels/plugins/types.core.js";
import {
  resolveChannelProgressDraftConfig as readProgressDraftConfig,
  type StreamingCompatEntry as ProgressDraftCompatEntry,
  resolveChannelStreamingPreviewChunk,
  type StreamingCompatEntry,
} from "../channels/streaming.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { classifyGatewayStaleInstall } from "../gateway/stale-install.js";
import { formatErrorMessage } from "../infra/errors.js";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import { preserveReplyPayloadMediaSelectionCore } from "../infra/outbound/reply-media-entries.js";
import { resolveChannelAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { ReplyPayload } from "./reply-payload.js";

const MIN_TRUNCATED_FINAL_PREFIX_CHARS = 48;
const MIN_TRUNCATED_FINAL_CONTINUATION_CHARS = 24;

function stripTrailingEllipsis(text: string): string {
  // Start at a whitespace-run boundary instead of retrying every blank line.
  return text.replace(/(?<!\s)(?:\s*(?:\.{3}|\u2026))+$/u, "").trimEnd();
}

export function isPotentialTruncatedFinal(finalText: string): boolean {
  const trimmedFinal = finalText.trimEnd();
  const untruncatedFinal = stripTrailingEllipsis(trimmedFinal);
  return (
    untruncatedFinal.length >= MIN_TRUNCATED_FINAL_PREFIX_CHARS && untruncatedFinal !== trimmedFinal
  );
}

export function selectLongerFinalText(params: {
  finalText: string;
  candidateTexts: readonly (string | undefined)[];
}): string | undefined {
  const finalText = params.finalText.trimEnd();
  if (!isPotentialTruncatedFinal(finalText)) {
    return undefined;
  }
  const untruncatedFinal = stripTrailingEllipsis(finalText);
  for (const candidate of params.candidateTexts) {
    const candidateText = candidate?.trimEnd();
    if (
      !candidateText ||
      candidateText.length <= finalText.length ||
      !candidateText.startsWith(untruncatedFinal)
    ) {
      continue;
    }
    const continuation = candidateText.slice(untruncatedFinal.length).trimStart();
    if (
      continuation.length >= MIN_TRUNCATED_FINAL_CONTINUATION_CHARS &&
      /^[\p{L}\p{N}]/u.test(continuation)
    ) {
      return candidateText;
    }
  }
  return undefined;
}

export async function resolveTranscriptBackedChannelFinalText(params: {
  // Optional: shipped plugin callers pass only text; an answer to a preceding input keeps its own text.
  payload?: CoreReplyPayload;
  finalText: string;
  resolveCandidateText: () => Promise<string | undefined>;
}): Promise<string> {
  if (
    (params.payload && getReplyPayloadMetadata(params.payload)?.precedingInputAnswer) ||
    !isPotentialTruncatedFinal(params.finalText)
  ) {
    return params.finalText;
  }
  const candidateText = await params.resolveCandidateText();
  return (
    selectLongerFinalText({
      finalText: params.finalText,
      candidateTexts: [candidateText],
    }) ?? params.finalText
  );
}

/** Named ingress error factory shared by channel payload and admission failures. */
type ChannelIngressErrorClass<TError extends Error, TArgs extends unknown[]> = {
  new (...args: TArgs): TError;
  readonly name: string;
  readonly prototype: TError;
};

export function createChannelIngressError(
  name: string,
): ChannelIngressErrorClass<Error, [message: string, options?: ErrorOptions]>;
export function createChannelIngressError<TReason extends string>(
  name: string,
  options: { withReason: true },
): ChannelIngressErrorClass<
  Error & { readonly reason: TReason },
  [reason: TReason, message: string, errorOptions?: ErrorOptions]
>;
export function createChannelIngressError(
  name: string,
  options?: { withReason?: boolean },
): unknown {
  const IngressError = class extends Error {
    declare readonly reason?: string;

    constructor(first: string, second?: string | ErrorOptions, third?: ErrorOptions) {
      const reasoned = options?.withReason === true;
      const message = reasoned && typeof second === "string" ? second : first;
      const errorOptions = reasoned ? third : typeof second === "string" ? undefined : second;
      super(message, errorOptions);
      this.name = name;
      if (reasoned) {
        this.reason = first;
      }
    }
  };
  Object.defineProperty(IngressError, "name", { configurable: true, value: name });
  return IngressError;
}

const DEFAULT_DRAFT_STREAM_MIN = 200;
const DEFAULT_DRAFT_STREAM_MAX = 800;

export type ChannelDraftStreamingChunking = {
  minChars: number;
  maxChars: number;
  breakPreference: "paragraph" | "newline" | "sentence";
};

type ChannelDraftStreamingConfig = StreamingCompatEntry & {
  accounts?: Record<string, StreamingCompatEntry | undefined>;
};

export function resolveChannelDraftStreamingChunking(
  cfg: OpenClawConfig | undefined,
  channelId: ChannelId,
  accountId: string | null | undefined,
  opts: { fallbackLimit: number },
): ChannelDraftStreamingChunking {
  const textLimit = resolveTextChunkLimit(cfg, channelId, accountId, {
    fallbackLimit: opts.fallbackLimit,
  });
  const normalizedAccountId = normalizeAccountId(accountId);
  const channelCfg = cfg?.channels?.[channelId] as ChannelDraftStreamingConfig | undefined;
  const accountCfg = resolveChannelAccountEntry(
    channelCfg?.accounts,
    normalizedAccountId,
    channelId,
  );
  const draftCfg =
    resolveChannelStreamingPreviewChunk(accountCfg) ??
    resolveChannelStreamingPreviewChunk(channelCfg);

  const maxRequested = Math.max(1, Math.floor(draftCfg?.maxChars ?? DEFAULT_DRAFT_STREAM_MAX));
  const maxChars = Math.max(1, Math.min(maxRequested, textLimit));
  const minRequested = Math.max(1, Math.floor(draftCfg?.minChars ?? DEFAULT_DRAFT_STREAM_MIN));
  const minChars = Math.min(minRequested, maxChars);
  const breakPreference =
    draftCfg?.breakPreference === "newline" || draftCfg?.breakPreference === "sentence"
      ? draftCfg.breakPreference
      : "paragraph";
  return { minChars, maxChars, breakPreference };
}

export type StallWatchdogTimeoutMeta = {
  idleMs: number;
  timeoutMs: number;
};

/** Public control surface for a transport stall watchdog instance. */
export type ArmableStallWatchdog = ReturnType<typeof createArmableStallWatchdog>;

/** Creates a watchdog that reports once when an armed transport goes idle. */
export function createArmableStallWatchdog(params: {
  label: string;
  timeoutMs: number;
  checkIntervalMs?: number;
  abortSignal?: AbortSignal;
  runtime?: RuntimeEnv;
  onTimeout: (meta: StallWatchdogTimeoutMeta) => void;
}) {
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
  const defaultCheckIntervalMs = Math.min(5_000, Math.max(250, timeoutMs / 6));
  const checkIntervalMs = resolveTimerTimeoutMs(
    params.checkIntervalMs,
    defaultCheckIntervalMs,
    100,
  );

  let armed = false;
  let stopped = false;
  let lastActivityAt = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;

  const report = (message: string) => {
    try {
      params.runtime?.error?.(message);
    } catch {
      // Synchronous reporter failures must not escape this timer boundary.
    }
  };
  const reportTimeoutFailure = (error: unknown) =>
    report(`[${params.label}] transport watchdog timeout handler failed: ${String(error)}`);

  const clearTimer = () => {
    clearInterval(timer ?? undefined);
    timer = null;
  };

  const disarm = () => {
    armed = false;
  };

  const stop = () => {
    stopped = true;
    disarm();
    clearTimer();
    params.abortSignal?.removeEventListener("abort", stop);
  };

  const arm = (atMs?: number) => {
    if (stopped) {
      return;
    }
    lastActivityAt = atMs ?? Date.now();
    armed = true;
  };

  const touch = (atMs?: number) => {
    if (stopped) {
      return;
    }
    lastActivityAt = atMs ?? Date.now();
  };

  const check = () => {
    if (!armed || stopped) {
      return;
    }
    const now = Date.now();
    const idleMs = now - lastActivityAt;
    if (idleMs < timeoutMs) {
      return;
    }
    // Disarm before invoking onTimeout so retries or teardown cannot fire a
    // second timeout from the same idle interval.
    disarm();
    report(
      `[${params.label}] transport watchdog timeout: idle ${Math.round(idleMs / 1000)}s (limit ${Math.round(timeoutMs / 1000)}s)`,
    );
    try {
      void Promise.resolve(params.onTimeout({ idleMs, timeoutMs })).catch(reportTimeoutFailure);
    } catch (error) {
      reportTimeoutFailure(error);
    }
  };

  if (params.abortSignal?.aborted) {
    stop();
  } else {
    params.abortSignal?.addEventListener("abort", stop, { once: true });
    timer = setInterval(check, checkIntervalMs);
    timer.unref?.();
  }

  return {
    arm,
    touch,
    disarm,
    stop,
    isArmed: () => armed,
  };
}

type ContractProofs<TKey extends string> = Partial<Record<TKey, () => Promise<void> | void>>;
type ProofStatus = "verified" | "not_declared";
type CapabilityProofResult<TKey extends string> = { capability: TKey; status: ProofStatus };

async function verifyContractProofs<TKey extends string, TResult>(params: {
  keys: readonly TKey[];
  isDeclared: (key: TKey) => boolean;
  proofs: ContractProofs<TKey>;
  missingProofError: (key: TKey) => string;
  result: (key: TKey, status: ProofStatus) => TResult;
}): Promise<TResult[]> {
  const results: TResult[] = [];
  for (const key of params.keys) {
    if (!params.isDeclared(key)) {
      results.push(params.result(key, "not_declared"));
      continue;
    }
    const proof = params.proofs[key];
    if (!proof) {
      throw new Error(params.missingProofError(key));
    }
    await proof();
    results.push(params.result(key, "verified"));
  }
  return results;
}

export async function verifyDurableFinalCapabilityProofs(params: {
  adapterName: string;
  capabilities?: DurableFinalDeliveryRequirementMap;
  proofs: ContractProofs<DurableFinalDeliveryCapability>;
}): Promise<CapabilityProofResult<DurableFinalDeliveryCapability>[]> {
  return await verifyContractProofs({
    keys: durableFinalDeliveryCapabilities,
    isDeclared: (capability) => params.capabilities?.[capability] === true,
    proofs: params.proofs,
    missingProofError: (capability) =>
      `${params.adapterName} declares durable final capability "${capability}" without a contract proof`,
    result: (capability, status) => ({ capability, status }),
  });
}

export async function verifyChannelMessageAdapterCapabilityProofs(params: {
  adapterName: string;
  adapter: Pick<ChannelMessageAdapterShape, "durableFinal">;
  proofs: ContractProofs<DurableFinalDeliveryCapability>;
}): Promise<CapabilityProofResult<DurableFinalDeliveryCapability>[]> {
  return await verifyDurableFinalCapabilityProofs({
    adapterName: params.adapterName,
    capabilities: params.adapter.durableFinal?.capabilities,
    proofs: params.proofs,
  });
}

export async function verifyChannelMessageReceiveAckPolicyAdapterProofs(params: {
  adapterName: string;
  adapter: Pick<ChannelMessageAdapterShape, "receive">;
  proofs: ContractProofs<ChannelMessageReceiveAckPolicy>;
}): Promise<{ policy: ChannelMessageReceiveAckPolicy; status: ProofStatus }[]> {
  const { adapterName } = params;
  const receive = params.adapter.receive;
  const declared = new Set(
    receive?.supportedAckPolicies?.length
      ? receive.supportedAckPolicies
      : receive?.defaultAckPolicy
        ? [receive.defaultAckPolicy]
        : [],
  );
  return await verifyContractProofs({
    keys: channelMessageReceiveAckPolicies,
    isDeclared: (policy) => declared.has(policy),
    proofs: params.proofs,
    missingProofError: (policy) =>
      `${adapterName} declares receive ack policy "${policy}" without a contract proof`,
    result: (policy, status) => ({ policy, status }),
  });
}

export async function verifyChannelMessageLiveFinalizerProofs(params: {
  adapterName: string;
  adapter: Pick<ChannelMessageAdapterShape, "live">;
  proofs: ContractProofs<LivePreviewFinalizerCapability>;
}): Promise<CapabilityProofResult<LivePreviewFinalizerCapability>[]> {
  const { adapterName } = params;
  const capabilities = params.adapter.live?.finalizer?.capabilities;
  return await verifyContractProofs({
    keys: livePreviewFinalizerCapabilities,
    isDeclared: (capability) => capabilities?.[capability] === true,
    proofs: params.proofs,
    missingProofError: (capability) =>
      `${adapterName} declares live preview finalizer capability "${capability}" without a contract proof`,
    result: (capability, status) => ({ capability, status }),
  });
}

export async function verifyChannelMessageLiveCapabilityAdapterProofs(params: {
  adapterName: string;
  adapter: Pick<ChannelMessageAdapterShape, "live">;
  proofs: ContractProofs<ChannelMessageLiveCapability>;
}): Promise<CapabilityProofResult<ChannelMessageLiveCapability>[]> {
  const { adapterName } = params;
  const capabilities = params.adapter.live?.capabilities;
  return await verifyContractProofs({
    keys: channelMessageLiveCapabilities,
    isDeclared: (capability) => capabilities?.[capability] === true,
    proofs: params.proofs,
    missingProofError: (capability) =>
      `${adapterName} declares live capability "${capability}" without a contract proof`,
    result: (capability, status) => ({ capability, status }),
  });
}

export type MessageAckPolicy = ChannelMessageReceiveAckPolicy;

type MessageAckStage = "receive_record" | "agent_dispatch" | "durable_send" | "manual";

type MessageAckState = "pending" | "acked" | "nacked";

/** Mutable receive context passed through durable inbound message processing. */
export type MessageReceiveContext<TMessage = unknown> = {
  id: string;
  channel: string;
  accountId?: string;
  message: TMessage;
  ackPolicy: MessageAckPolicy;
  ackState: MessageAckState;
  ackedAt?: number;
  nackErrorMessage?: string;
  receivedAt: number;
  signal: AbortSignal;
  shouldAckAfter(stage: MessageAckStage): boolean;
  ack(): Promise<void>;
  nack(error: unknown): Promise<void>;
};

const neverAbortedSignal = new AbortController().signal;

const ackStages: Record<MessageAckPolicy, MessageAckStage | undefined> = {
  after_receive_record: "receive_record",
  after_agent_dispatch: "agent_dispatch",
  after_durable_send: "durable_send",
  manual: undefined,
};

/** Creates a receive context with idempotent ack and explicit nack state transitions. */
export function createMessageReceiveContext<TMessage>(params: {
  id: string;
  channel: string;
  accountId?: string;
  message: TMessage;
  ackPolicy?: MessageAckPolicy;
  receivedAt?: number;
  signal?: AbortSignal;
  onAck?: () => Promise<void> | void;
  onNack?: (error: unknown) => Promise<void> | void;
}): MessageReceiveContext<TMessage> {
  let nackInFlight: Promise<void> | undefined;
  const ctx: MessageReceiveContext<TMessage> = {
    id: params.id,
    channel: params.channel,
    ...(params.accountId ? { accountId: params.accountId } : {}),
    message: params.message,
    ackPolicy: params.ackPolicy ?? "after_receive_record",
    ackState: "pending",
    receivedAt: params.receivedAt ?? Date.now(),
    signal: params.signal ?? neverAbortedSignal,
    shouldAckAfter: (stage) => ackStages[ctx.ackPolicy] === stage,
    ack: async () => {
      // Ack callbacks must be idempotent because receive pipelines may revisit completed stages.
      if (ctx.ackState === "acked") {
        return;
      }
      await params.onAck?.();
      ctx.ackState = "acked";
      ctx.ackedAt = Date.now();
      delete ctx.nackErrorMessage;
    },
    nack: async (error) => {
      // Share overlapping callbacks; clear rejected work so a later call can retry.
      if (ctx.ackState === "nacked") {
        return;
      }
      if (nackInFlight) {
        await nackInFlight;
        return;
      }
      nackInFlight = (async () => {
        await params.onNack?.(error);
        ctx.ackState = "nacked";
        ctx.nackErrorMessage = formatErrorMessage(error);
      })();
      try {
        await nackInFlight;
      } finally {
        nackInFlight = undefined;
      }
    },
  };
  return ctx;
}

export { isCompleteAgentPreamble } from "../agents/agent-activity-presentation.js";

type ChannelDurableDeliveryModule = typeof import("../channels/turn/durable-delivery.js");
// Share one lazy import across SDK helper calls so plugin barrels do not eagerly pull
// message runtime internals into registration/discovery-only paths.
const loadChannelMessageRuntimeModule = createLazyRuntimeModule(
  () => import("../channels/message/runtime.js"),
);

export type { DurableMessageBatchSendResult } from "../channels/message/runtime.js";
export {
  isRecentOutboundMessageIdentity,
  recordOutboundMessageIdentity,
} from "../channels/message/outbound-echo.js";
export type { OutboundMessageIdentity } from "../channels/message/outbound-echo.js";
export {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressDrain,
  // Narrow drain seam by maintainer decision (#108924): factory, lifecycle binding,
  // tuning constants, and processPidFromOwnerId (telegram transport display). All other
  // claim/retry/adoption internals stay core-owned; test helpers live on the
  // private-local plugin-state-test-runtime subpath.
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
} from "../channels/message/ingress-drain.js";
export {
  CHANNEL_INGRESS_RETENTION_DEFAULTS,
  createChannelIngressMonitor,
} from "../channels/message/ingress-monitor.js";
export {
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
} from "../channels/message/ingress-retry-policy.js";
export {
  INGRESS_CLAIM_PROCESS_ID,
  processPidFromOwnerId,
} from "../channels/message/ingress-claim-owner.js";
export {
  createChannelReplyPipeline as createChannelMessageReplyPipeline,
  createReplyPrefixContext,
  createReplyPrefixOptions,
  createTypingCallbacks,
  resolveChannelSourceReplyDeliveryMode as resolveChannelMessageSourceReplyDeliveryMode,
} from "../channels/message/reply-pipeline.js";
export type {
  ChannelReplyPipeline,
  CreateTypingCallbacksParams,
  ReplyPrefixContext,
  ReplyPrefixContextBundle,
  ReplyPrefixOptions,
  SourceReplyDeliveryMode,
  TypingCallbacks,
} from "../channels/message/reply-pipeline.js";
// Bare interval/stop orchestration for channels that own their typing renewal
// policy (e.g. per-message reply budgets) instead of the createTypingCallbacks lifecycle.
export { createTypingKeepaliveLoop } from "../channels/typing-lifecycle.js";

export {
  clearFinalizableDraftMessage,
  createFinalizableDraftLifecycle,
  createFinalizableDraftStreamControls,
  createFinalizableDraftStreamControlsForState,
  takeMessageIdAfterStop,
  type FinalizableDraftStreamState,
} from "../channels/draft-stream-controls.js";

export { createDraftStreamLoop, type DraftStreamLoop } from "../channels/draft-stream-loop.js";
export { createRunStateMachine } from "../channels/run-state-machine.js";

export { createRuntimeOutboundDelegates } from "../channels/plugins/runtime-forwarders.js";
export {
  createAccountStatusSink,
  createChannelRunQueue,
  keepHttpServerTaskAlive,
  runPassiveAccountLifecycle,
  waitUntilAbort,
  type ChannelRunQueue,
  type ChannelRunQueueParams,
  type ChannelRunQueueTaskContext,
} from "./channel-lifecycle.core.js";
export {
  createOutboundPayloadPlan,
  createStructuredOutboundPayloadPlan,
  projectOutboundPayloadPlanForDelivery,
} from "../infra/outbound/payloads.js";
export { collectReplyMediaEntries } from "../infra/outbound/reply-media-entries.js";

/** Keep the current operation media selection when recovering other reply fields. */
export function preserveReplyPayloadMediaSelection(
  source: ReplyPayload,
  recovered: ReplyPayload,
): ReplyPayload {
  return preserveReplyPayloadMediaSelectionCore(source, recovered);
}

export type { OutboundPayloadPlan } from "../infra/outbound/reply-payload-parts.js";
export { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
export type { OutboundSessionContext } from "../infra/outbound/session-context.js";
export type { OutboundDeliveryFormattingOptions } from "../infra/outbound/formatting.js";
export { resolveAgentOutboundIdentity } from "../infra/outbound/identity.js";
export type { OutboundIdentity } from "../infra/outbound/identity.js";
export { createReplyToFanout } from "../infra/outbound/reply-policy.js";
export type { ReplyToResolution } from "../infra/outbound/reply-policy.js";
export { resolveOutboundSendDep } from "../infra/outbound/send-deps.js";
export type { OutboundSendDeps } from "../infra/outbound/send-deps.js";
export { sanitizeForPlainText } from "../infra/outbound/sanitize-text.js";
export { logTypingFailure } from "../channels/logging.js";
export {
  buildChannelProgressDraftLine,
  buildChannelProgressDraftLineForEntry,
  createChannelProgressDraftGate,
  formatChannelProgressDraftLine,
  formatChannelProgressDraftLineForEntry,
  formatChannelProgressDraftText,
  getChannelStreamingConfigObject,
  isChannelProgressDraftWorkToolName,
  formatPlanChecklistLines,
  selectPlanChecklistSteps,
  compactChannelProgressDraftLine,
  isChannelProgressAttentionLine,
  mergeChannelProgressDraftLine,
  normalizeAgentPlanSteps,
  normalizeChannelProgressDraftLineIdentity,
  resolveChannelPreviewStreamMode,
  resolveChannelProgressDraftConfig,
  resolveChannelProgressDraftMaxLineChars,
  resolveChannelProgressDraftMaxLines,
  resolveChannelStreamingBlockCoalesce,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingChunkMode,
  resolveChannelStreamingNativeTransport,
  resolveChannelStreamingPreviewCommandText,
  resolveChannelStreamingPreviewToolProgress,
  resolveChannelStreamingProgressCommentary,
  resolveChannelStreamingProgressNarration,
  resolveChannelStreamingSuppressDefaultToolProgressMessages,
} from "../channels/streaming.js";
export type {
  AgentPlanStep,
  AgentPlanStepStatus,
  ChannelDeliveryStreamingConfig,
  ChannelPreviewStreamingConfig,
  ChannelProgressDraftLine,
  ChannelStreamingBlockConfig,
  ChannelStreamingProgressConfig,
  StreamingMode,
  TextChunkMode,
} from "../channels/streaming.js";
export {
  createChannelProgressDraftCompositor,
  createChannelProgressWorkCounter,
} from "../channels/progress-draft-compositor.js";
export { formatChannelProgressDraftDiffStat } from "../channels/progress-draft-diffstat.js";

/** @deprecated The streaming.progress.render key was retired (#122927). */
export type ChannelProgressDraftRenderMode = "rich" | "text";

/**
 * @deprecated Load-only bridge: the published Slack channel package
 * (2026.7.2-beta.7 and earlier) imports this at module top level, so removing
 * it makes the installed plugin fail to load after a core upgrade. The config
 * key it read is retired and doctor strips it, so this resolves the same
 * "text"/"rich" answer pre-doctor configs produced and the default otherwise.
 * Remove once managed releases have replaced the old npm latest/extended-stable
 * packages and their upgrade window has closed.
 */
export function resolveChannelProgressDraftRender(
  entry: ProgressDraftCompatEntry | null | undefined,
  defaultValue: ChannelProgressDraftRenderMode = "text",
): ChannelProgressDraftRenderMode {
  const configured = (readProgressDraftConfig(entry) as { render?: unknown }).render;
  return configured === "rich" || configured === "text" ? configured : defaultValue;
}
export type {
  ChannelProgressDraftCompositorLine,
  ChannelProgressDraftCompositorSnapshot,
} from "../channels/progress-draft-compositor.js";
export { deriveDurableFinalDeliveryRequirements } from "../channels/message/capabilities.js";
export { defineChannelMessageAdapter } from "../channels/message/adapter.js";
export { createChannelMessageAdapterFromOutbound } from "../channels/message/outbound-bridge.js";
export { createDurableInboundReceiveJournalFromQueue } from "../channels/message/durable-receive.js";
export {
  createLivePreviewLifecycle,
  createPreviewMessageReceipt,
  defineFinalizableLivePreviewAdapter,
  deliverWithFinalizableLivePreviewAdapter,
} from "../channels/message/live.js";
export type { LivePreviewDeliveryResult, LivePreviewLifecycle } from "../channels/message/live.js";
export { createChannelDeliveryAccumulator } from "../channels/turn/delivery-result.js";
export {
  createMessageReceiptFromOutboundResults,
  listMessageReceiptPlatformIds,
  resolveMessageReceiptPrimaryId,
} from "../channels/message/receipt.js";
export type { ChannelIngressDrain } from "../channels/message/ingress-drain.js";
export type {
  ChannelIngressMonitorDeliveryResult,
  ChannelIngressMonitorLifecycle,
} from "../channels/message/ingress-monitor.js";
export type {
  ChannelIngressQueue,
  ChannelIngressQueueClaim,
  ChannelIngressQueueClaimRef,
  ChannelIngressQueueCorruptClaim,
  ChannelIngressQueueRecord,
} from "../channels/message/ingress-queue.js";
export type {
  ChannelMessageAdapterShape,
  ChannelMessageDurableFinalAdapter,
  ChannelMessageSendMediaContext,
  ChannelMessageSendPayloadContext,
  ChannelMessageSendResult,
  ChannelMessageSendTextContext,
  ChannelMessageUnknownSendContext,
  ChannelMessageUnknownSendReconciliationResult,
  MessageReceipt,
  MessageReceiptPart,
  MessageReceiptPartKind,
  MessageReceiptSourceResult,
} from "../channels/message/types.js";

async function loadChannelDurableDeliveryModule(): Promise<ChannelDurableDeliveryModule> {
  return await import("../channels/turn/durable-delivery.js").catch((error: unknown) => {
    const staleInstall = classifyGatewayStaleInstall(error);
    // Only import failure proves no send: errors from the delivery runtime may be ambiguous.
    throw new PlatformMessageNotDispatchedError(
      staleInstall?.error.message ?? "Reply delivery runtime could not load before dispatch",
      { cause: error },
    );
  });
}

/** Lazily forwards inbound reply delivery through the channel turn durable-delivery module. */
export const deliverInboundReplyWithMessageSendContext: ChannelDurableDeliveryModule["deliverInboundReplyWithMessageSendContextCore"] =
  async (...args) => {
    const mod = await loadChannelDurableDeliveryModule();
    return await mod.deliverInboundReplyWithMessageSendContextCore(...args);
  };

/** Delivers a producer's prepared plan without reparsing literal text. */
export const deliverStructuredInboundReplyWithMessageSendContext: ChannelDurableDeliveryModule["deliverStructuredInboundReplyWithMessageSendContextCore"] =
  async (...args) => {
    const mod = await loadChannelDurableDeliveryModule();
    return await mod.deliverStructuredInboundReplyWithMessageSendContextCore(...args);
  };

/** Sends a durable message batch without eager-loading channel message runtime internals. */
export async function sendDurableMessageBatch(
  /**
   * Durable send context and outbound batch data forwarded to the channel runtime.
   */
  params: DurableMessageSendContextParams,
): Promise<DurableMessageBatchSendResult> {
  const mod = await loadChannelMessageRuntimeModule();
  return await mod.sendDurableMessageBatchCore(params);
}

/** Runs work inside a durable message send context loaded through the SDK lazy boundary. */
export async function withDurableMessageSendContext<T>(
  /**
   * Durable send context used to bind sends, receipts, and lifecycle callbacks.
   */
  params: DurableMessageSendContextParams,
  /**
   * Callback executed with the loaded durable-send runtime context.
   */
  run: (ctx: DurableMessageSendContext) => Promise<T>,
): Promise<T> {
  const mod = await loadChannelMessageRuntimeModule();
  return await mod.withDurableMessageSendContextCore(params, run);
}
