import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentConfig } from "../agents/agent-scope.js";
import { isControlCommandMessage } from "../auto-reply/command-detection.js";
import type { CommandNormalizeOptions } from "../auto-reply/commands-registry.js";
import { resolveEnvelopeFormatOptions } from "../auto-reply/envelope.js";
import type { TurnAdoptionLifecycle } from "../auto-reply/get-reply-options.types.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
  type InboundDebounceCreateParams,
} from "../auto-reply/inbound-debounce.js";
import type { DispatchFromConfigResult } from "../auto-reply/reply/dispatch-from-config.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import {
  buildChannelInboundEventContext,
  finalizeChannelInboundContext,
  filterChannelInboundQuoteContext,
  filterChannelInboundSupplementalContext,
  resolveInboundSupplementalSenderAllowed,
  type BuildChannelInboundEventContextAsyncParams,
  type BuildChannelInboundEventContextParams,
  type BuiltChannelInboundEventContext,
  type ChannelInboundSupplementalResolutionOptions,
  type FinalizeChannelInboundContextAsyncParams,
  type FinalizeChannelInboundContextParams,
  type FinalizeChannelInboundContextResult,
} from "../channels/inbound-event/context.js";
import {
  createChannelInboundEnvelopeBuilderAsync,
  resolveInboundRouteEnvelopeBuilderWithRuntime,
} from "../channels/inbound-event/envelope.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type {
  ChannelIngressContextBinding,
  ResolvedChannelMessageIngress,
} from "../channels/message-access/runtime-types.js";
import { createChannelReplyPipeline } from "../channels/message/reply-pipeline.js";
import { runPreparedChannelTurn } from "../channels/turn/execution.js";
import {
  dispatchAssembledChannelTurn,
  dispatchRoutedChannelTurn,
} from "../channels/turn/lifecycle.js";
import {
  recordDroppedChannelTurnHistory as recordDroppedChannelTurnHistoryInternal,
  runChannelTurn,
} from "../channels/turn/run-channel-turn.js";
import type {
  AssembledChannelTurn,
  ChannelCoreManagedTurnDeliveryAdapter,
  ChannelProviderOwnedMessageSendingDeliveryAdapter,
  ChannelTurnDeliveryAdapter,
  ChannelTurnPlan,
  ChannelTurnResult,
  PreparedChannelTurn,
  RunChannelTurnParams,
  ConversationFacts,
} from "../channels/turn/types.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import { readSessionUpdatedAtCore } from "../config/sessions/session-accessor.js";
import { readSessionUpdatedAtInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig as InboundDebounceConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import {
  publicChannelTurn,
  publicChannelTurnParams,
  type PublicChannelTurnParams,
  type PublicReplyParams,
} from "./reply-options.js";
import { normalizeOutboundReplyPayload, type OutboundReplyPayload } from "./reply-payload.js";

export {
  createPreCryptoDirectDmAuthorizer,
  resolveInboundDirectDmAccessWithRuntime,
  type AccessGroupMembershipResolver,
  type DirectDmCommandAuthorizationRuntime,
  type ResolvedInboundDirectDmAccess,
} from "../channels/direct-dm-access.js";
export {
  createDirectDmPreCryptoGuardPolicy,
  type DirectDmPreCryptoGuardPolicy,
  type DirectDmPreCryptoGuardPolicyOverrides,
} from "../channels/direct-dm-guard-policy.js";

type DirectDmRoutePeer = { kind: "direct"; id: string };
type DirectDmRoute = { agentId: string; sessionKey: string; accountId?: string };

type DispatchInboundDirectDmParams = {
  cfg: OpenClawConfig;
  channel: string;
  channelLabel: string;
  accountId: string;
  peer: DirectDmRoutePeer;
  senderId: string;
  senderAddress: string;
  recipientAddress: string;
  conversationLabel: string;
  rawBody: string;
  messageId: string;
  timestamp?: number;
  commandAuthorized?: boolean;
  turnAdoptionLifecycle?: TurnAdoptionLifecycle;
  /** Shipped SDK callers may omit provenance; bundled callers must classify it explicitly. */
  channelIngress?: ResolvedChannelMessageIngress | "unsupported";
  /** Resolve the exact admitted result after this helper owns the final route. */
  resolveChannelIngress?: (
    contextBinding: ChannelIngressContextBinding,
  ) => Promise<ResolvedChannelMessageIngress>;
  /** Opaque record-scoped runtime injected by a registered native channel. */
  channelRuntime?: { inbound?: { buildContext?: unknown } };
  /** Set only after the channel's sender/pairing guard admits this event. */
  inboundAccessAuthorized?: boolean;
  /** Recheck channel-owned live authority after preparation and at effect initiation. */
  assertAuthority?: () => void;
  bodyForAgent?: string;
  commandBody?: string;
  provider?: string;
  surface?: string;
  originatingChannel?: string;
  originatingTo?: string;
  extraContext?: Record<string, unknown>;
  deliver: (payload: OutboundReplyPayload) => Promise<void>;
  onRecordError: (err: unknown) => void;
  onDispatchError: (err: unknown, info: { kind: string }) => void;
};

export async function dispatchInboundDirectDm(params: DispatchInboundDirectDmParams): Promise<{
  route: DirectDmRoute;
  ctxPayload: FinalizedMsgContext;
}> {
  const route = resolveAgentRoute({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
  });
  const channelIngress = params.resolveChannelIngress
    ? await params.resolveChannelIngress({
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        messageId: params.messageId,
        inboundEventKind: "user_request",
      })
    : params.channelIngress;
  const boundParams =
    channelIngress === params.channelIngress ? params : { ...params, channelIngress };
  const buildEnvelope = await createChannelInboundEnvelopeBuilderAsync({ cfg: params.cfg, route });
  const body = buildEnvelope({
    channel: params.channelLabel,
    from: params.conversationLabel,
    body: params.rawBody,
    timestamp: params.timestamp,
  });
  const injectedBuilder = params.channelRuntime?.inbound?.buildContext;
  const buildContext =
    typeof injectedBuilder === "function"
      ? (injectedBuilder as typeof buildChannelInboundEventContext)
      : buildChannelInboundEventContext;
  const ctxPayload = await Promise.resolve(
    buildContext({
      channel: params.channel,
      accountId: route.accountId,
      provider: params.provider,
      surface: params.surface,
      messageId: params.messageId,
      messageIdFull: params.messageId,
      timestamp: params.timestamp,
      from: params.senderAddress,
      sender: { id: params.senderId, name: params.conversationLabel },
      conversation: {
        kind: "direct",
        id: params.peer.id,
        routePeer: params.peer,
        label: params.conversationLabel,
      },
      route: {
        agentId: route.agentId,
        accountId: route.accountId,
        routeSessionKey: route.sessionKey,
        dispatchSessionKey: route.sessionKey,
      },
      reply: {
        to: params.recipientAddress,
        originatingTo: params.originatingTo ?? params.senderAddress,
      },
      message: {
        body,
        bodyForAgent: params.bodyForAgent ?? params.rawBody,
        rawBody: params.rawBody,
        commandBody: params.commandBody ?? params.rawBody,
      },
      access: { commands: { authorized: params.commandAuthorized === true } },
      channelIngress: boundParams.channelIngress,
      extra: {
        NativeDirectUserId: params.peer.id,
        OriginatingChannel: params.originatingChannel ?? params.channel,
        ...params.extraContext,
      },
    }),
  );
  await dispatchRoutedChannelTurn(buildDirectDmTurnPlan(boundParams, route, ctxPayload));

  return { route, ctxPayload };
}

function buildDirectDmTurnPlan(
  params: DispatchInboundDirectDmParams,
  route: DirectDmRoute,
  ctxPayload: FinalizedMsgContext,
): ChannelTurnPlan {
  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: params.cfg,
    agentId: route.agentId,
    channel: params.channel,
    accountId: route.accountId ?? params.accountId,
  });

  return {
    cfg: params.cfg,
    channel: params.channel,
    accountId: route.accountId ?? params.accountId,
    route: { agentId: route.agentId, sessionKey: route.sessionKey },
    ctxPayload,
    assertAuthority: params.assertAuthority,
    record: {
      onRecordError: params.onRecordError,
    },
    delivery: {
      deliver: async (payload) => await params.deliver(normalizeOutboundReplyPayload(payload)),
      onError: params.onDispatchError,
    },
    replyPipeline,
    replyOptions: {
      onModelSelected,
      ...(params.turnAdoptionLifecycle
        ? { turnAdoptionLifecycle: params.turnAdoptionLifecycle }
        : {}),
    },
  };
}

/** @deprecated Use dispatchInboundDirectDm. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
export async function dispatchInboundDirectDmWithRuntime(
  params: Omit<DispatchInboundDirectDmParams, "resolveChannelIngress"> & {
    runtime: PluginRuntime;
  },
): Promise<{
  route: DirectDmRoute;
  storePath: string;
  ctxPayload: FinalizedMsgContext;
}> {
  warnPluginSdkDeprecation({
    family: "channel-inbound-envelope",
    method: "dispatchInboundDirectDmWithRuntime",
    replacement: "dispatchInboundDirectDm",
  });
  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
    runtime: params.runtime.channel,
    sessionStore: params.cfg.session?.store,
  });
  const { storePath, body } = buildEnvelope({
    channel: params.channelLabel,
    from: params.conversationLabel,
    body: params.rawBody,
    timestamp: params.timestamp,
  });
  const ctxPayload = params.runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: params.bodyForAgent ?? params.rawBody,
    RawBody: params.rawBody,
    CommandBody: params.commandBody ?? params.rawBody,
    From: params.senderAddress,
    To: params.recipientAddress,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? params.accountId,
    ChatType: "direct",
    ConversationLabel: params.conversationLabel,
    SenderId: params.senderId,
    Provider: params.provider ?? params.channel,
    Surface: params.surface ?? params.channel,
    MessageSid: params.messageId,
    MessageSidFull: params.messageId,
    Timestamp: params.timestamp,
    CommandAuthorized: params.commandAuthorized,
    ...(params.inboundAccessAuthorized === true
      ? { InboundAccessAuthorized: true, ConversationRouteContextObserved: true as const }
      : {}),
    ConversationRoutePeerId: params.peer.id,
    OriginatingChannel: params.originatingChannel ?? params.channel,
    OriginatingTo: params.originatingTo ?? params.senderAddress,
    NativeDirectUserId: params.peer.id,
    ...params.extraContext,
  });
  const plan = buildDirectDmTurnPlan(params, route, ctxPayload);
  await params.runtime.channel.inbound.run({
    channel: params.channel,
    accountId: route.accountId ?? params.accountId,
    raw: ctxPayload,
    adapter: {
      ingest: () => ({
        id: params.messageId,
        timestamp: params.timestamp,
        rawText: params.rawBody,
        textForAgent: params.bodyForAgent,
        textForCommands: params.commandBody,
        raw: ctxPayload,
      }),
      resolveTurn: () => plan,
    },
  });
  return { route, storePath, ctxPayload };
}

export function shouldDebounceTextInbound(params: {
  text: string | null | undefined;
  cfg: InboundDebounceConfig;
  hasMedia?: boolean;
  commandOptions?: CommandNormalizeOptions;
  allowDebounce?: boolean;
}): boolean {
  if (params.allowDebounce === false) {
    return false;
  }
  if (params.hasMedia) {
    // Media payloads carry per-message attachments; merging them into a debounced text batch can
    // detach the attachment metadata from the original inbound event.
    return false;
  }
  const text = normalizeOptionalString(params.text) ?? "";
  if (!text) {
    return false;
  }
  // Control commands must dispatch immediately so stop/abort/status requests are not delayed
  // behind normal conversation text.
  return !isControlCommandMessage(text, params.cfg, params.commandOptions);
}

/** Snapshot timing by default; resolveDebounceMs opts into per-entry timing. */
export function createChannelInboundDebouncer<T>(
  params: Omit<InboundDebounceCreateParams<T>, "debounceMs"> & {
    cfg: InboundDebounceConfig;
    channel: string;
    debounceMsOverride?: number;
  },
): {
  debounceMs: number;
  debouncer: ReturnType<typeof createInboundDebouncer<T>>;
} {
  const debounceMs = resolveInboundDebounceMs({
    cfg: params.cfg,
    channel: params.channel,
    overrideMs: params.debounceMsOverride,
  });
  const { cfg: _cfg, channel: _channel, debounceMsOverride: _override, ...rest } = params;
  // The lower-level debouncer only needs queue callbacks and timing. Strip config-only inputs so
  // future helper options do not accidentally leak into its runtime shape.
  const debouncer = createInboundDebouncer<T>({
    debounceMs,
    ...rest,
  });
  return { debounceMs, debouncer };
}

export type ClassifyChannelInboundEventParams = {
  conversation: Pick<ConversationFacts, "kind">;
  unmentionedGroupPolicy?: InboundEventKind;
  wasMentioned?: boolean;
  hasControlCommand?: boolean;
  hasAbortRequest?: boolean;
  commandSource?: "native" | "text";
};

export function classifyChannelInboundEvent(
  params: ClassifyChannelInboundEventParams,
): InboundEventKind {
  if (params.unmentionedGroupPolicy !== "room_event") {
    return "user_request";
  }
  if (params.conversation.kind !== "group" && params.conversation.kind !== "channel") {
    return "user_request";
  }
  // Native commands, mentions, control commands, and aborts are explicit user intent even when
  // unmentioned group traffic would otherwise be treated as passive room activity.
  if (
    params.wasMentioned === true ||
    params.hasControlCommand === true ||
    params.hasAbortRequest === true ||
    params.commandSource === "native"
  ) {
    return "user_request";
  }
  return "room_event";
}

export function resolveUnmentionedGroupInboundPolicy(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): InboundEventKind {
  const agentGroupChat = params.agentId
    ? resolveAgentConfig(params.cfg, params.agentId)?.groupChat
    : undefined;
  if (agentGroupChat && Object.hasOwn(agentGroupChat, "unmentionedInbound")) {
    return agentGroupChat.unmentionedInbound ?? "user_request";
  }
  return params.cfg.messages?.groupChat?.unmentionedInbound ?? "user_request";
}

// Session-envelope context resolver for inbound channel turns.

/** @deprecated Await resolveInboundSessionEnvelopeContextAsync. Retained during stable deprecation. */
export function resolveInboundSessionEnvelopeContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}) {
  warnPluginSdkDeprecation({
    family: "channel-inbound-envelope",
    method: "resolveInboundSessionEnvelopeContext",
    replacement: "await resolveInboundSessionEnvelopeContextAsync",
  });
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  return {
    storePath,
    envelopeOptions: resolveEnvelopeFormatOptions(params.cfg),
    previousTimestamp: readSessionUpdatedAtCore({
      storePath,
      sessionKey: params.sessionKey,
    }),
  };
}

/** Prepares descriptive session facts before building an inbound envelope. */
export async function resolveInboundSessionEnvelopeContextAsync(
  params: Parameters<typeof resolveInboundSessionEnvelopeContext>[0],
) {
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const envelopeOptions = resolveEnvelopeFormatOptions(params.cfg);
  const previousTimestamp = await readSessionUpdatedAtInWorker({
    storePath,
    sessionKey: params.sessionKey,
  });
  return { storePath, envelopeOptions, previousTimestamp };
}

export {
  hasFinalChannelTurnDispatch as hasFinalInboundReplyDispatch,
  hasVisibleChannelTurnDispatch as hasVisibleInboundReplyDispatch,
  resolveChannelTurnDispatchCounts as resolveInboundReplyDispatchCounts,
} from "../channels/turn/dispatch-result.js";

export { runGroupThread, type GroupThreadTurn } from "../auto-reply/group-thread.js";
export {
  resolveGroupThreadMentionFacts,
  isGroupThreadRouteExclusive,
  resolveGroupThreadConfig,
} from "../auto-reply/group-thread-config.js";
export type { GroupThreadMentionFacts } from "../auto-reply/group-thread.types.js";
export { getGroupThreadDeliverySession } from "../auto-reply/group-thread-context.js";
export {
  readAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../channels/turn/agent-run-terminal-outcome.js";

export {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../auto-reply/inbound-debounce.js";

export {
  formatAgentEnvelope,
  formatInboundEnvelope,
  formatInboundFromLabel,
  resolveEnvelopeFormatOptions,
} from "../auto-reply/envelope.js";
export type { EnvelopeFormatOptions } from "../auto-reply/envelope.js";
export type {
  PluginHookChannelChatContext,
  PluginHookChannelContext,
  PluginHookChannelSenderContext,
} from "../plugins/hook-types.js";
export {
  buildMentionRegexes,
  matchesMentionPatterns,
  matchesMentionWithExplicit,
  normalizeMentionText,
  type BuildMentionRegexesOptions,
} from "../auto-reply/reply/mentions.js";
export {
  resolveMentionPatternPolicy,
  type ResolveMentionPatternPolicyParams,
  type ResolvedMentionPatternPolicy,
} from "../channels/mention-pattern-policy.js";

export type {
  InboundMentionFacts,
  InboundMentionPolicy,
  InboundImplicitMentionKind,
  InboundMentionDecision,
  ResolveInboundMentionDecisionFlatParams,
  ResolveInboundMentionDecisionNestedParams,
  ResolveInboundMentionDecisionParams,
} from "../channels/mention-gating.js";
export {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "../channels/mention-gating.js";
export type { LocationSource, NormalizedLocation, OutboundLocation } from "../channels/location.js";
export {
  formatLocationText,
  normalizeOutboundLocation,
  toLocationContext,
} from "../channels/location.js";
export type { LogFn } from "../channels/logging.js";
export { logInboundDrop } from "../channels/logging.js";

export {
  createChannelInboundEnvelopeBuilder,
  createChannelInboundEnvelopeBuilderAsync,
  resolveChannelInboundRouteEnvelope,
  type ChannelInboundEnvelopeInput,
} from "../channels/inbound-event/envelope.js";
export {
  DEFAULT_CHANNEL_FEEDBACK_REFLECTION_COOLDOWN_MS,
  recordChannelFeedbackEvent,
  runChannelFeedbackReflection,
  type ChannelFeedbackReflectionResult,
} from "../channels/feedback-reflection.js";
export {
  buildChannelInboundEventContext,
  // @deprecated Prefer `buildChannelInboundEventContext`.
  finalizeChannelInboundContext,
  filterChannelInboundQuoteContext,
  filterChannelInboundSupplementalContext,
  resolveInboundSupplementalSenderAllowed,
};
export type {
  BuildChannelInboundEventContextAsyncParams,
  BuildChannelInboundEventContextParams,
  BuiltChannelInboundEventContext,
  ChannelInboundSupplementalResolutionOptions,
  FinalizeChannelInboundContextAsyncParams,
  FinalizeChannelInboundContextParams,
  FinalizeChannelInboundContextResult,
};
/**
 * Deprecated turn-context input alias that still accepts the old `inboundTurnKind` name.
 *
 * @deprecated Use `BuildChannelInboundEventContextParams`.
 */
export type BuildChannelTurnContextParams = Omit<
  BuildChannelInboundEventContextParams,
  "message"
> & {
  message: BuildChannelInboundEventContextParams["message"] & {
    inboundTurnKind?: InboundEventKind;
  };
};
/**
 * Deprecated turn-context result alias with the historical `InboundTurnKind` field.
 *
 * @deprecated Use `BuiltChannelInboundEventContext`.
 */
export type BuiltChannelTurnContext = BuiltChannelInboundEventContext & {
  InboundTurnKind: InboundEventKind;
};

/**
 * Builds inbound-event context for callers still passing `inboundTurnKind`.
 *
 * @deprecated Use `buildChannelInboundEventContext`.
 */
export function buildChannelTurnContext(
  params: BuildChannelTurnContextParams,
): BuiltChannelTurnContext {
  const inboundEventKind = params.message.inboundEventKind ?? params.message.inboundTurnKind;
  // Normalize the legacy turn-kind field before delegating so downstream context builders
  // only need to preserve the current inbound-event contract.
  const ctx = buildChannelInboundEventContext({
    ...params,
    message: {
      ...params.message,
      ...(inboundEventKind ? { inboundEventKind } : {}),
    },
  });
  return {
    ...ctx,
    InboundTurnKind: ctx.InboundEventKind,
  };
}

/**
 * Deprecated supplemental-context filter alias retained for channel SDK compatibility.
 *
 * @deprecated Use `filterChannelInboundSupplementalContext`.
 */
export const filterChannelTurnSupplementalContext = filterChannelInboundSupplementalContext;
// Public inbound vocabulary binds to internal channel-turn vocabulary here and only here.
// Keep internal defining modules free of SDK compatibility names.
export type ChannelInboundEventRunnerParams<
  TRaw,
  TDispatchResult = DispatchFromConfigResult,
> = PublicChannelTurnParams<TRaw, TDispatchResult, ChannelCoreManagedTurnDeliveryAdapter>;
export type PreparedInboundReply<TDispatchResult> = PreparedChannelTurn<TDispatchResult>;
export type AssembledInboundReply = PublicReplyParams<AssembledChannelTurn>;
export type ChannelInboundTurnPlan<
  TOwnership extends "core" | "provider_message_sending" = "core",
> = PublicReplyParams<
  ChannelTurnPlan<
    TOwnership extends "provider_message_sending"
      ? ChannelProviderOwnedMessageSendingDeliveryAdapter
      : ChannelCoreManagedTurnDeliveryAdapter
  >
>;
export type InboundReplyDispatchResult<TDispatchResult> = ChannelTurnResult<TDispatchResult>;
export type {
  ChannelTurnDroppedHistoryOptions,
  ChannelTurnDroppedHistoryOptions as ChannelInboundDroppedHistoryOptions,
  ChannelTurnRecordOptions,
  ChannelTurnRecordOptions as InboundReplyRecordOptions,
} from "../channels/turn/types.js";
export type { DurableInboundReplyDeliveryParams } from "../channels/turn/durable-delivery.js";
export type { ChannelBotLoopProtectionFacts } from "../channels/turn/bot-loop-protection.js";
export { recordChannelBotPairLoopAndCheckSuppression } from "../channels/turn/bot-loop-protection.js";

export async function runPreparedInboundReply<TDispatchResult>(
  params: PreparedChannelTurn<TDispatchResult>,
): Promise<ChannelTurnResult<TDispatchResult>> {
  return await runPreparedChannelTurn(params);
}

export function runChannelInboundEvent<TRaw, TDispatchResult = DispatchFromConfigResult>(
  params: PublicChannelTurnParams<
    TRaw,
    TDispatchResult,
    ChannelProviderOwnedMessageSendingDeliveryAdapter
  >,
): Promise<ChannelTurnResult<TDispatchResult>>;
export function runChannelInboundEvent<TRaw, TDispatchResult = DispatchFromConfigResult>(
  params: ChannelInboundEventRunnerParams<TRaw, TDispatchResult>,
): Promise<ChannelTurnResult<TDispatchResult>>;
export async function runChannelInboundEvent<TRaw, TDispatchResult = DispatchFromConfigResult>(
  params: PublicChannelTurnParams<TRaw, TDispatchResult, ChannelTurnDeliveryAdapter>,
) {
  const run = runChannelTurn as (
    value: RunChannelTurnParams<TRaw, TDispatchResult, ChannelTurnDeliveryAdapter>,
  ) => Promise<ChannelTurnResult<TDispatchResult>>;
  return await run(publicChannelTurnParams(params));
}

export async function dispatchChannelInboundReply(params: AssembledInboundReply) {
  return await dispatchAssembledChannelTurn(publicChannelTurn(params));
}

export function dispatchChannelInboundTurn(
  params: PublicReplyParams<ChannelTurnPlan<ChannelTurnDeliveryAdapter>>,
): Promise<ChannelTurnResult>;
export function dispatchChannelInboundTurn(
  params: ChannelInboundTurnPlan<"provider_message_sending">,
): Promise<ChannelTurnResult>;
export function dispatchChannelInboundTurn(
  params: ChannelInboundTurnPlan,
): Promise<ChannelTurnResult>;
export async function dispatchChannelInboundTurn(
  params: PublicReplyParams<ChannelTurnPlan<ChannelTurnDeliveryAdapter>>,
) {
  const dispatch = dispatchRoutedChannelTurn as (
    value: ChannelTurnPlan<ChannelTurnDeliveryAdapter>,
  ) => Promise<ChannelTurnResult>;
  return await dispatch(publicChannelTurn(params));
}

export {
  recordDroppedChannelTurnHistoryInternal as recordDroppedChannelInboundHistory,
  recordDroppedChannelTurnHistoryInternal as recordDroppedChannelTurnHistory,
};
export {
  createAcceptedChannelDeliveryResult,
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
  type ChannelPartialDeliveryError,
} from "../channels/turn/delivery-result.js";

export {
  toHistoryMediaEntries,
  toInboundMediaFacts,
  toInboundMediaFactsWithMetadata,
  /** @deprecated Pass ordered facts as the context's `media` field. */
  buildChannelInboundMediaPayload,
  formatMediaPlaceholderText,
  formatInboundMediaUnavailableText,
} from "../channels/inbound-event/media.js";
export type {
  ChannelInboundMediaInput,
  ChannelInboundMediaInput as ChannelTurnMediaInput,
  /** @deprecated Pass ordered `InboundMediaFacts[]` as the context's `media` field. */
  ChannelInboundMediaPayload,
  /** @deprecated Pass ordered `InboundMediaFacts[]` as the context's `media` field. */
  ChannelInboundMediaPayload as ChannelTurnMediaPayload,
  MediaPlaceholderTextFact,
} from "../channels/inbound-event/media.js";
export type {
  CommandFacts,
  InboundMediaFacts,
  SupplementalContextFacts,
} from "../channels/turn/types.js";
export type { InboundEventKind } from "../channels/inbound-event/kind.js";
export type { InboundEventKind as InboundTurnKind } from "../channels/inbound-event/kind.js";
export {
  createCommandTurnContext,
  isAuthorizedTextSlashCommandTurn,
  isExplicitCommandTurn,
  isNativeCommandTurn,
  isTextSlashCommandTurn,
} from "../auto-reply/command-turn-context.js";
export type { CommandTurnContext } from "../auto-reply/command-turn-context.js";
export { mergeInboundPathRoots } from "@openclaw/media-core/inbound-path-policy";
