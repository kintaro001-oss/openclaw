import { asNullableRecord as asObjectRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeStringEntries,
  uniqueStrings,
} from "../../packages/normalization-core/src/string-normalization.js";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { parseAccessGroupAllowFromEntry } from "../channels/allow-from.js";
import type { ChannelSecurityAdapter } from "../channels/plugins/types.adapters.js";
import type { ChannelSecurityDmPolicy } from "../channels/plugins/types.core.js";
import { collectProviderDangerousNameMatchingScopes } from "../config/dangerous-name-matching.js";
import {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
} from "../config/runtime-group-policy.js";
import type { GroupPolicy } from "../config/types.base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecurityAuditFinding } from "../security/audit.types.js";
import { createScopedDmSecurityResolver } from "./channel-config-helpers.js";

type GroupPolicyWarningCollector = (groupPolicy: GroupPolicy) => string[];
type AccountGroupPolicyWarningCollector<ResolvedAccount> = (params: {
  account: ResolvedAccount;
  cfg: OpenClawConfig;
}) => string[];
type ConfigGroupPolicyWarningCollector<Params extends { cfg: OpenClawConfig }> = (
  params: Params,
) => string[];
type WarningCollector<Params> = (params: Params) => string[];

export function composeWarningCollectors<Params>(
  ...collectors: Array<WarningCollector<Params> | null | undefined>
): WarningCollector<Params> {
  return (params) => collectors.flatMap((collector) => collector?.(params) ?? []);
}

export function projectWarningCollector<Params, Projected>(
  project: (params: Params) => Projected,
  collector: WarningCollector<Projected>,
): WarningCollector<Params> {
  return (params) => collector(project(params));
}

export function projectConfigWarningCollector<Params extends { cfg: OpenClawConfig }>(
  collector: WarningCollector<{ cfg: OpenClawConfig }>,
): WarningCollector<Params> {
  return projectWarningCollector((params) => ({ cfg: params.cfg }), collector);
}

export function projectConfigAccountIdWarningCollector<
  Params extends { cfg: OpenClawConfig; accountId?: string | null },
>(
  collector: WarningCollector<{ cfg: OpenClawConfig; accountId?: string | null }>,
): WarningCollector<Params> {
  return projectWarningCollector(
    (params) => ({ cfg: params.cfg, accountId: params.accountId }),
    collector,
  );
}

export function projectAccountWarningCollector<
  ResolvedAccount,
  Params extends { account: ResolvedAccount },
>(collector: WarningCollector<ResolvedAccount>): WarningCollector<Params> {
  return projectWarningCollector((params) => params.account, collector);
}

export function projectAccountConfigWarningCollector<
  ResolvedAccount,
  ProjectedCfg,
  Params extends { account: ResolvedAccount; cfg: OpenClawConfig },
>(
  projectCfg: (cfg: OpenClawConfig) => ProjectedCfg,
  collector: WarningCollector<{ account: ResolvedAccount; cfg: ProjectedCfg }>,
): WarningCollector<Params> {
  return projectWarningCollector(
    (params) => ({ account: params.account, cfg: projectCfg(params.cfg) }),
    collector,
  );
}

function createSecurityAuditFindingCollector<Params>(options: {
  collectWarnings: (params: Params) => string[];
  checkId: string;
  severity: SecurityAuditFinding["severity"];
  title: string;
}): (params: Params) => SecurityAuditFinding[] {
  return (params) =>
    options
      .collectWarnings(params)
      .map((message) => message.trim())
      .filter(Boolean)
      .map((message) => ({
        checkId: options.checkId,
        severity: options.severity,
        title: options.title,
        detail: message.replace(/^-\s*/, ""),
      }));
}

export const createConditionalWarningCollector = Object.assign(
  <Params>(
    ...collectors: Array<(params: Params) => string | string[] | null | undefined | false>
  ): WarningCollector<Params> =>
    (params) =>
      collectors.flatMap((collector) => {
        const next = collector(params);
        if (!next) {
          return [];
        }
        return Array.isArray(next) ? next : [next];
      }),
  { findings: createSecurityAuditFindingCollector },
);

export function composeAccountWarningCollectors<
  ResolvedAccount,
  Params extends { account: ResolvedAccount },
>(
  baseCollector: WarningCollector<Params>,
  ...collectors: Array<(account: ResolvedAccount) => string | string[] | null | undefined | false>
): WarningCollector<Params> {
  return composeWarningCollectors(
    baseCollector,
    createConditionalWarningCollector<Params>(
      ...collectors.map(
        (collector) =>
          ({ account }: Params) =>
            collector(account),
      ),
    ),
  );
}

export function buildOpenGroupPolicyWarning(params: {
  surface: string;
  openBehavior: string;
  remediation: string;
}): string {
  return `- ${params.surface}: groupPolicy="open" ${params.openBehavior}. ${params.remediation}.`;
}

export function buildOpenGroupPolicyRestrictSendersWarning(params: {
  surface: string;
  openScope: string;
  groupPolicyPath: string;
  groupAllowFromPath: string;
  mentionGated?: boolean;
}): string {
  const mentionSuffix = params.mentionGated === false ? "" : " (mention-gated)";
  return buildOpenGroupPolicyWarning({
    surface: params.surface,
    openBehavior: `allows ${params.openScope} to trigger${mentionSuffix}`,
    remediation: `Set ${params.groupPolicyPath}="allowlist" + ${params.groupAllowFromPath} to restrict senders`,
  });
}

function buildOpenGroupPolicyNoRouteAllowlistWarning(params: {
  surface: string;
  routeAllowlistPath: string;
  routeScope: string;
  groupPolicyPath: string;
  groupAllowFromPath: string;
  mentionGated?: boolean;
}): string {
  const mentionSuffix = params.mentionGated === false ? "" : " (mention-gated)";
  return buildOpenGroupPolicyWarning({
    surface: params.surface,
    openBehavior: `with no ${params.routeAllowlistPath} allowlist; any ${params.routeScope} can add + ping${mentionSuffix}`,
    remediation: `Set ${params.groupPolicyPath}="allowlist" + ${params.groupAllowFromPath} or configure ${params.routeAllowlistPath}`,
  });
}

export function buildOpenGroupPolicyConfigureRouteAllowlistWarning(params: {
  surface: string;
  openScope: string;
  groupPolicyPath: string;
  routeAllowlistPath: string;
  mentionGated?: boolean;
}): string {
  const mentionSuffix = params.mentionGated === false ? "" : " (mention-gated)";
  return buildOpenGroupPolicyWarning({
    surface: params.surface,
    openBehavior: `allows ${params.openScope} to trigger${mentionSuffix}`,
    remediation: `Set ${params.groupPolicyPath}="allowlist" and configure ${params.routeAllowlistPath}`,
  });
}

export function collectOpenGroupPolicyRestrictSendersWarnings(
  params: Parameters<typeof buildOpenGroupPolicyRestrictSendersWarning>[0] & {
    groupPolicy: "open" | "allowlist" | "disabled";
  },
): string[] {
  if (params.groupPolicy !== "open") {
    return [];
  }
  return [buildOpenGroupPolicyRestrictSendersWarning(params)];
}

export function collectAllowlistProviderRestrictSendersWarnings(
  params: {
    cfg: OpenClawConfig;
    providerConfigPresent: boolean;
    configuredGroupPolicy?: GroupPolicy | null;
  } & Omit<Parameters<typeof collectOpenGroupPolicyRestrictSendersWarnings>[0], "groupPolicy">,
): string[] {
  return collectAllowlistProviderGroupPolicyWarnings({
    ...params,
    collect: (groupPolicy) =>
      collectOpenGroupPolicyRestrictSendersWarnings({
        ...params,
        groupPolicy,
      }),
  });
}

/** Build an account-aware allowlist-provider warning collector for sender-restricted groups. */
export function createAllowlistProviderRestrictSendersWarningCollector<ResolvedAccount>(
  params: {
    providerConfigPresent: (cfg: OpenClawConfig) => boolean;
    resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
  } & Omit<
    Parameters<typeof collectAllowlistProviderRestrictSendersWarnings>[0],
    "cfg" | "providerConfigPresent" | "configuredGroupPolicy"
  >,
): AccountGroupPolicyWarningCollector<ResolvedAccount> {
  return createAllowlistProviderGroupPolicyWarningCollector({
    providerConfigPresent: params.providerConfigPresent,
    resolveGroupPolicy: ({ account }: { account: ResolvedAccount; cfg: OpenClawConfig }) =>
      params.resolveGroupPolicy(account),
    collect: ({ groupPolicy }) =>
      collectOpenGroupPolicyRestrictSendersWarnings({
        ...params,
        groupPolicy,
      }),
  });
}

/** Build a direct account-aware warning collector when the policy already lives on the account. */
export function createOpenGroupPolicyRestrictSendersWarningCollector<ResolvedAccount>(
  params: {
    resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
    defaultGroupPolicy?: GroupPolicy;
  } & Omit<Parameters<typeof collectOpenGroupPolicyRestrictSendersWarnings>[0], "groupPolicy">,
): (account: ResolvedAccount) => string[] {
  return (account) =>
    collectOpenGroupPolicyRestrictSendersWarnings({
      ...params,
      groupPolicy: params.resolveGroupPolicy(account) ?? params.defaultGroupPolicy ?? "allowlist",
    });
}

function createProviderGroupPolicyWarningCollectors(
  resolvePolicy: typeof resolveOpenProviderRuntimeGroupPolicy,
) {
  const collectWarnings = (params: {
    cfg: OpenClawConfig;
    providerConfigPresent: boolean;
    configuredGroupPolicy?: GroupPolicy | null;
    collect: GroupPolicyWarningCollector;
  }): string[] =>
    params.collect(
      resolvePolicy({
        providerConfigPresent: params.providerConfigPresent,
        groupPolicy: params.configuredGroupPolicy ?? undefined,
        defaultGroupPolicy: resolveDefaultGroupPolicy(params.cfg),
      }).groupPolicy,
    );

  const createCollector =
    <Params extends { cfg: OpenClawConfig }>(params: {
      providerConfigPresent: (cfg: OpenClawConfig) => boolean;
      resolveGroupPolicy: (params: Params) => GroupPolicy | null | undefined;
      collect: (params: Params & { groupPolicy: GroupPolicy }) => string[];
    }): ConfigGroupPolicyWarningCollector<Params> =>
    (runtime) =>
      collectWarnings({
        cfg: runtime.cfg,
        providerConfigPresent: params.providerConfigPresent(runtime.cfg),
        configuredGroupPolicy: params.resolveGroupPolicy(runtime),
        collect: (groupPolicy) => params.collect({ ...runtime, groupPolicy }),
      });

  return { collectWarnings, createCollector };
}

export const {
  collectWarnings: collectAllowlistProviderGroupPolicyWarnings,
  createCollector: createAllowlistProviderGroupPolicyWarningCollector,
} = createProviderGroupPolicyWarningCollectors(resolveAllowlistProviderRuntimeGroupPolicy);

export const {
  collectWarnings: collectOpenProviderGroupPolicyWarnings,
  createCollector: createOpenProviderGroupPolicyWarningCollector,
} = createProviderGroupPolicyWarningCollectors(resolveOpenProviderRuntimeGroupPolicy);

/** Build an account-aware allowlist-provider warning collector for simple open-policy warnings. */
export function createAllowlistProviderOpenWarningCollector<ResolvedAccount>(params: {
  providerConfigPresent: (cfg: OpenClawConfig) => boolean;
  resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
  buildOpenWarning: Parameters<typeof buildOpenGroupPolicyWarning>[0];
}): AccountGroupPolicyWarningCollector<ResolvedAccount> {
  return createAllowlistProviderGroupPolicyWarningCollector({
    providerConfigPresent: params.providerConfigPresent,
    resolveGroupPolicy: ({ account }: { account: ResolvedAccount; cfg: OpenClawConfig }) =>
      params.resolveGroupPolicy(account),
    collect: ({ groupPolicy }) =>
      groupPolicy === "open" ? [buildOpenGroupPolicyWarning(params.buildOpenWarning)] : [],
  });
}

export function collectOpenGroupPolicyRouteAllowlistWarnings(params: {
  groupPolicy: "open" | "allowlist" | "disabled";
  routeAllowlistConfigured: boolean;
  restrictSenders: Parameters<typeof buildOpenGroupPolicyRestrictSendersWarning>[0];
  noRouteAllowlist: Parameters<typeof buildOpenGroupPolicyNoRouteAllowlistWarning>[0];
}): string[] {
  if (params.groupPolicy !== "open") {
    return [];
  }
  if (params.routeAllowlistConfigured) {
    return [buildOpenGroupPolicyRestrictSendersWarning(params.restrictSenders)];
  }
  return [buildOpenGroupPolicyNoRouteAllowlistWarning(params.noRouteAllowlist)];
}

/** Build an account-aware allowlist-provider warning collector for route-allowlisted groups. */
export function createAllowlistProviderRouteAllowlistWarningCollector<ResolvedAccount>(params: {
  providerConfigPresent: (cfg: OpenClawConfig) => boolean;
  resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
  resolveRouteAllowlistConfigured: (account: ResolvedAccount) => boolean;
  restrictSenders: Parameters<typeof buildOpenGroupPolicyRestrictSendersWarning>[0];
  noRouteAllowlist: Parameters<typeof buildOpenGroupPolicyNoRouteAllowlistWarning>[0];
}): AccountGroupPolicyWarningCollector<ResolvedAccount> {
  return createAllowlistProviderGroupPolicyWarningCollector({
    providerConfigPresent: params.providerConfigPresent,
    resolveGroupPolicy: ({ account }: { account: ResolvedAccount; cfg: OpenClawConfig }) =>
      params.resolveGroupPolicy(account),
    collect: ({ account, groupPolicy }) =>
      collectOpenGroupPolicyRouteAllowlistWarnings({
        groupPolicy,
        routeAllowlistConfigured: params.resolveRouteAllowlistConfigured(account),
        restrictSenders: params.restrictSenders,
        noRouteAllowlist: params.noRouteAllowlist,
      }),
  });
}

export function collectOpenGroupPolicyConfiguredRouteWarnings(params: {
  groupPolicy: "open" | "allowlist" | "disabled";
  routeAllowlistConfigured: boolean;
  configureRouteAllowlist: Parameters<typeof buildOpenGroupPolicyConfigureRouteAllowlistWarning>[0];
  missingRouteAllowlist: Parameters<typeof buildOpenGroupPolicyWarning>[0];
}): string[] {
  if (params.groupPolicy !== "open") {
    return [];
  }
  if (params.routeAllowlistConfigured) {
    return [buildOpenGroupPolicyConfigureRouteAllowlistWarning(params.configureRouteAllowlist)];
  }
  return [buildOpenGroupPolicyWarning(params.missingRouteAllowlist)];
}

/** Build an account-aware open-provider warning collector for configured-route channels. */
export function createOpenProviderConfiguredRouteWarningCollector<ResolvedAccount>(params: {
  providerConfigPresent: (cfg: OpenClawConfig) => boolean;
  resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
  resolveRouteAllowlistConfigured: (account: ResolvedAccount) => boolean;
  configureRouteAllowlist: Parameters<typeof buildOpenGroupPolicyConfigureRouteAllowlistWarning>[0];
  missingRouteAllowlist: Parameters<typeof buildOpenGroupPolicyWarning>[0];
}): AccountGroupPolicyWarningCollector<ResolvedAccount> {
  return createOpenProviderGroupPolicyWarningCollector({
    providerConfigPresent: params.providerConfigPresent,
    resolveGroupPolicy: ({ account }: { account: ResolvedAccount; cfg: OpenClawConfig }) =>
      params.resolveGroupPolicy(account),
    collect: ({ account, groupPolicy }) =>
      collectOpenGroupPolicyConfiguredRouteWarnings({
        groupPolicy,
        routeAllowlistConfigured: params.resolveRouteAllowlistConfigured(account),
        configureRouteAllowlist: params.configureRouteAllowlist,
        missingRouteAllowlist: params.missingRouteAllowlist,
      }),
  });
}

/** Shared policy warnings and DM/group policy helpers for channel plugins. */
export type {
  GroupToolPolicyBySenderConfig,
  GroupToolPolicyConfig,
} from "../config/types.tools.js";
export { buildAccountScopedDmSecurityPolicy } from "../channels/plugins/helpers.js";
export {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
  resolveChannelGroupToolsPolicy,
  resolveChannelGroups,
  resolveChannelGroupsConfigPath,
  resolveToolsBySender,
  type ChannelGroupPolicy,
} from "../config/group-policy.js";
export {
  buildChannelGroupsScopeTree,
  encodeScopeSegment,
  resolveScopeIntroHint,
  resolveScopeKeyCaseInsensitive,
  resolveScopeRequireMention,
  resolveScopeToolsPolicy,
  scopeKey,
  type ScopeNode,
  type ScopePath,
  type ScopeTree,
} from "../config/group-scope-tree.js";
export {
  DM_GROUP_ACCESS_REASON,
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
  resolveEffectiveAllowFromLists,
  resolveOpenDmAllowlistAccess,
} from "./channel-access-compat.js";

type GroupRouteAccessDecision = {
  allowed: boolean;
  groupPolicy: GroupPolicy;
  reason: "allowed" | "disabled" | "empty_allowlist" | "route_not_allowlisted" | "route_disabled";
};

type SenderGroupAccessDecision = {
  allowed: boolean;
  groupPolicy: GroupPolicy;
  providerMissingFallbackApplied: boolean;
  reason: "allowed" | "disabled" | "empty_allowlist" | "sender_not_allowlisted";
};

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export function resolveSenderScopedGroupPolicy(params: {
  groupPolicy: GroupPolicy;
  groupAllowFrom: string[];
}): GroupPolicy {
  if (params.groupPolicy === "disabled") {
    return "disabled";
  }
  return params.groupAllowFrom.length > 0 ? "allowlist" : "open";
}

/** @deprecated Use route descriptors with `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export function evaluateGroupRouteAccessForPolicy(params: {
  groupPolicy: GroupPolicy;
  routeAllowlistConfigured: boolean;
  routeMatched: boolean;
  routeEnabled?: boolean;
}): GroupRouteAccessDecision {
  if (params.groupPolicy === "disabled") {
    return { allowed: false, groupPolicy: params.groupPolicy, reason: "disabled" };
  }
  if (params.routeMatched && params.routeEnabled === false) {
    return { allowed: false, groupPolicy: params.groupPolicy, reason: "route_disabled" };
  }
  if (params.groupPolicy === "allowlist") {
    if (!params.routeAllowlistConfigured) {
      return { allowed: false, groupPolicy: params.groupPolicy, reason: "empty_allowlist" };
    }
    if (!params.routeMatched) {
      return { allowed: false, groupPolicy: params.groupPolicy, reason: "route_not_allowlisted" };
    }
  }
  return { allowed: true, groupPolicy: params.groupPolicy, reason: "allowed" };
}

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export function evaluateSenderGroupAccessForPolicy(params: {
  groupPolicy: GroupPolicy;
  providerMissingFallbackApplied?: boolean;
  groupAllowFrom: string[];
  senderId: string;
  isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
}): SenderGroupAccessDecision {
  const providerMissingFallbackApplied = Boolean(params.providerMissingFallbackApplied);
  let reason: SenderGroupAccessDecision["reason"] = "allowed";
  if (params.groupPolicy === "disabled") {
    reason = "disabled";
  } else if (params.groupPolicy === "allowlist") {
    if (params.groupAllowFrom.length === 0) {
      reason = "empty_allowlist";
    } else if (!params.isSenderAllowed(params.senderId, params.groupAllowFrom)) {
      reason = "sender_not_allowlisted";
    }
  }
  return {
    allowed: reason === "allowed",
    groupPolicy: params.groupPolicy,
    providerMissingFallbackApplied,
    reason,
  };
}

/** Normalizes allowFrom entries into trimmed unique string identifiers. */
export function normalizeAllowFromList(list: Array<string | number> | undefined | null): string[] {
  if (!Array.isArray(list)) {
    return [];
  }
  return normalizeStringEntries(list);
}

/** Coerces native feature settings to the supported boolean/auto shape. */
export function coerceNativeSetting(value: unknown): boolean | "auto" | undefined {
  if (value === true || value === false || value === "auto") {
    return value;
  }
  return undefined;
}

/**
 * Candidate allowlist inspected for dangerous name/email/nick matching warnings.
 * `pathLabel` is emitted in doctor output, so callers should pass the exact config path.
 */
export type ChannelMutableAllowlistCandidate = {
  pathLabel: string;
  list: unknown;
};

type StandardAllowlistScope = {
  prefix: string;
  account: Record<string, unknown>;
};

/** Collect the common account, nested-DM, and group/room allowlist paths for doctor warnings. */
export function collectStandardAllowlistLists(
  scope: StandardAllowlistScope,
  options: {
    includeAllowFrom?: boolean;
    includeGroupAllowFrom?: boolean;
    includeDm?: boolean;
    includeGroups?: boolean;
    groupsKey?: string;
    groupField?: string;
  } = {},
): ChannelMutableAllowlistCandidate[] {
  const lists: ChannelMutableAllowlistCandidate[] = [];
  if (options.includeAllowFrom !== false) {
    lists.push({ pathLabel: `${scope.prefix}.allowFrom`, list: scope.account.allowFrom });
  }
  if (options.includeGroupAllowFrom !== false) {
    lists.push({
      pathLabel: `${scope.prefix}.groupAllowFrom`,
      list: scope.account.groupAllowFrom,
    });
  }
  if (options.includeDm) {
    const dm = asObjectRecord(scope.account.dm);
    if (dm) {
      lists.push({ pathLabel: `${scope.prefix}.dm.allowFrom`, list: dm.allowFrom });
    }
  }
  if (options.includeGroups) {
    const groupsKey = options.groupsKey ?? "groups";
    const groupField = options.groupField ?? "allowFrom";
    const groups = asObjectRecord(scope.account[groupsKey]);
    if (groups) {
      for (const [groupKey, groupRaw] of Object.entries(groups)) {
        const group = asObjectRecord(groupRaw);
        if (!group) {
          continue;
        }
        lists.push({
          pathLabel: `${scope.prefix}.${groupsKey}.${groupKey}.${groupField}`,
          list: group[groupField],
        });
      }
    }
  }
  return lists;
}

function stripMutableAllowEntryPrefixes(value: string, prefixes: readonly string[]): string {
  let current = value;
  for (;;) {
    const prefix = prefixes.find(
      (candidate) => current.slice(0, candidate.length).toLowerCase() === candidate.toLowerCase(),
    );
    if (prefix === undefined) {
      return current;
    }
    current = current.slice(prefix.length).trim();
  }
}

/** Build a mutable-name detector by stripping channel prefixes and recognizing stable IDs. */
export function buildMutableAllowEntryDetector(params: {
  prefixes?: readonly string[];
  stableIdPattern: RegExp;
}): (entry: string) => boolean {
  const prefixes = (params.prefixes ?? []).filter((prefix) => prefix.length > 0);
  return (entry) => {
    const text = entry.trim();
    if (!text || text === "*" || parseAccessGroupAllowFromEntry(text) !== null) {
      return false;
    }
    const normalized = stripMutableAllowEntryPrefixes(text, prefixes);
    if (!normalized) {
      return false;
    }
    params.stableIdPattern.lastIndex = 0;
    return !params.stableIdPattern.test(normalized);
  };
}

type ChannelMutableAllowlistHit = {
  path: string;
  entry: string;
  dangerousFlagPath: string;
};

function collectMutableAllowlistWarningLines(
  hits: ChannelMutableAllowlistHit[],
  channel: string,
): string[] {
  if (hits.length === 0) {
    return [];
  }
  const exampleLines = hits
    .slice(0, 8)
    .map((hit) => `- ${sanitizeForLog(hit.path)}: ${sanitizeForLog(hit.entry)}`);
  // Keep doctor output actionable without dumping large allowlists into logs.
  const remaining =
    hits.length > 8 ? `- +${hits.length - 8} more mutable allowlist entries.` : null;
  const flagPaths = uniqueStrings(hits.map((hit) => hit.dangerousFlagPath));
  const flagHint =
    flagPaths.length === 1
      ? sanitizeForLog(flagPaths[0] ?? "")
      : `${sanitizeForLog(flagPaths[0] ?? "")} (and ${flagPaths.length - 1} other scope flags)`;
  return [
    `- Found ${hits.length} mutable allowlist ${hits.length === 1 ? "entry" : "entries"} across ${channel} while name matching is disabled by default.`,
    ...exampleLines,
    ...(remaining ? [remaining] : []),
    `- Option A (break-glass): enable ${flagHint}=true to keep name/email/nick matching.`,
    "- Option B (recommended): resolve names/emails/nicks to stable sender IDs and rewrite the allowlist entries.",
  ];
}

/**
 * Create a warning collector for mutable name/email/nick allowlists while stable-id matching is required.
 * Channel plugins provide a detector for entries that depend on dangerous name matching.
 */
export function createDangerousNameMatchingMutableAllowlistWarningCollector(params: {
  channel: string;
  detector: (entry: string) => boolean;
  collectLists: (scope: {
    prefix: string;
    account: Record<string, unknown>;
    dangerousFlagPath: string;
  }) => ChannelMutableAllowlistCandidate[];
}) {
  return ({ cfg }: { cfg: OpenClawConfig }): string[] => {
    const hits: ChannelMutableAllowlistHit[] = [];
    for (const scope of collectProviderDangerousNameMatchingScopes(cfg, params.channel)) {
      if (scope.dangerousNameMatchingEnabled) {
        continue;
      }
      for (const candidate of params.collectLists(scope)) {
        if (!Array.isArray(candidate.list)) {
          continue;
        }
        for (const entry of candidate.list) {
          const text = String(entry).trim();
          if (!text || text === "*" || !params.detector(text)) {
            continue;
          }
          hits.push({
            path: candidate.pathLabel,
            entry: text,
            dangerousFlagPath: scope.dangerousFlagPath,
          });
        }
      }
    }
    return collectMutableAllowlistWarningLines(hits, params.channel);
  };
}

/**
 * Compose the common account-scoped DM policy resolver with restrict-senders group warnings.
 * This is the shared adapter shape for channels whose DM security and group policy live together.
 */
export function createRestrictSendersChannelSecurity<
  ResolvedAccount extends { accountId?: string | null },
>(params: {
  /** Channel config key used for default account lookup and warning collection. */
  channelKey: string;
  /** Reads the account-level DM policy value before shared defaults are applied. */
  resolveDmPolicy: (account: ResolvedAccount) => string | null | undefined;
  /** Reads account-level sender allowlist entries for DM policy resolution. */
  resolveDmAllowFrom: (account: ResolvedAccount) => Array<string | number> | null | undefined;
  /** Reads the group policy value used by restrict-senders warnings. */
  resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
  /** Operator-facing surface name in warning text. */
  surface: string;
  /** Operator-facing description of who can trigger when group policy is open. */
  openScope: string;
  /** Config path shown for the group policy field that should be restricted. */
  groupPolicyPath: string;
  /** Config path shown for the group sender allowlist field. */
  groupAllowFromPath: string;
  /** Whether group replies require mentions, reducing open-policy warning severity. */
  mentionGated?: boolean;
  /** Existing channel label used by the audit and Doctor finding renderer. */
  findingTitle?: string;
  /** Override for channels whose provider presence is not the channel config key itself. */
  providerConfigPresent?: (cfg: OpenClawConfig) => boolean;
  /** Fallback account id used when scoped config inherits from another account. */
  resolveFallbackAccountId?: (account: ResolvedAccount) => string | null | undefined;
  /** Default DM policy when the account and shared defaults omit one. */
  defaultDmPolicy?: string;
  /** Account-scoped allowlist path suffix for warning/proof output. */
  allowFromPathSuffix?: string;
  /** Account-scoped policy path suffix for warning/proof output. */
  policyPathSuffix?: string;
  /** Channel id used when formatting pairing approval hints. */
  approveChannelId?: string;
  /** Explicit pairing approval hint, when the default channel hint is not correct. */
  approveHint?: string;
  /** Normalizes configured DM allowlist entries before sender matching. */
  normalizeDmEntry?: (raw: string) => string;
  classifyEntryAuthentication?: ChannelSecurityDmPolicy["classifyEntryAuthentication"];
  /** Allows non-default accounts to inherit shared defaults from the default account. */
  inheritSharedDefaultsFromDefaultAccount?: boolean;
  dmRouting?: ChannelSecurityAdapter<ResolvedAccount>["dmRouting"];
}): ChannelSecurityAdapter<ResolvedAccount> {
  const collectOpenGroupFindings = createConditionalWarningCollector.findings({
    collectWarnings: createAllowlistProviderRestrictSendersWarningCollector<ResolvedAccount>({
      providerConfigPresent:
        params.providerConfigPresent ?? ((cfg) => cfg.channels?.[params.channelKey] !== undefined),
      resolveGroupPolicy: params.resolveGroupPolicy,
      surface: params.surface,
      openScope: params.openScope,
      groupPolicyPath: params.groupPolicyPath,
      groupAllowFromPath: params.groupAllowFromPath,
      mentionGated: params.mentionGated,
    }),
    checkId: `channels.${params.channelKey}.groups.open`,
    severity: "warn",
    title: params.findingTitle ?? `${params.surface} security warning`,
  });
  return {
    resolveDmPolicy: createScopedDmSecurityResolver<ResolvedAccount>({
      channelKey: params.channelKey,
      resolvePolicy: params.resolveDmPolicy,
      resolveAllowFrom: params.resolveDmAllowFrom,
      resolveFallbackAccountId: params.resolveFallbackAccountId,
      defaultPolicy: params.defaultDmPolicy,
      allowFromPathSuffix: params.allowFromPathSuffix,
      policyPathSuffix: params.policyPathSuffix,
      approveChannelId: params.approveChannelId,
      approveHint: params.approveHint,
      normalizeEntry: params.normalizeDmEntry,
      classifyEntryAuthentication: params.classifyEntryAuthentication,
      inheritSharedDefaultsFromDefaultAccount: params.inheritSharedDefaultsFromDefaultAccount,
    }),
    ...(params.dmRouting ? { dmRouting: params.dmRouting } : {}),
    collectWarnings: collectOpenGroupFindings,
  };
}
