import fs from "node:fs/promises";
import path from "node:path";
import {
  normalizeSortedUniqueTrimmedStringList,
  normalizeTrimmedStringList,
} from "@openclaw/normalization-core/string-normalization";
import {
  ErrorCodes,
  errorShape,
  validateSkillsBinsParams,
  validateSkillsDetailParams,
  validateSkillsSearchParams,
  validateSkillsSecurityVerdictsParams,
  validateSkillsSkillCardParams,
  validateSkillsUpdateParams,
  validateSkillsFileGetParams,
  buildClawHubTrustErrorDetails,
  validateSkillsInstallParams,
  type ErrorShape,
  type ProtocolValidator,
  validateSkillsUploadBeginParams,
  validateSkillsUploadChunkParams,
  validateSkillsUploadCommitParams,
  validateSkillsWorkshopArchiveParams,
  validateSkillsWorkshopChangesParams,
  validateSkillsWorkshopListParams,
  validateSkillsWorkshopReadParams,
  validateSkillsWorkshopRestoreParams,
  validateSkillsWorkshopUndoParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope-config.js";
import { resolveToCwd } from "../../agents/sessions/tools/path-utils.js";
import { redactConfigObject } from "../../config/redact-snapshot.js";
import { fetchClawHubSkillDetail } from "../../infra/clawhub-skills.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { root } from "../../infra/fs-safe.js";
import { retainMutationAuthority } from "../../infra/mutation-authority.js";
import { registerClawHubCatalogIconUrls } from "../../plugins/catalog-icon-registry.js";
import { shouldRejectHardlinkedPluginFiles } from "../../plugins/hardlink-policy.js";
import { getOrCreatePromise } from "../../shared/lazy-promise.js";
import { updateSkillConfigEntry } from "../../skills/config/mutations.js";
import { parseRequestedClawHubSkillRef } from "../../skills/lifecycle/clawhub-store.js";
import {
  searchSkillsFromClawHub,
  updateSkillsFromClawHub,
  installSkillFromClawHub,
} from "../../skills/lifecycle/clawhub.js";
import { installSkill } from "../../skills/lifecycle/install.js";
import {
  installUploadedSkillArchive,
  areUploadedSkillArchivesEnabled,
  UPLOADED_SKILL_ARCHIVES_DISABLED_MESSAGE,
} from "../../skills/lifecycle/upload-install.js";
import { SkillUploadRequestError } from "../../skills/lifecycle/upload-store-error.js";
import { defaultSkillUploadStore } from "../../skills/lifecycle/upload-store.js";
import { resolveSkillDiscoveryLimits } from "../../skills/loading/skill-root-discovery.js";
import { resolveSkillTelemetrySourceValue } from "../../skills/loading/source.js";
import { prepareWorkspaceSkillEntries } from "../../skills/loading/workspace-skill-loader.js";
import {
  collectClawHubVerdictTargets,
  fetchOpenClawSkillSecurityVerdicts,
} from "../../skills/security/clawhub-verdicts.js";
import { resolveSkillFileHost } from "../../skills/skill-file-host.js";
import {
  archiveWorkshopSkill,
  listWorkshopChanges,
  restoreWorkshopSkill,
  viewWorkshopSkill,
  WorkshopWriteError,
} from "../../skills/workshop/library.js";
import { undoWorkshopReview } from "../../skills/workshop/review-undo.js";
import { buildSkillsWorkshopListResult } from "../../skills/workshop/workshop-list.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { captureGatewayClientUploadCommitGuard } from "../upload-policy.js";
import { respondError } from "./response.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./shared-types.js";
import { skillsLibraryHandlers } from "./skills-library.js";
import { skillsRetiredHandlers } from "./skills-retired.js";
import { buildRemoteAwareWorkspaceSkillStatus, handleSkillsStatus } from "./skills-status.js";
import {
  resolveSkillsAgentWorkspace,
  type ResolvedSkillsWorkspace,
} from "./skills-workspace-handler.js";
import type { GatewayRequestHandlers, GatewayRequestHandler } from "./types.js";
import { assertValidParams, defineValidatedGatewayHandler, type Validator } from "./validation.js";

type ClawHubInstallResult = Awaited<ReturnType<typeof installSkillFromClawHub>>;

const clawHubInstallsInFlight = new Map<string, Promise<ClawHubInstallResult>>();

function mapUploadError(err: unknown): ErrorShape {
  if (err instanceof SessionMutationAuthorizationChangedError) {
    return err.error;
  }
  if (err instanceof SkillUploadRequestError) {
    return errorShape(ErrorCodes.INVALID_REQUEST, err.message);
  }
  return errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(err));
}

function makeUploadHandler<P, R>(
  name: string,
  validator: ProtocolValidator<P>,
  action: (params: P, assertCommitAllowed?: () => void) => Promise<R>,
): GatewayRequestHandlers[string] {
  return async ({ params, respond, context, client }) => {
    if (!areUploadedSkillArchivesEnabled(context.getRuntimeConfig())) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, UPLOADED_SKILL_ARCHIVES_DISABLED_MESSAGE),
      );
      return;
    }
    if (!assertValidParams(params, validator, name, respond)) {
      return;
    }
    try {
      const guard = captureGatewayClientUploadCommitGuard({
        method: name,
        requestParams: params,
        client,
        context,
      });
      respond(true, await action(params, guard), undefined);
    } catch (err) {
      respond(false, undefined, mapUploadError(err));
    }
  };
}

function defineWorkshopHandler<TParams extends { agentId?: string } & Record<string, unknown>>(
  method: string,
  validate: Validator<TParams>,
  run: (
    params: TParams,
    resolved: ResolvedSkillsWorkspace,
    invocation: GatewayRequestHandlerOptions,
  ) => Promise<unknown>,
): GatewayRequestHandler {
  return defineValidatedGatewayHandler(method, validate, async (invocation) => {
    const { params, respond, context } = invocation;
    const resolved = resolveSkillsAgentWorkspace(params, context);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    try {
      respond(true, await run(params, resolved, invocation), undefined);
    } catch (error) {
      if (!(error instanceof WorkshopWriteError)) {
        throw error;
      }
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
    }
  });
}

function workshopWriteContext(
  resolved: ResolvedSkillsWorkspace,
  invocation: GatewayRequestHandlerOptions,
) {
  return {
    config: resolved.cfg,
    agentId: resolved.agentId,
    actor: "user" as const,
    assertLive: readGatewayRequestMutationAuthority(invocation).assertCurrent,
  };
}

export const skillsHandlers: GatewayRequestHandlers = {
  "skills.files.get": async ({ params, respond, context, signal, hasCurrentClientAuthority }) => {
    if (!assertValidParams(params, validateSkillsFileGetParams, "skills.files.get", respond)) {
      return;
    }
    const resolved = resolveSkillsAgentWorkspace(params, context);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    const assertCurrent = () => {
      if (
        signal?.aborted ||
        hasCurrentClientAuthority?.() === false ||
        context.getRuntimeConfig() !== resolved.cfg
      ) {
        throw new Error("Skill file access changed; retry.");
      }
    };
    try {
      const requestedPath = path.resolve(resolveToCwd(params.path, resolved.workspaceDir));
      const { entries } = await prepareWorkspaceSkillEntries(
        resolved.workspaceDir,
        { config: resolved.cfg, agentId: resolved.agentId, agentSkillFilter: "ignore" },
        assertCurrent,
      );
      // Discovery is the allowlist. Workspace-host and node paths must never
      // authorize reads from an identically named path on the Gateway host.
      const requestedRealPath = await fs.realpath(requestedPath);
      const entry = entries.find(
        ({ skill }) =>
          resolveSkillFileHost(skill) !== "workspace" &&
          !skill.filePath.startsWith("node://") &&
          (path.resolve(skill.filePath) === requestedPath ||
            path.resolve(skill.filePath) === requestedRealPath),
      );
      if (!entry) {
        throw new Error("Skill file is not installed locally for this agent");
      }
      const { skill } = entry;
      const skillRoot = await root(skill.baseDir);
      assertCurrent();
      const read = await skillRoot.read("SKILL.md", {
        maxBytes: resolveSkillDiscoveryLimits(resolved.cfg).maxSkillFileBytes,
        symlinks: "follow-within-root",
        hardlinks: shouldRejectHardlinkedPluginFiles({
          origin:
            resolveSkillTelemetrySourceValue(skill.source) === "bundled" ? "bundled" : "workspace",
          rootDir: skill.baseDir,
        })
          ? "reject"
          : "allow",
      });
      assertCurrent();
      respond(true, {
        path: skill.filePath,
        name: skill.name,
        content: read.buffer.toString("utf8"),
      });
    } catch {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Skill file is unavailable locally, outside its skill directory, or exceeds the skill file size limit",
        ),
      );
    }
  },
  ...skillsLibraryHandlers,
  "skills.upload.begin": makeUploadHandler(
    "skills.upload.begin",
    validateSkillsUploadBeginParams,
    (params, guard) => defaultSkillUploadStore.begin(params, guard),
  ),
  "skills.upload.chunk": makeUploadHandler(
    "skills.upload.chunk",
    validateSkillsUploadChunkParams,
    (params, guard) => defaultSkillUploadStore.chunk(params, guard),
  ),
  "skills.upload.commit": makeUploadHandler(
    "skills.upload.commit",
    validateSkillsUploadCommitParams,
    (params, guard) => defaultSkillUploadStore.commit(params, guard),
  ),
  "skills.workshop.list": defineWorkshopHandler(
    "skills.workshop.list",
    validateSkillsWorkshopListParams,
    (_params, resolved) =>
      buildSkillsWorkshopListResult({ config: resolved.cfg, agentId: resolved.agentId }),
  ),
  "skills.workshop.changes": defineWorkshopHandler(
    "skills.workshop.changes",
    validateSkillsWorkshopChangesParams,
    async (params, resolved) => ({
      changes: await listWorkshopChanges(resolved.agentId, {
        limit: params.limit,
        beforeMs: params.beforeMs,
      }),
    }),
  ),
  "skills.workshop.read": defineWorkshopHandler(
    "skills.workshop.read",
    validateSkillsWorkshopReadParams,
    (params, resolved) =>
      viewWorkshopSkill(
        resolved.cfg,
        resolved.agentId,
        params.name,
        params.filePath,
        params.versionId,
      ),
  ),
  "skills.workshop.archive": defineWorkshopHandler(
    "skills.workshop.archive",
    validateSkillsWorkshopArchiveParams,
    // Captured at admission; the library rechecks it before each final file effect.
    async (params, resolved, invocation) => ({
      change: await archiveWorkshopSkill(workshopWriteContext(resolved, invocation), {
        name: params.name,
        reason: params.reason,
      }),
    }),
  ),
  "skills.workshop.restore": defineWorkshopHandler(
    "skills.workshop.restore",
    validateSkillsWorkshopRestoreParams,
    async (params, resolved, invocation) => ({
      change: await restoreWorkshopSkill(workshopWriteContext(resolved, invocation), {
        name: params.name,
        versionId: params.versionId,
      }),
    }),
  ),
  "skills.workshop.undo": defineWorkshopHandler(
    "skills.workshop.undo",
    validateSkillsWorkshopUndoParams,
    (params, resolved, invocation) =>
      undoWorkshopReview(workshopWriteContext(resolved, invocation), { runId: params.runId }),
  ),
  ...skillsRetiredHandlers,
  "skills.status": handleSkillsStatus,
  "skills.securityVerdicts": defineValidatedGatewayHandler(
    "skills.securityVerdicts",
    validateSkillsSecurityVerdictsParams,
    async ({ params, respond, context }) => {
      const resolved = resolveSkillsAgentWorkspace(params, context);
      if (!resolved.ok) {
        respond(false, undefined, resolved.error);
        return;
      }
      try {
        const { report } = await buildRemoteAwareWorkspaceSkillStatus(resolved);
        const targets = collectClawHubVerdictTargets(report);
        const items = targets.length === 0 ? [] : await fetchOpenClawSkillSecurityVerdicts(targets);
        respond(true, { schema: "openclaw.skills.security-verdicts.v1", items }, undefined);
      } catch (error) {
        respondError(respond, ErrorCodes.UNAVAILABLE, formatErrorMessage(error));
      }
    },
  ),
  "skills.skillCard": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSkillsSkillCardParams, "skills.skillCard", respond)) {
      return;
    }
    const resolved = resolveSkillsAgentWorkspace(params, context);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    const { report, files } = await buildRemoteAwareWorkspaceSkillStatus(
      resolved,
      undefined,
      params.skillKey,
    );
    const skill = report.skills.find((candidate) => candidate.skillKey === params.skillKey);
    const content = skill?.skillCard
      ? files.find((file) => file.name === skill.name && file.filePath === skill.filePath)
          ?.skillCard?.content
      : undefined;
    if (!skill?.skillCard || content === undefined) {
      respondError(
        respond,
        ErrorCodes.INVALID_REQUEST,
        `skill card not ${skill?.skillCard ? "readable" : "found"} for ${params.skillKey}`,
      );
      return;
    }
    respond(
      true,
      {
        schema: "openclaw.skills.skill-card.v1",
        skillKey: skill.skillKey,
        path: skill.skillCard.path,
        sizeBytes: skill.skillCard.sizeBytes,
        content,
      },
      undefined,
    );
  },
  "skills.bins": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSkillsBinsParams, "skills.bins", respond)) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const bins = new Set<string>();
    for (const agentId of listAgentIds(cfg)) {
      // Node inventories include missing requirements, not only locally usable skills.
      const { entries } = await prepareWorkspaceSkillEntries(
        resolveAgentWorkspaceDir(cfg, agentId),
        {
          config: cfg,
          agentId,
          agentSkillFilter: "ignore",
        },
      );
      for (const bin of normalizeSortedUniqueTrimmedStringList(
        entries.flatMap((entry) =>
          (entry.metadata?.requires?.bins ?? []).concat(
            entry.metadata?.requires?.anyBins ?? [],
            (entry.metadata?.install ?? []).flatMap((spec) => spec?.bins ?? []),
          ),
        ),
      )) {
        bins.add(bin);
      }
    }
    respond(true, { bins: [...bins].toSorted() }, undefined);
  },
  "skills.search": defineValidatedGatewayHandler(
    "skills.search",
    validateSkillsSearchParams,
    async ({ params, respond }) => {
      const results = await searchSkillsFromClawHub({
        query: params.query,
        limit: params.limit,
      });
      registerClawHubCatalogIconUrls(results.map((result) => result.icon ?? undefined));
      respond(true, { results }, undefined);
    },
    (error) => errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)),
  ),
  "skills.detail": defineValidatedGatewayHandler(
    "skills.detail",
    validateSkillsDetailParams,
    async ({ params, respond }) => {
      // Same reference grammar as skills.install, so a client cannot review one publisher's
      // card and then install another's.
      const requested = parseRequestedClawHubSkillRef(params.slug);
      if (requested.requestedReference) {
        // ClawHub has no source-qualified read endpoint, so reading this by bare slug would
        // show a same-slug registry skill while install resolves the external artifact.
        // Refusing keeps review and install on one identity until that contract exists.
        respondError(
          respond,
          ErrorCodes.INVALID_REQUEST,
          `ClawHub cannot return details for ${requested.requestedReference}; external skill sources are install-only. Install it directly, or run "openclaw skills install ${requested.requestedReference}".`,
        );
        return;
      }
      const detail = await fetchClawHubSkillDetail({
        slug: requested.slug,
        includeInspection: true,
        ...(params.version ? { version: params.version } : {}),
        ...(requested.ownerHandle ? { ownerHandle: requested.ownerHandle } : {}),
      });
      registerClawHubCatalogIconUrls([
        detail.skill?.icon ?? undefined,
        detail.owner?.image ?? undefined,
      ]);
      respond(true, detail, undefined);
    },
    (error) => errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)),
  ),
  "skills.install": defineValidatedGatewayHandler(
    "skills.install",
    validateSkillsInstallParams,
    async ({ params: p, respond, context, client }) => {
      const resolved = resolveSkillsAgentWorkspace(p, context);
      if (!resolved.ok) {
        respond(false, undefined, resolved.error);
        return;
      }
      const { cfg, workspaceDir: workspaceDirRaw } = resolved;
      // Skill installs are intentionally routed by source; each source owns its
      // validation, provenance checks, and result payload shape.
      if ("source" in p && p.source === "clawhub") {
        const input = {
          workspaceDir: workspaceDirRaw,
          slug: p.slug,
          version: p.version,
          force: Boolean(p.force),
          logger: context.logGateway,
          config: cfg,
        };
        // A reconnect reattaches to the exact in-flight install instead of starting it again.
        const key = JSON.stringify([
          input.workspaceDir,
          input.slug,
          input.version ?? null,
          input.force,
        ]);
        const result = await getOrCreatePromise(
          clawHubInstallsInFlight,
          key,
          () => installSkillFromClawHub(input),
          { evictOnSettled: true },
        );
        const errorDetails = result.ok ? undefined : buildClawHubTrustErrorDetails(result);
        respond(
          result.ok,
          result.ok
            ? {
                ok: true,
                message: `Installed ${result.slug}@${result.version}`,
                stdout: "",
                stderr: "",
                code: 0,
                slug: result.slug,
                version: result.version,
                targetDir: result.targetDir,
                ...(result.warning ? { warning: result.warning } : {}),
              }
            : result,
          result.ok
            ? undefined
            : errorShape(
                ErrorCodes.UNAVAILABLE,
                result.error,
                errorDetails ? { details: errorDetails } : undefined,
              ),
        );
        return;
      }
      if ("source" in p && p.source === "upload") {
        const uploadGuard = captureGatewayClientUploadCommitGuard({
          method: "skills.install",
          requestParams: p,
          client,
          context,
        });
        const assertCommitAllowed = uploadGuard ? retainMutationAuthority(uploadGuard) : undefined;
        try {
          const result = await installUploadedSkillArchive({
            uploadId: p.uploadId,
            slug: p.slug,
            force: Boolean(p.force),
            sha256: p.sha256,
            timeoutMs: p.timeoutMs,
            workspaceDir: workspaceDirRaw,
            config: cfg,
            log: context.logGateway,
            beforePersistentApply: assertCommitAllowed,
          });
          if (result.ok) {
            respond(true, result, undefined);
            return;
          }
          // Install owners return failure envelopes after rollback/lease cleanup. Retain
          // their original policy refusal instead of flattening it to UNAVAILABLE.
          assertCommitAllowed?.();
          const errorCode =
            result.errorKind === "invalid-request"
              ? ErrorCodes.INVALID_REQUEST
              : ErrorCodes.UNAVAILABLE;
          respond(
            false,
            { ok: false, error: result.error, errorCode },
            errorShape(errorCode, result.error),
          );
        } catch (error) {
          if (!(error instanceof SessionMutationAuthorizationChangedError)) {
            throw error;
          }
          respond(false, undefined, error.error);
        }
        return;
      }
      const result = await installSkill({
        workspaceDir: workspaceDirRaw,
        agentId: resolved.agentId,
        skillName: p.name,
        installId: p.installId,
        timeoutMs: p.timeoutMs,
        config: cfg,
      });
      respond(
        result.ok,
        result,
        result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.message),
      );
    },
  ),
  "skills.update": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSkillsUpdateParams, "skills.update", respond)) {
      return;
    }
    const p = params;
    if ("source" in p) {
      if (Boolean(p.slug) === Boolean(p.all)) {
        respondError(
          respond,
          ErrorCodes.INVALID_REQUEST,
          p.slug
            ? 'clawhub skills.update accepts either "slug" or "all", not both'
            : 'clawhub skills.update requires "slug" or "all"',
        );
        return;
      }
      const resolved = resolveSkillsAgentWorkspace(p, context);
      if (!resolved.ok) {
        respond(false, undefined, resolved.error);
        return;
      }
      const results = await updateSkillsFromClawHub({
        workspaceDir: resolved.workspaceDir,
        slug: p.slug,
        ...(p.force ? { force: true } : {}),
        logger: context.logGateway,
        config: resolved.cfg,
      });
      const errors = results.filter((result) => !result.ok);
      const warnings = normalizeTrimmedStringList(results.map((result) => result.warning));
      respond(
        errors.length === 0,
        {
          ok: errors.length === 0,
          skillKey: p.slug ?? "*",
          config: {
            source: "clawhub",
            results,
          },
        },
        errors.length === 0
          ? undefined
          : errorShape(ErrorCodes.UNAVAILABLE, errors.map((result) => result.error).join("; "), {
              details: {
                results,
                ...(warnings.length > 0 ? { warnings } : {}),
              },
            }),
      );
      return;
    }
    const updated = await updateSkillConfigEntry(p);
    respond(
      true,
      { ok: true, skillKey: p.skillKey, config: redactConfigObject(updated) },
      undefined,
    );
  },
};
