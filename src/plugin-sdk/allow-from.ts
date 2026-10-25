import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalLowercaseString } from "../../packages/normalization-core/src/string-coerce.js";
import {
  normalizeStringEntries,
  uniqueStrings,
} from "../../packages/normalization-core/src/string-normalization.js";
import type { ChannelResolveResult } from "../channels/plugins/types.adapters.js";
import type { RuntimeEnv } from "../runtime.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import { summarizeStringEntries } from "../shared/string-sample.js";

export type AllowlistUserResolutionLike = {
  input: string;
  resolved: boolean;
  id?: string;
};

function dedupeAllowlistEntries(
  entries: string[],
  entryKey: (entry: string) => string = normalizeLowercaseStringOrEmpty,
): string[] {
  return dedupeByKey(entries.map((entry) => entry.trim()).filter(Boolean), entryKey);
}

export function mergeAllowlist(params: {
  existing?: Array<string | number>;
  additions: string[];
}): string[] {
  return dedupeAllowlistEntries([...(params.existing ?? []).map(String), ...params.additions]);
}

export function buildAllowlistResolutionSummary<T extends AllowlistUserResolutionLike>(
  resolvedUsers: T[],
  opts?: {
    /** Return null to omit an entry from the logged mapping (e.g. identity lookups). */
    formatResolved?: (entry: T) => string | null;
    formatUnresolved?: (entry: T) => string;
  },
): {
  resolvedMap: Map<string, T>;
  mapping: string[];
  unresolved: string[];
  additions: string[];
} {
  const resolvedMap = new Map(resolvedUsers.map((entry) => [entry.input, entry]));
  const resolvedOk = (entry: T) => Boolean(entry.resolved && entry.id);
  // An id that "resolves" to itself carries no information; skip it so startup
  // summaries only mention lookups that actually translated something.
  const formatResolved =
    opts?.formatResolved ??
    ((entry: T) => (entry.id === entry.input ? null : `${entry.input}→${entry.id}`));
  const formatUnresolved = opts?.formatUnresolved ?? ((entry: T) => entry.input);
  const mapping = resolvedUsers
    .filter(resolvedOk)
    .map(formatResolved)
    .filter((label): label is string => label !== null);
  const additions = resolvedUsers
    .filter(resolvedOk)
    .map((entry) => entry.id)
    .filter((entry): entry is string => Boolean(entry));
  const unresolved = resolvedUsers.filter((entry) => !resolvedOk(entry)).map(formatUnresolved);
  return { resolvedMap, mapping, unresolved, additions };
}

/** Replaces resolvable user entries with canonical ids while preserving unresolved entries and `*`. */
export function canonicalizeAllowlistWithResolvedIds<
  T extends AllowlistUserResolutionLike,
>(params: {
  existing?: Array<string | number>;
  resolvedMap: Map<string, T>;
  entryKey?: (entry: string) => string;
}): string[] {
  const canonicalized: string[] = [];
  for (const entry of params.existing ?? []) {
    const trimmed = normalizeOptionalString(entry) ?? "";
    if (!trimmed) {
      continue;
    }
    if (trimmed === "*") {
      // Wildcard allowlists are a policy value, not a lookup target.
      canonicalized.push(trimmed);
      continue;
    }
    const resolved = params.resolvedMap.get(trimmed);
    canonicalized.push(resolved?.resolved && resolved.id ? resolved.id : trimmed);
  }
  return dedupeAllowlistEntries(canonicalized, params.entryKey);
}

export function patchAllowlistUsersInConfigEntries<
  T extends AllowlistUserResolutionLike,
  TEntries extends Record<string, unknown>,
>(params: {
  entries: TEntries;
  resolvedMap: Map<string, T>;
  strategy?: "merge" | "canonicalize";
  entryKey?: (entry: string) => string;
}): TEntries {
  const nextEntries: Record<string, unknown> = { ...params.entries };
  for (const [entryKey, entryConfig] of Object.entries(params.entries)) {
    if (!entryConfig || typeof entryConfig !== "object") {
      continue;
    }
    const users = (entryConfig as { users?: Array<string | number> }).users;
    if (!Array.isArray(users) || users.length === 0) {
      continue;
    }
    // `merge` keeps original user text and appends resolved ids; `canonicalize` replaces it.
    let resolvedUsers: string[];
    if (params.strategy === "canonicalize") {
      resolvedUsers = canonicalizeAllowlistWithResolvedIds({
        existing: users,
        resolvedMap: params.resolvedMap,
        entryKey: params.entryKey,
      });
    } else {
      const resolvedMap = params.resolvedMap;
      const additions: string[] = [];
      for (const entry of users) {
        const trimmed = normalizeOptionalString(entry) ?? "";
        const resolved = resolvedMap.get(trimmed);
        if (resolved?.resolved && resolved.id) {
          additions.push(resolved.id);
        }
      }
      resolvedUsers = mergeAllowlist({ existing: users, additions });
    }
    nextEntries[entryKey] = {
      ...entryConfig,
      users: resolvedUsers,
    };
  }
  return nextEntries as TEntries;
}

/** Collects concrete user lookup targets from one config entry, excluding wildcard policy entries. */
export function addAllowlistUserEntriesFromConfigEntry(target: Set<string>, entry: unknown): void {
  if (!entry || typeof entry !== "object") {
    return;
  }
  const users = (entry as { users?: Array<string | number> }).users;
  if (!Array.isArray(users)) {
    return;
  }
  for (const value of users) {
    const trimmed = normalizeOptionalString(value) ?? "";
    if (trimmed && trimmed !== "*") {
      target.add(trimmed);
    }
  }
}

export function summarizeMapping(
  label: string,
  mapping: string[],
  unresolved: string[],
  runtime: RuntimeEnv,
): void {
  // One log call per line: the console logger only prefixes the first line of
  // a message with timestamp/subsystem, so a joined multi-line summary leaves
  // bare continuation lines in operator output.
  if (mapping.length > 0) {
    runtime.log?.(`${label} resolved: ${summarizeStringEntries({ entries: mapping, limit: 6 })}`);
  }
  if (unresolved.length > 0) {
    runtime.log?.(
      `${label} unresolved: ${summarizeStringEntries({ entries: unresolved, limit: 6 })}`,
    );
  }
}

export { isAllowedParsedChatSender } from "../channels/plugins/chat-target-prefixes.js";

export type {
  AllowlistMatch,
  AllowlistMatchSource,
  CompiledAllowlist,
} from "../channels/allowlist-match.js";

export {
  compileAllowlist,
  formatAllowlistMatchMeta,
  resolveAllowlistCandidates,
  resolveAllowlistMatchByCandidates,
  resolveAllowlistMatchSimple,
  resolveCompiledAllowlistMatch,
} from "../channels/allowlist-match.js";
export {
  firstDefined,
  isSenderIdAllowed,
  mergeDmAllowFromSources,
  resolveGroupAllowFromSources,
} from "../channels/allow-from.js";

/** Lowercase and optionally strip prefixes from allowlist entries before sender comparisons. */
export function formatAllowFromLowercase(params: {
  /** Raw allowlist entries from config or channel-specific overrides. */
  allowFrom: Array<string | number>;
  /** Optional prefix remover for channel aliases such as `tg:` or `zalo:`. */
  stripPrefixRe?: RegExp;
}): string[] {
  return normalizeStringEntries(params.allowFrom)
    .map((entry) => (params.stripPrefixRe ? entry.replace(params.stripPrefixRe, "") : entry))
    .map((entry) => normalizeOptionalLowercaseString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

/** Normalize allowlist entries through a channel-provided parser or canonicalizer. */
export function formatNormalizedAllowFromEntries(params: {
  /** Raw allowlist entries from config or channel-specific overrides. */
  allowFrom: Array<string | number>;
  /** Channel-specific canonicalizer; empty results are omitted. */
  normalizeEntry: (entry: string) => string | undefined | null;
}): string[] {
  return normalizeStringEntries(params.allowFrom)
    .map((entry) => params.normalizeEntry(entry))
    .filter((entry): entry is string => Boolean(entry));
}

type ParsedAllowFromEntry = { value: string } | { error: string };

/** Parse, validate, and deduplicate setup allow-from entries with wildcard support. */
export function parseAllowFromEntries(
  raw: string,
  parseEntry: (entry: string) => ParsedAllowFromEntry,
): { entries: string[]; error?: string } {
  const entries: string[] = [];
  for (const entry of normalizeStringEntries(raw.split(/[\n,;]+/g))) {
    if (entry === "*") {
      entries.push(entry);
      continue;
    }
    const parsed = parseEntry(entry);
    if ("error" in parsed) {
      return { entries: [], error: parsed.error };
    }
    entries.push(parsed.value);
  }
  return { entries: uniqueStrings(normalizeStringEntries(entries)) };
}

/** Resolve basic setup allow-from entries when a channel token is available. */
export async function resolveBasicAllowFromEntries(params: {
  token?: string | null;
  entries: string[];
  resolveEntries: (params: {
    token: string;
    entries: string[];
  }) => Promise<Array<{ input: string; resolved: boolean; id?: string | null }>>;
}): Promise<Array<{ input: string; resolved: boolean; id: string | null }>> {
  const token = params.token?.trim();
  if (!token) {
    return params.entries.map((input) => ({ input, resolved: false, id: null }));
  }
  return (await params.resolveEntries({ token, entries: params.entries })).map((entry) => ({
    input: entry.input,
    resolved: entry.resolved,
    id: entry.id ?? null,
  }));
}

/** Check whether a sender id matches a simple normalized allowlist with wildcard support. */
export function isNormalizedSenderAllowed(params: {
  /** Sender id or handle to compare after string coercion and lowercase normalization. */
  senderId: string | number;
  /** Raw allowlist entries; `*` allows every sender. */
  allowFrom: Array<string | number>;
  /** Optional prefix remover applied to allowlist entries before comparison. */
  stripPrefixRe?: RegExp;
}): boolean {
  const normalizedAllow = formatAllowFromLowercase({
    allowFrom: params.allowFrom,
    stripPrefixRe: params.stripPrefixRe,
  });
  if (normalizedAllow.length === 0) {
    // Empty allowlists deny by default; callers must opt into wildcard access explicitly.
    return false;
  }
  if (normalizedAllow.includes("*")) {
    return true;
  }
  const sender = normalizeOptionalLowercaseString(String(params.senderId));
  return sender ? normalizedAllow.includes(sender) : false;
}

/** Serializable allowlist resolution record used by setup/status UI surfaces. */
export type BasicAllowlistResolutionEntry = ChannelResolveResult;

/** Map allowlist inputs sequentially so resolver side effects stay ordered and predictable. */
export async function mapAllowlistResolutionInputs<T>(params: {
  /** Ordered allowlist inputs to resolve. */
  inputs: string[];
  /** Resolver callback invoked once per input in order. */
  mapInput: (input: string) => Promise<T> | T;
}): Promise<T[]> {
  const results: T[] = [];
  for (const input of params.inputs) {
    results.push(await params.mapInput(input));
  }
  return results;
}
