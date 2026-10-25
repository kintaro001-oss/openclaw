import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/**
 * Shared messaging-target parsing primitives for channel plugins and SDK consumers.
 * Channel-specific grammars stay in plugins; this file owns common target shapes and parse order.
 */

export type MessagingTargetKind = "user" | "channel";

export type MessagingTarget = {
  kind: MessagingTargetKind;
  id: string;
  raw: string;
  normalized: string;
};

export type MessagingTargetParseOptions = {
  defaultKind?: MessagingTargetKind;
  ambiguousMessage?: string;
};

export function buildMessagingTarget(
  kind: MessagingTargetKind,
  id: string,
  raw: string,
): MessagingTarget {
  return {
    kind,
    id,
    raw,
    normalized: normalizeLowercaseStringOrEmpty(`${kind}:${id}`),
  };
}

export function ensureTargetId(params: {
  candidate: string;
  pattern: RegExp;
  errorMessage: string;
}): string {
  if (!params.pattern.test(params.candidate)) {
    throw new Error(params.errorMessage);
  }
  return params.candidate;
}

/** Tries mention, explicit prefixes, then @user shorthand in deterministic order. */
export function parseMentionPrefixOrAtUserTarget(params: {
  raw: string;
  mentionPattern: RegExp;
  prefixes: Array<{ prefix: string; kind: MessagingTargetKind }>;
  atUserPattern: RegExp;
  atUserErrorMessage: string;
}): MessagingTarget | undefined {
  const match = params.raw.match(params.mentionPattern);
  if (match?.[1]) {
    return buildMessagingTarget("user", match[1], params.raw);
  }
  for (const { prefix, kind } of params.prefixes) {
    if (params.raw.startsWith(prefix)) {
      const id = params.raw.slice(prefix.length).trim();
      if (id) {
        return buildMessagingTarget(kind, id, params.raw);
      }
    }
  }
  if (!params.raw.startsWith("@")) {
    return undefined;
  }
  const id = ensureTargetId({
    candidate: params.raw.slice(1).trim(),
    pattern: params.atUserPattern,
    errorMessage: params.atUserErrorMessage,
  });
  return buildMessagingTarget("user", id, params.raw);
}

export function requireTargetKind(params: {
  platform: string;
  target: MessagingTarget | undefined;
  kind: MessagingTargetKind;
}): string {
  const kindLabel = params.kind;
  if (!params.target) {
    throw new Error(`${params.platform} ${kindLabel} id is required.`);
  }
  if (params.target.kind !== params.kind) {
    throw new Error(`${params.platform} ${kindLabel} id is required (use ${kindLabel}:<id>).`);
  }
  return params.target.id;
}

export {
  applyChannelMatchMeta,
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveChannelEntryMatch,
  resolveChannelEntryMatchWithFallback,
  resolveChannelMatchConfig,
  resolveNestedAllowlistDecision,
  type ChannelEntryMatch,
  type ChannelMatchSource,
} from "../channels/channel-config.js";
export {
  createAllowedChatSenderMatcher,
  parseChatAllowTargetPrefixes,
  parseChatTargetPrefixesOrThrow,
  resolveServicePrefixedAllowTarget,
  resolveServicePrefixedChatTarget,
  resolveServicePrefixedOrChatAllowTarget,
  resolveServicePrefixedTarget,
  type ChatSenderAllowParams,
  type ChatTargetPrefixesParams,
  type ParsedChatAllowTarget,
  type ParsedChatTarget,
  type ServicePrefix,
} from "../channels/plugins/chat-target-prefixes.js";
export type { ChannelId } from "../channels/plugins/types.public.js";
export { normalizeAnyChannelId as normalizeChannelId } from "../channels/registry-normalize.js";
export {
  buildUnresolvedTargetResults,
  resolveTargetsWithOptionalToken,
} from "../channels/plugins/target-resolvers.js";
