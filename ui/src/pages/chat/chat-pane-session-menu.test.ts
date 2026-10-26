/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createComponent, flush, merge } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import { loadSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { showToast } from "../../lib/toast.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  submitInputDialog,
  waitForConfirmDialogActions,
  waitForInputDialog,
} from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { openSubmenu } from "../../test-helpers/session-menu.ts";
import { projectChatFields } from "./chat-field-projection.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import {
  createGatewayBrowserClientFixture,
  createPaneHeaderWorkspaceFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
  getPaneTestRuntime,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { renderPaneHeaderInto } from "./components/chat-pane-header.test-support.ts";
import { PaneHeaderView } from "./components/chat-pane-header.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

vi.mock("../../lib/toast.ts", () => ({ showToast: vi.fn() }));

beforeEach(installTranscriptDomMocks);

afterEach(() => {
  resetTranscriptTestDom();
  vi.clearAllMocks();
});

function headerProps(pane: TestChatPane, row?: GatewaySessionRow, catalog = false) {
  return pane.renderPaneHeader(
    createPaneHeaderWorkspaceFixture(pane.state),
    row,
    catalog,
    undefined,
    false,
    null,
  );
}

function drawHeader(
  pane: TestChatPane,
  container: HTMLElement,
  row?: GatewaySessionRow,
  catalog = false,
) {
  renderPaneHeaderInto(headerProps(pane, row, catalog), container);
  return container.querySelector(".chat-pane__session-title-text")?.textContent?.trim();
}

function sessionRow(fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return { key: "agent:main:current", sessionId: "current-session", kind: "direct", ...fields };
}

function createPane(options: Partial<Parameters<typeof createTestChatPane>[0]> = {}) {
  return createTestChatPane({
    ...options,
    client: options.client ?? createGatewayBrowserClientFixture(),
  });
}

function renameCase(
  name: string,
  value: string,
  label: string | undefined,
  fields: Partial<GatewaySessionRow> = {},
) {
  return {
    ...sessionRow({ sessionId: "rename-current", ...fields }),
    name,
    value,
    label,
    agentId: fields.agentId ?? "main",
  };
}

async function openHeaderMenu(pane: TestChatPane, row: GatewaySessionRow) {
  const container = document.body.appendChild(document.createElement("div"));
  drawHeader(pane, container, row);
  const menu = container.querySelector("openclaw-chat-header-session-menu")!;
  await menu.updateComplete;
  expect(menu.openMenu()).toBe(true);
  flush();
  await menu.updateComplete;
  return menu;
}

describe("chat pane session menu boundary", () => {
  it("updates the retained header through rename and loaded workspace branch changes", async () => {
    const row = sessionRow({
      label: "Current conversation",
      sharingRole: "owner",
      spawnedCwd: "/workspace",
    });
    const { pane, state } = createPane({
      client: createGatewayBrowserClientFixture({
        request: async (method) =>
          method === "worktrees.branches" ? { headBranch: "feature/header" } : {},
      }),
      sessions: createSessionCapabilityFixture({ state: { result: sessionsResult([row], 1) } }),
    });
    state.sessionsResult = sessionsResult([row], 1);
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods([
      "sessions.patch",
      "system.info",
      "worktrees.branches",
    ]);
    const mounted = mountSolid(() => {
      projectChatFields(pane.headerPresentation);
      return createComponent(
        PaneHeaderView,
        merge(() => headerProps(pane, row)),
      );
    });
    flush();
    const header = mounted.container;
    pane.beginHeaderRename(row);
    flush();
    const input = header.querySelector<HTMLInputElement>(".chat-pane__session-title-input")!;
    expect(input.value).toBe("Current conversation");
    input.value = "Renamed conversation";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(pane.headerPresentation.renameValue).toBe("Renamed conversation");
    pane.cancelHeaderRename();
    flush();
    expect(header.querySelector(".chat-pane__session-title-input")).toBeNull();
    await pane.loadHeaderMenuData(row, "/workspace", true);
    flush();
    expect(pane.headerPresentation.branches.get("/workspace")?.value).toBe("feature/header");
    header.querySelector<HTMLButtonElement>(".chat-pane__workspace-chip")!.click();
    flush();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-value="copy-branch"]')).not.toBeNull(),
    );
  });

  it("discovers nested sessions before the header archive choice", async () => {
    const modal = createModalDialogTestFixture();
    const row = sessionRow({
      label: "Parent task",
      sharingRole: "owner",
      childSessions: ["agent:main:child"],
    });
    const child = sessionRow({
      key: "agent:main:child",
      sessionId: "child-session",
      parentSessionKey: row.key,
    });
    let children: GatewaySessionRow[] = [];
    const patch = vi.fn();
    const { pane, state } = createPane({
      sessions: createSessionCapabilityFixture({
        patch,
        state: { result: sessionsResult([row, child], 1) },
        describe: async () => ({ session: row }),
        refreshList: async (query) => {
          children = query?.spawnedBy === row.key ? [child] : [];
        },
        listSnapshot: () => ({
          result: sessionsResult(children, 1),
          agentId: "main",
          loading: false,
          error: null,
        }),
      }),
    });
    state.sessionKey = row.key;
    state.sessionsResult = sessionsResult([row, child], 1);
    try {
      const pending = modal.track(pane.handleHeaderSessionAction({ kind: "toggle-archived" }, row));
      const actions = await waitForConfirmDialogActions();
      expect(actions.textContent).toContain("Archive all (2)");
      answerConfirmDialog(actions, "cancel");
      await pending;
      expect(patch).not.toHaveBeenCalled();
    } finally {
      await modal.cleanup();
    }
  });

  it.each(["connected", "reconnecting"] as const)(
    "pins a readable conversation in personal navigation while %s without a session mutation",
    async (phase) => {
      const row = sessionRow({ sharingRole: "viewer", pinned: true });
      const patch = vi.fn(async () => ({}));
      const { pane, state } = createPane({
        sessions: createSessionCapabilityFixture({
          patch,
          state: { result: sessionsResult([row], 1) },
        }),
      });
      state.sessionKey = row.key;
      state.sessionsResult = sessionsResult([row], 1);
      pane.context.gateway.snapshot.phase = phase;
      state.connected = phase === "connected";
      await pane.handleHeaderSessionAction({ kind: "toggle-pin" }, row);
      expect(pane.context.navigation.snapshot.sidebarEntries).toContain("session:" + row.key);
      expect(patch).not.toHaveBeenCalled();
      await pane.handleHeaderSessionAction({ kind: "toggle-pin" }, row);
      expect(pane.context.navigation.snapshot.sidebarEntries).not.toContain("session:" + row.key);
      expect(row.pinned).toBe(true);
    },
  );
  it("routes retained menu actions through current row and settings callbacks", async () => {
    const { pane, state } = createPane({
      sessions: createSessionCapabilityFixture({ state: { groups: ["Projects"] } }),
    });
    state.settings = loadSettings();
    let session = sessionRow({
      key: state.sessionKey,
      sessionId: "current",
      label: "Current conversation",
      sharingRole: "owner",
    });
    const container = document.body.appendChild(document.createElement("div"));
    const draw = () => drawHeader(pane, container, session);
    draw();
    const menu = container.querySelector("openclaw-chat-header-session-menu")!;
    await menu.updateComplete;
    expect(menu.openMenu()).toBe(true);
    flush();
    await menu.updateComplete;
    session = { ...session, label: "Updated conversation" };
    pane.context.navigation.update({ sidebarEntries: [`session:${session.key}`] });
    draw();
    await menu.updateComplete;
    expect(container.querySelector("openclaw-chat-header-session-menu")).toBe(menu);
    expect(menu.session.label).toBe("Updated conversation");
    expect(menu.session.pinned).toBe(true);
    const action = vi.spyOn(pane, "handleHeaderSessionAction").mockResolvedValue(undefined);
    menu.querySelector<HTMLButtonElement>('[value="toggle-pin"]')!.click();
    await menu.updateComplete;
    expect(action).toHaveBeenCalledWith({ kind: "toggle-pin" }, session);
    expect(action.mock.calls[0]?.[1]).toBe(session);
    state.applySettings = vi.fn();
    expect(menu.openMenu()).toBe(true);
    flush();
    await openSubmenu(menu.querySelector(".chat-header-session-menu__panel")!, "View");
    menu.querySelector<HTMLButtonElement>('[value="view:tool-calls"]')!.click();
    await menu.updateComplete;
    expect(state.applySettings).toHaveBeenCalledWith({
      chatShowToolCalls: !state.settings.chatShowToolCalls,
    });
  });

  it("keeps observed pane titles and renames with their conversations when agent selection changes", async () => {
    const primary = sessionRow({
      key: "agent:main:dashboard:ledger",
      agentId: "main",
      sessionId: "ledger-session",
      updatedAt: 1,
      derivedTitle: "Ledger reconciliation",
    });
    const retained = sessionRow({
      key: "agent:research:dashboard:verifier",
      agentId: "research",
      sessionId: "verifier-session",
      updatedAt: 1,
      derivedTitle: "Fresh pane isolation check",
    });
    const rows = [primary, retained];
    const { sessions, context, mount, emitGatewayEvent } = createMountedPanes(
      rows,
      "main",
      undefined,
      {
        "sessions.list": (_method, params) =>
          sessionsResult(
            rows.filter((row) => row.agentId === asOptionalRecord(params)?.agentId),
            1,
          ),
        "sessions.patch": (_method, params) => {
          const request = asOptionalRecord(params);
          expect(request?.key).toBe(primary.key);
          expect(request?.expectedSessionId).toBe(primary.sessionId);
          expect(request?.label).toBe("Reviewed ledger");
          rows[0] = { ...primary, label: "Reviewed ledger", updatedAt: 2 };
          return { ok: true, key: primary.key, entry: rows[0] };
        },
      },
    );
    await sessions.refresh({ agentId: "main", force: true });
    const ledger = mount(primary.key, "main");
    const verifier = mount(retained.key, "research");
    await Promise.all([ledger, verifier].map(refreshPane));
    const container = document.body.appendChild(document.createElement("div"));
    const title = (pane: TestChatPane) =>
      drawHeader(pane, container, selectedChatSessionRow(pane.state));
    expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual([primary.key]);
    expect.soft(title(verifier)).toBe("Fresh pane isolation check");

    context.agentSelection.set("research");
    await sessions.refresh({ agentId: "research", force: true });
    expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual([retained.key]);
    expect.soft(title(ledger)).toBe("Ledger reconciliation");
    expect.soft(title(verifier)).toBe("Fresh pane isolation check");

    context.agentSelection.set("main");
    await sessions.refresh({ agentId: "main", force: true });
    emitGatewayEvent("sessions.changed", {
      sessionKey: retained.key,
      agentId: "research",
      reason: "label",
      session: { ...retained, label: "Reviewed conversation", updatedAt: 2 },
    });
    expect.soft(title(verifier)).toBe("Reviewed conversation");
    container.querySelector<HTMLButtonElement>(".chat-pane__session-title-button")?.click();
    expect(verifier.headerPresentation.renameValue).toBe("Reviewed conversation");
    verifier.cancelHeaderRename();
    expect(title(ledger)).toBe("Ledger reconciliation");

    const patch = vi.spyOn(sessions, "patch");
    container.querySelector<HTMLButtonElement>(".chat-pane__session-title-button")?.click();
    ledger.headerPresentation.renameValue = "Reviewed ledger";
    ledger.commitHeaderRename();
    expect(patch).toHaveBeenCalledOnce();
    await patch.mock.results[0]?.value;
    expect(sessions.presentation.result?.sessions[0]?.label).toBe("Reviewed ledger");
    expect(title(ledger)).toBe("Reviewed ledger");
    const menu = container.querySelector<HTMLElement & { session: { label: string } }>(
      "openclaw-chat-header-session-menu",
    );
    expect(menu?.session.label).toBe("Reviewed ledger");
  });

  it("resolves cached titles for Home aliases using the current hello defaults", () => {
    const { pane, state } = createPane({
      sessions: createSessionCapabilityFixture({
        presentation: {
          agentId: "dev",
          result: sessionsResult([{ key: "agent:dev:main", kind: "direct", label: "Dev desk" }], 1),
        },
      }),
    });
    state.sessionKey = "main";
    state.hello = {
      ...state.hello!,
      snapshot: {
        sessionDefaults: {
          defaultAgentId: "dev",
          mainKey: "main",
          mainSessionKey: "agent:dev:main",
        },
      },
    };
    const container = document.createElement("div");
    expect(drawHeader(pane, container)).toBe("Dev desk");
  });

  it("keeps reconnect presentation and catalog names ahead of incomplete pane metadata", () => {
    const presentation = {
      result: sessionsResult(
        [{ key: "agent:main:current", kind: "direct", label: "Retained conversation" }],
        1,
      ),
    };
    const { pane } = createPane({
      client: createGatewayBrowserClientFixture({
        request: (method) =>
          method === "agents.list"
            ? { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] }
            : method === "sessions.describe"
              ? { session: null }
              : {},
      }),
      sessions: createSessionCapabilityFixture({ state: presentation }),
    });
    const connected = { ...pane.context.gateway.snapshot };
    pane.applyGatewaySnapshot({ ...connected, phase: "reconnecting" });
    const container = document.createElement("div");
    const row = sessionRow({
      key: "agent:main:dashboard:retained",
      sessionId: undefined,
      derivedTitle: "Partial reconnect metadata",
    });
    const draw = (session: GatewaySessionRow | undefined, catalog = false) =>
      drawHeader(pane, container, session, catalog);
    expect(draw(undefined)).toBe("Retained conversation");
    expect(container.querySelector(".chat-pane__session-title")?.getAttribute("title")).toBe(
      "Connect to the Gateway to change sessions.",
    );
    expect(container.querySelector(".chat-pane__session-title-button")).toBeNull();
    pane.applyGatewaySnapshot(connected);
    expect(draw(undefined)).toBe("Retained conversation");
    expect(container.querySelector(".chat-pane__session-title")?.getAttribute("title")).toBe(
      "Retained conversation",
    );
    expect(container.querySelector(".chat-pane__session-title-button")).toBeNull();
    expect(draw({ ...row, sessionId: "retained", sharingRole: "owner" })).toBe(
      "Retained conversation",
    );
    expect(
      container.querySelector(".chat-pane__session-title-button")?.getAttribute("aria-label"),
    ).toBe("Rename session Retained conversation");
    pane.applyGatewaySnapshot({ ...connected, phase: "reconnecting" });
    expect(draw(row)).toBe("Retained conversation");
    expect(draw({ ...row, label: "Older scoped label" })).toBe("Retained conversation");
    expect(container.querySelector("openclaw-chat-header-session-menu")).not.toBeNull();
    pane.applyGatewaySnapshot(connected);
    expect(draw(row)).toBe("Retained conversation");
    const menu = container.querySelector<HTMLElement & { session: { label: string } }>(
      "openclaw-chat-header-session-menu",
    );
    expect(menu?.session.label).toBe("Retained conversation");
    pane.applyGatewaySnapshot({ ...connected, phase: "reconnecting" });
    pane.history.catalogSession = {
      threadId: "catalog",
      name: "Imported conversation",
      status: "idle",
      archived: false,
      canContinue: true,
      canArchive: true,
    };
    expect(draw(row, true)).toBe("Imported conversation");
    presentation.result = sessionsResult([], 2);
    expect(draw(row)).toBe("Partial reconnect metadata");
  });

  it.each([
    { key: "agent:main:current", archived: true },
    { key: "agent:main:fork", parentSessionKey: "agent:main:parent" },
    { key: "agent:main:subagent:child" },
  ])("renders available header actions for $key (archived: $archived)", async (fields) => {
    const { pane, state } = createPane({ sessions: createSessionCapabilityFixture() });
    state.settings = loadSettings();
    const menu = await openHeaderMenu(
      pane,
      sessionRow({ ...fields, sessionId: "current", updatedAt: 0 }),
    );
    if (fields.archived === undefined) {
      expect(menu?.querySelector('[value="toggle-pin"]')).toBeNull();
    } else {
      const action = menu?.querySelector<HTMLElement & { disabled: boolean }>(
        '[value="toggle-archived"]',
      );
      expect(action).not.toBeNull();
      expect(action?.disabled).toBe(false);
      expect(action?.textContent).toContain(
        t(fields.archived ? "sessionsView.restoreSession" : "sessionsView.archiveSession"),
      );
    }
  });

  it.each([
    ["agent:main:plugin:anthropic:catalog-adopt:claude:fixture", false],
    ["agent:main:ordinary", true],
  ])(
    "offers header Delete only when the transcript belongs to OpenClaw: %s",
    async (key, allowed) => {
      const { pane, state } = createPane();
      state.settings = loadSettings();
      const menu = await openHeaderMenu(
        pane,
        sessionRow({ key, sessionId: "fixture", updatedAt: 0 }),
      );
      await openSubmenu(menu!.querySelector(".chat-header-session-menu__panel")!, "Advanced");
      const deleteItem = menu?.querySelector<HTMLElement & { disabled: boolean }>(
        '[value="delete"]',
      );
      expect(deleteItem).not.toBeNull();
      expect(deleteItem?.disabled).toBe(!allowed);
    },
  );

  it("forks through the shared session organizer flow and selects the new session", async () => {
    const create = vi.fn(async () => "agent:main:forked");
    const sessions = createSessionCapabilityFixture({
      create,
      state: { error: null },
    });
    const { pane } = createPane({ sessions });
    Object.assign(pane.context.gateway.snapshot.hello?.features ?? {}, {
      methods: ["sessions.patch", "sessions.create"],
    });
    const onPaneSessionChange = vi.fn();
    pane.onPaneSessionChange = onPaneSessionChange;
    const session = sessionRow({ sessionId: undefined, updatedAt: 0, hasActiveRun: true });

    await pane.handleHeaderSessionAction({ kind: "fork" }, session);

    expect(create).toHaveBeenCalledWith(
      {
        parentSessionKey: session.key,
        fork: true,
        forkFrom: "last-completed",
        agentId: "main",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(onPaneSessionChange).toHaveBeenCalledWith("single", "agent:main:forked");
  });

  it.each([
    [{ kind: "toggle-pin" }, { pinned: true }, "replacement"],
    [{ kind: "toggle-unread" }, { unread: true }, "replacement"],
    [
      { kind: "set-communication", communication: { send: "never" } },
      { communication: { send: "never" } },
      "replacement",
    ],
    [
      { kind: "set-communication", communication: { send: "never" } },
      { communication: { send: "never" } },
      "removed",
    ],
    [{ kind: "set-icon", icon: "🦞" }, { icon: "🦞" }, "replacement"],
    [{ kind: "set-color", color: "red" }, { color: "red" }, "replacement"],
    [{ kind: "reset-appearance" }, { icon: null, color: null }, "replacement"],
    [{ kind: "move-to-group", category: "Projects" }, { category: "Projects" }, "replacement"],
    [{ kind: "move-to-group", category: "Projects" }, { category: "Projects" }, "refreshed"],
  ] as const)(
    "keeps header %j scoped to its captured row (patch %j, %s)",
    async (action, expectedPatch, current) => {
      const patch = vi.fn(async () => ({}));
      const original = sessionRow({
        sessionId: current === "removed" ? undefined : "original-session",
        updatedAt: 0,
        ...(current === "refreshed" ? { category: "Projects" } : {}),
      });
      const result = sessionsResult([original], 1);
      const sessions = createSessionCapabilityFixture({
        patch,
        state: { error: null, groups: ["Projects", "Other"], result },
      });
      const { pane, state } = createPane({ sessions });
      state.sessionsResult = result;
      result.sessions =
        current === "removed"
          ? []
          : [
              {
                ...original,
                ...(current === "refreshed"
                  ? { category: "Other" }
                  : { sessionId: "replacement-session" }),
              },
            ];
      await pane.handleHeaderSessionAction(action, original);
      if (action.kind === "toggle-pin") {
        expect(patch).not.toHaveBeenCalled();
        expect(pane.context.navigation.snapshot.sidebarEntries).toEqual([]);
      } else if (current === "removed") {
        expect(patch).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith({ message: t("common.refresh") });
      } else {
        expect(patch).toHaveBeenCalledWith(original.key, expectedPatch, {
          agentId: "main",
          expectedSessionId: original.sessionId,
        });
      }
    },
  );

  it("keeps the mobile rename draft through reconnect without retargeting session or client", async () => {
    const modal = createModalDialogTestFixture();
    const row = sessionRow({
      key: "global",
      sessionId: "research-global",
      kind: "global",
      label: "Research notes",
    });
    const patch = vi.fn(async () => ({}));
    const { pane, state } = createPane({
      client: createGatewayBrowserClientFixture({
        request: async (method, params) => {
          switch (method) {
            case "agent.identity.get":
              expect(params).toEqual({ agentId: "research" });
              return { agentId: "research", name: "Research" };
            case "agents.list":
              return makeBootRoster({ agents: [{ id: "main" }, { id: "research" }] });
            case "sessions.describe":
              return { session: null };
            default:
              return {};
          }
        },
      }),
      sessions: createSessionCapabilityFixture({ patch }),
    });
    getPaneTestRuntime(pane).mergedChrome = true;
    getPaneTestRuntime(pane).agentId = "research";
    state.sessionKey = row.key;
    state.assistantAgentId = "research";
    try {
      const cancelled = modal.track(pane.handleHeaderSessionAction({ kind: "rename" }, row));
      const first = await waitForInputDialog();
      expect(first.value).toBe("Research notes");
      first.value = "Discarded draft";
      first.dispatchEvent(new Event("input", { bubbles: true }));
      const cancel = [
        ...document.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button"),
      ].find((button) => button.textContent === "Cancel");
      expect(cancel).toBeDefined();
      cancel!.click();
      await cancelled;
      expect(patch).not.toHaveBeenCalled();

      const connected = { ...pane.context.gateway.snapshot };
      pane.applyGatewaySnapshot({ ...connected, phase: "offline" });
      patch.mockResolvedValueOnce({ queued: true });
      const queued = modal.track(pane.handleHeaderSessionAction({ kind: "rename" }, row));
      const offlineInput = await waitForInputDialog();
      expect(offlineInput.value).toBe("Research notes");
      expect(pane.context.gateway.snapshot.phase).toBe("offline");
      await submitInputDialog("  Queued offline notes  ");
      await queued;
      expect(patch).toHaveBeenCalledExactlyOnceWith(
        "global",
        { label: "Queued offline notes" },
        { agentId: "research", expectedSessionId: "research-global" },
      );
      expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
      pane.applyGatewaySnapshot(connected);

      const saved = modal.track(pane.handleHeaderSessionAction({ kind: "rename" }, row));
      const input = await waitForInputDialog();
      expect(input.value).toBe("Research notes");
      expect(pane.headerPresentation.renameSession).toBeNull();
      input.value = "Unsent notes";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      pane.applyGatewaySnapshot({ ...connected, phase: "reconnecting", hello: null });
      flush();
      expect(document.querySelector("openclaw-modal-dialog input")).toBe(input);
      expect(input.value).toBe("Unsent notes");
      expect(input.disabled).toBe(false);
      expect(
        input.closest("form")!.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled,
      ).toBe(true);
      input
        .closest("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      expect(patch).toHaveBeenCalledTimes(1);
      pane.applyGatewaySnapshot(connected);
      // A roster refresh must not retarget the draft to a new session instance.
      row.sessionId = "replacement-global";
      row.label = "Replacement title";
      await submitInputDialog("  Renamed notes  ");
      await saved;
      expect(patch).toHaveBeenCalledTimes(2);
      expect(patch).toHaveBeenNthCalledWith(
        2,
        "global",
        { label: "Renamed notes" },
        { agentId: "research", expectedSessionId: "research-global" },
      );
      expect(document.querySelector("openclaw-modal-dialog")).toBeNull();

      const retired = modal.track(pane.handleHeaderSessionAction({ kind: "rename" }, row));
      const retiredInput = await waitForInputDialog();
      retiredInput.value = "Other client must not inherit this";
      pane.applyGatewaySnapshot({
        ...connected,
        client: createGatewayBrowserClientFixture(),
        phase: "reconnecting",
        hello: null,
      });
      await retired;
      expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(patch).toHaveBeenCalledTimes(2);
    } finally {
      await modal.cleanup();
    }
  });

  it.each([
    renameCase("trimmed label", "  Renamed session  ", "Renamed session"),
    renameCase("canonical global", "Research thread", "Research thread", {
      key: "global",
      sessionId: "research-global",
      agentId: "research",
    }),
    renameCase("unchanged generated title", "Generated title", undefined, {
      key: "agent:main:dashboard:generated",
      sessionId: undefined,
      displayName: "Generated title",
    }),
  ])(
    "renames only an edited captured session: $name",
    ({ key, sessionId, displayName, value, label, agentId }) => {
      const patch = vi.fn(async () => ({}));
      const { pane, state } = createPane({
        sessions: createSessionCapabilityFixture({ patch }),
      });
      state.sessionKey = key;
      state.assistantAgentId = agentId;
      const session = sessionRow({
        key,
        sessionId,
        displayName,
        kind: key === "global" ? "global" : "direct",
        updatedAt: 0,
      });
      pane.beginHeaderRename(session);
      if (displayName) {
        expect(pane.headerPresentation.renameValue).toBe(displayName);
      }
      pane.headerPresentation.renameValue = value;
      pane.commitHeaderRename();
      if (!label) {
        pane.beginHeaderRename(session);
        pane.cancelHeaderRename();
        expect(patch).not.toHaveBeenCalled();
        return;
      }
      expect(patch).toHaveBeenCalledWith(key, { label }, { agentId, expectedSessionId: sessionId });
      if (key !== "global") {
        pane.beginHeaderRename({ ...session, label });
        pane.headerPresentation.renameValue = "   ";
        pane.commitHeaderRename();
        expect(patch).toHaveBeenLastCalledWith(
          key,
          { label: null },
          { agentId, expectedSessionId: sessionId },
        );
      }
    },
  );
});
