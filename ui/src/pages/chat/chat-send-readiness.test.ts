import { expect, it, vi } from "vitest";
// @vitest-environment node
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { sessionListResult } from "../../test-helpers/chat-model.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  findChatSendPayload,
  expectRequestCounts,
  requestCalls,
  makeChatHost,
  makeRequestMock,
  requireRecord,
} from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { enqueueChatMessage, keepVolatileQueuedMessage } from "./chat-queue.ts";
import {
  resumeStoredChatOutboxes,
  retryQueuedChatMessage,
  steerQueuedChatMessage,
} from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
import {
  adoptStartedChatRun,
  reconcileChatRunAfterSessionStatePublication,
} from "./run-lifecycle.ts";
import { applyChatCacheSnapshot, type ChatSessionSnapshot } from "./session-message-cache.ts";

function cachedTranscript(sessionId: string, displayedLeafEntryId: string): ChatSessionSnapshot {
  return {
    messages: [],
    sessionId,
    displayedLeafEntryId,
    pagination: { hasMore: false, completeSnapshot: true },
  };
}

function sessionRow(overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key: "agent:main:main",
    sessionId: "current-session",
    kind: "direct",
    updatedAt: 1,
    ...overrides,
  };
}

function sessionHistory(overrides: Partial<GatewaySessionRow> = {}): ChatHistoryResult {
  return { messages: [], sessionInfo: sessionRow(overrides) };
}

function pendingHistoryHost(overrides: Parameters<typeof makeChatHost>[0] = {}) {
  const history = createDeferred<ChatHistoryResult>();
  const host = makeChatHost({
    ...overrides,
    requestHandlers: {
      "chat.startup": () => history.promise,
      "chat.send": { status: "started", messageSeq: 1 },
      ...overrides.requestHandlers,
    },
  });
  return { history, host };
}

function startHistory(host: Parameters<typeof loadChatHistory>[0]) {
  return loadChatHistory(host, { startup: true, deferBranches: true });
}

useChatSendBrowserFixture();

it("admits consecutive drafts synchronously and delivers them in order without clearing a newer draft", async () => {
  const sessionKey = "agent:main:main";
  const sessionId = "consecutive-drafts-session";
  const host = makeChatHost({
    sessionKey,
    currentSessionId: sessionId,
    chatMessage: "First submitted draft",
    requestHandlers: {
      "chat.send": { status: "ok", messageSeq: 1 },
      "chat.history": sessionHistory({
        key: sessionKey,
        sessionId,
        hasActiveRun: false,
        status: "done",
      }),
    },
  });
  const first = handleSendChat(host);
  expect(host.chatMessage).toBe("");
  host.chatMessage = "Second submitted draft";
  const second = handleSendChat(host);
  expect(host.chatMessage).toBe("");
  expect(host.chatQueue.map((item) => item.text)).toEqual([
    "First submitted draft",
    "Second submitted draft",
  ]);
  host.chatMessage = "Newer unsent draft";

  await Promise.all([first, second]);

  await vi.waitFor(() => {
    expect(
      host.request.mock.calls
        .filter(([method]) => method === "chat.send")
        .map(([, params]) => requireRecord(params, "chat.send parameters").message),
    ).toEqual(["First submitted draft", "Second submitted draft"]);
    expect(host.chatQueue).toEqual([]);
  });
  expect(host.chatMessage).toBe("Newer unsent draft");
});

it.each([
  "newer event",
  "reentrant successor",
  "main key",
  "missing activity",
  "unqualified",
  "other agent",
])(
  "recovers a missed terminal only while its session facts remain current: %s",
  async (scenario) => {
    const newerEvent = scenario === "newer event";
    const reentrantSuccessor = scenario === "reentrant successor";
    const mainKeyChanged = scenario === "main key";
    const missingActivity = scenario === "missing activity";
    const unqualified = scenario === "unqualified" || scenario === "other agent";
    const defaultAgentId = scenario === "other agent" ? "work" : "main";
    const sessionKey = unqualified
      ? "unknown"
      : mainKeyChanged
        ? "agent:main:main"
        : "agent:main:dashboard:missed-completion-event";
    const history = createDeferred<ChatHistoryResult>();
    const historyRequested = createDeferred();
    const activity: Pick<GatewaySessionRow, "status" | "hasActiveRun"> = missingActivity
      ? {}
      : { status: "done", hasActiveRun: false };
    let listed = sessionRow({
      key: sessionKey,
      agentId: "main",
      kind: unqualified ? "unknown" : "direct",
      ...activity,
    });
    const request = makeRequestMock({
      "sessions.list": () => sessionsResult([listed], listed.updatedAt ?? 0),
      "chat.history": () => {
        historyRequested.resolve();
        return history.promise;
      },
      "chat.send": { runId: "next-run", status: "started", messageSeq: 1 },
    });
    const client = createTestGatewayClient(request);
    const { gateway, emitEvent } = createGatewayHarness(client);
    gateway.snapshot.sessionKey = sessionKey;
    const sessions = createTestSessionCapability(gateway);
    const host = makeChatHost({
      client,
      sessions,
      sessionKey,
      currentSessionId: listed.sessionId,
      chatRunId: "finished-run",
      chatRunLifecycleGeneration: 1,
      chatStream: "The current answer is still streaming.",
      chatMessage: "Continue with the next change",
      ...(mainKeyChanged ? { agentsList: { defaultId: "main", mainKey: "main" } } : {}),
      ...(unqualified
        ? { assistantAgentId: "work", agentsList: { defaultId: defaultAgentId, mainKey: "main" } }
        : {}),
    });
    let successorStarted = false;
    const stop = sessions.subscribe((state) => {
      host.sessionsResult = state.result;
      host.sessionsResultAgentId = state.agentId;
      if (reconcileChatRunAfterSessionStatePublication(host) && reentrantSuccessor) {
        successorStarted = true;
        adoptStartedChatRun(host, "reentrant-run", 3);
        keepVolatileQueuedMessage(host, host.sessionKey, {
          id: "successor-input",
          text: "Input awaiting the successor",
          createdAt: 3,
          sendRunId: "reentrant-run",
          pendingRunId: "reentrant-run",
        });
      }
    });
    let draining: ReturnType<typeof resumeStoredChatOutboxes> | undefined;
    let eventWake: ReturnType<typeof resumeStoredChatOutboxes> | undefined;
    const observation = sessions.observeRow({ key: sessionKey, agentId: "main" }, () => {}, {
      onEvent: (event) => {
        eventWake = resumeStoredChatOutboxes(host, event);
      },
    });
    try {
      await sessions.refresh({ agentId: "main", force: true });
      await handleSendChat(host, undefined, { followUpMode: "queue" });
      keepVolatileQueuedMessage(host, host.sessionKey, {
        id: "current-input",
        text: "Input awaiting the current run",
        createdAt: 1,
        sendRunId: "finished-run",
        pendingRunId: "finished-run",
      });
      expect(host.chatQueue).toHaveLength(2);
      const capturedOutboxes = listStoredChatOutboxes(host);
      const queuedIds = host.chatQueue.map((item) => item.id);
      if (unqualified || mainKeyChanged) {
        expect(capturedOutboxes).toEqual([
          {
            sessionKey,
            ...(mainKeyChanged ? { agentId: "main" } : {}),
            queue: [expect.objectContaining({ text: "Continue with the next change" })],
          },
        ]);
      }
      if (mainKeyChanged) {
        host.agentsList = { defaultId: "main", mainKey: "workspace" };
        expect(listStoredChatOutboxes(host)).toEqual(capturedOutboxes);
      }

      const runGeneration = host.chatRunLifecycleGeneration;
      draining = resumeStoredChatOutboxes(host);
      await historyRequested.promise;
      if (mainKeyChanged || unqualified) {
        expect(requestCalls(request, "chat.history")[0]?.[1]).toMatchObject({ sessionKey });
      }
      if (unqualified) {
        const historyRequests = requestCalls(request, "chat.history");
        for (const [, params] of historyRequests) {
          expect(params).not.toHaveProperty("agentId");
        }
      }
      if (newerEvent) {
        listed = {
          ...listed,
          updatedAt: 3,
          status: "running",
          hasActiveRun: true,
          activeRunIds: ["finished-run"],
        };
        emitEvent({
          type: "event",
          event: "sessions.changed",
          payload: { sessionKey, agentId: "main", reason: "run-capacity", session: listed },
        });
        expect(eventWake).toBeDefined();
      }
      expect(sessions.state.result?.sessions[0]).toMatchObject(listed);
      expect(host.chatRunId).toBe("finished-run");
      expect(host.chatRunLifecycleGeneration).toBe(runGeneration);
      expect(host.currentSessionId).toBe("current-session");

      history.resolve(
        sessionHistory({
          key: sessionKey,
          ...(unqualified ? { agentId: "main" } : {}),
          kind: unqualified ? "unknown" : "direct",
          updatedAt: 2,
          ...activity,
          lastRunId: "finished-run",
        }),
      );
      await Promise.all([draining, eventWake]);

      const sends = requestCalls(request, "chat.send");
      if (missingActivity || newerEvent || (unqualified && defaultAgentId !== "main")) {
        expect(sends).toHaveLength(0);
        expect(host.chatRunId).toBe("finished-run");
        expect(host.chatStream).toBe("The current answer is still streaming.");
        expect(host.chatQueue).toHaveLength(2);
      }
      if (missingActivity) {
        const projected = sessions.state.result?.sessions[0];
        expect(projected).toMatchObject({
          key: sessionKey,
          sessionId: "current-session",
          lastRunId: "finished-run",
        });
        expect(projected?.status).toBeUndefined();
        expect(projected?.hasActiveRun).toBeUndefined();
        expect(host.chatRunLifecycleGeneration).toBe(runGeneration);
        expect(host.chatQueue).toContainEqual(
          expect.objectContaining({
            text: "Input awaiting the current run",
            pendingRunId: "finished-run",
          }),
        );
        return;
      }
      if (unqualified && defaultAgentId !== "main") {
        // The lifecycle matcher still refuses a row outside the current visible agent.
        expect(host.chatRunLifecycleGeneration).toBe(runGeneration);
        expect(host.chatQueue.map((item) => item.id)).toEqual(queuedIds);
        const expectedOutboxes = structuredClone(capturedOutboxes);
        for (const outbox of expectedOutboxes) {
          for (const item of outbox.queue) {
            item.sessionId = "current-session";
          }
        }
        expect(listStoredChatOutboxes(host)).toEqual(expectedOutboxes);
        return;
      }
      if (mainKeyChanged) {
        expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual([sessionKey]);
        expect(listStoredChatOutboxes(host)).toEqual([]);
      }
      if (reentrantSuccessor) {
        expect(successorStarted).toBe(true);
        expect(sends).toHaveLength(0);
        expect(host.chatRunId).toBe("reentrant-run");
        expect(host.chatQueue).toHaveLength(2);
        expect(host.chatQueue.some((item) => item.pendingRunId === "finished-run")).toBe(false);
        expect(host.chatQueue.some((item) => item.pendingRunId === "reentrant-run")).toBe(true);
        return;
      }
      if (!newerEvent) {
        expect(sends).toHaveLength(1);
        if (unqualified) {
          expect(observation.row).toMatchObject({
            key: sessionKey,
            agentId: "main",
            sessionId: "current-session",
            lastRunId: "finished-run",
          });
        }
        expect(sends[0]?.[1]).toMatchObject({
          sessionKey,
          message: "Continue with the next change",
        });
        if (unqualified) {
          expect(sends[0]?.[1]).not.toHaveProperty("agentId");
        }
        expect(host.chatRunId).toBe("next-run");
        expect(host.chatQueue).toEqual([]);
        return;
      }
      expect(sessions.state.result?.sessions[0]).toMatchObject(listed);
    } finally {
      history.resolve({ messages: [], sessionInfo: listed });
      await Promise.allSettled([draining, eventWake]);
      observation.dispose();
      stop();
      sessions.dispose();
    }
  },
);

it.each(["new run", "new session", "different terminal", "still active"])(
  "reconciles queued input against terminal history (%s)",
  async (scenario) => {
    const sessionKey = "agent:main:dashboard:missed-completion";
    const history = createDeferred<ChatHistoryResult>();
    const host = makeChatHost({
      sessionKey,
      currentSessionId: "current-session",
      chatRunId: "finished-run",
      chatStream: "The previous answer is complete.",
      chatMessage: "Continue with the next change",
      requestHandlers: {
        "chat.history": () => history.promise,
        "chat.send": { runId: "next-run", status: "started", messageSeq: 1 },
      },
    });
    await handleSendChat(host, undefined, { followUpMode: "queue" });
    expectRequestCounts(host.request, { "chat.send": 0 });
    expect(host.chatQueue).toHaveLength(1);
    keepVolatileQueuedMessage(host, host.sessionKey, {
      id: "previous-input",
      text: "Input awaiting the previous run",
      createdAt: 1,
      sendRunId: "finished-run",
      pendingRunId: "finished-run",
    });

    const draining = resumeStoredChatOutboxes(host);
    await vi.waitFor(() =>
      expect(host.request).toHaveBeenCalledWith("chat.history", expect.anything(), {
        timeoutMs: 30_000,
      }),
    );
    if (scenario === "new run") {
      host.chatRunId = "newer-run";
    } else if (scenario === "new session") {
      host.currentSessionId = "replacement-session";
    }
    history.resolve(
      sessionHistory({
        key: sessionKey,
        status: scenario === "still active" ? "running" : "done",
        lastRunId: scenario === "different terminal" ? "older-run" : "finished-run",
        updatedAt: 2,
      }),
    );
    await draining;

    expectRequestCounts(host.request, { "chat.send": 0 });
    expect(host.chatQueue).toHaveLength(2);
    expect(host.chatRunId).toBe(scenario === "new run" ? "newer-run" : "finished-run");
  },
);

it.each([
  { message: "/stop", action: "abort", hydrated: true },
  { message: "/approve approval-123 allow-once", action: "approve", hydrated: true },
  { message: "/approve approval-123 allow-once", action: "approve", hydrated: false },
  { message: "ordinary draft", action: "queued", hydrated: true },
  { message: "/stop after the next turn", action: "blocked", hydrated: true },
])(
  "keeps $action admission separate from initial history (run hydrated: $hydrated)",
  async ({ message, action, hydrated }) => {
    const { history, host } = pendingHistoryHost({
      chatMessage: message,
      chatRunId: hydrated ? "waiting-run" : null,
      chatStream: hydrated ? "Waiting for approval" : null,
      requestHandlers: {
        "sessions.abort": { status: "aborted" },
        "chat.send": { runId: "approval-command", status: "started" },
      },
    });
    const loading = startHistory(host);
    const sending = handleSendChat(host);
    try {
      if (action === "queued") {
        await vi.waitFor(() => expect(host.chatQueue).toHaveLength(1));
      } else if (action === "approve") {
        await vi.waitFor(() =>
          expect(findChatSendPayload(host)).toMatchObject({ sessionKey: host.sessionKey, message }),
        );
      } else {
        await sending;
      }
      expect(host.chatLoading).toBe(true);
      if (action === "abort") {
        expect(host.request).toHaveBeenCalledWith("sessions.abort", {
          key: host.sessionKey,
          clearQueued: true,
        });
      } else {
        expect(host.request).not.toHaveBeenCalledWith("sessions.abort", expect.anything());
      }
      if (action === "approve") {
        expectRequestCounts(host.request, { "chat.history": 0 });
      } else {
        expectRequestCounts(host.request, { "chat.send": 0 });
      }
      if (action === "queued") {
        expect(host.chatQueue).toEqual([
          expect.objectContaining({ text: message, sendAttempts: 0 }),
        ]);
        expect(host.chatMessage).toBe("");
      } else {
        expect(host.chatQueue).toEqual([]);
      }
      if (action === "blocked") {
        expect(host.chatMessage).toBe(message);
      }
    } finally {
      history.resolve({ messages: [] });
      await loading;
      await sending;
    }
  },
);

it.each(["replacement Gateway", "reconnected client", "offline pane"] as const)(
  "keeps early queued delivery scoped through a %s",
  async (change) => {
    const sessionKey = "agent:main:main";
    const accepted = { ...sessionHistory({ sessionId: "old-session" }), sessionId: "old-session" };
    const history = createDeferred<ChatHistoryResult>();
    let initial = true;
    const requestHandlers = {
      "chat.startup": () => (initial ? accepted : history.promise),
      "chat.history": accepted,
      "chat.send": { runId: "new-run", status: "started" },
    };
    const host = makeChatHost({
      sessionKey,
      chatMessage: "Keep this draft unsent",
      requestHandlers,
    });
    await startHistory(host);
    initial = false;
    const next =
      change === "replacement Gateway" ? makeChatHost({ sessionKey, requestHandlers }) : host;
    host.client = next.client;
    host.sessions = next.sessions;
    host.connectionEpoch += 1;
    if (change === "offline pane") {
      host.connected = false;
    }
    const loading = change === "offline pane" ? Promise.resolve() : startHistory(host);
    const sending = handleSendChat(host);
    await vi.waitFor(() => expect(host.chatMessage).toBe(""));
    expectRequestCounts(host.request, { "chat.send": 0 });
    expectRequestCounts(next.request, { "chat.send": 0 });
    history.resolve(accepted);
    await loading;
    await sending;
    if (change === "offline pane") {
      expectRequestCounts(host.request, { "chat.send": 0 });
      expect(host.chatQueue).toEqual([expect.objectContaining({ text: "Keep this draft unsent" })]);
      expect(host.chatMessage).toBe("");
    } else {
      expect(findChatSendPayload(next)).toMatchObject({
        message: "Keep this draft unsent",
        sessionId: "old-session",
      });
      if (next !== host) {
        expectRequestCounts(host.request, { "chat.send": 0 });
      }
    }
  },
);

it.each(["steer", "retry"] as const)(
  "holds queued %s without changing custody during initial history",
  async (action) => {
    const { history, host } = pendingHistoryHost({
      chatRunId: "current-run",
      requestHandlers: { "chat.send": { runId: "queued-send", status: "started" } },
    });
    const queued = enqueueChatMessage(host, "already queued", false);
    if (!queued) {
      throw new Error("Expected an admitted queue item");
    }
    const before = structuredClone(host.chatQueue);
    const loading = startHistory(host);
    try {
      await (action === "steer" ? steerQueuedChatMessage : retryQueuedChatMessage)(host, queued.id);
      expectRequestCounts(host.request, { "chat.send": 0 });
      expect(host.chatQueue).toEqual(before);
    } finally {
      history.resolve({ messages: [] });
      await loading;
    }
  },
);

it("accepts a restored transcript draft with an attachment before history and delivers to the authoritative session", async () => {
  const current = {
    ...sessionHistory({ activeLeafEntryId: "current-leaf" }),
    sessionId: "current-session",
  };
  const { history, host } = pendingHistoryHost({
    chatMessage: "Draft while restoring history",
    chatAttachments: [
      {
        id: "early-file",
        mimeType: "text/plain",
        fileName: "note.txt",
        dataUrl: "data:text/plain;base64,aGVsbG8=",
      },
    ],
    requestHandlers: {
      "chat.history": current,
      "chat.send": { status: "started" },
    },
  });
  applyChatCacheSnapshot(host, cachedTranscript("restored-session", "restored-leaf"));
  const loading = startHistory(host);
  const sending = handleSendChat(host);
  try {
    await vi.waitFor(() => expect(host.chatMessage).toBe(""));
    expect(host.currentSessionId).toBe("restored-session");
    expect(host.chatQueue).toEqual([
      expect.objectContaining({ text: "Draft while restoring history", sendAttempts: 0 }),
    ]);
    expectRequestCounts(host.request, { "chat.send": 0, "chat.history": 0 });
    expect(host.chatAttachments).toEqual([]);
    host.chatMessage = "Next draft";
  } finally {
    history.resolve(current);
    await loading;
    await sending;
  }
  expect(findChatSendPayload(host)).toMatchObject({
    message: "Draft while restoring history",
    sessionId: "current-session",
    expectedLeafEntryId: "current-leaf",
  });
  expect(host.chatMessage).toBe("Next draft");
  expectRequestCounts(host.request, { "chat.send": 1 });
  expect(findChatSendPayload(host).attachments).toEqual([
    expect.objectContaining({
      content: "aGVsbG8=",
      fileName: "note.txt",
      mimeType: "text/plain",
    }),
  ]);
});

it.each(["original-leaf", null])(
  "preserves the submitted leaf fence %s when history starts after outbox admission",
  async (expectedLeafEntryId) => {
    const sessionKey = "agent:main:main";
    const history = createDeferred<ChatHistoryResult>();
    const host = makeChatHost({
      sessionKey,
      currentSessionId: "current-session",
      chatDisplayedLeafEntryId: expectedLeafEntryId,
      chatMessage: "Send against the branch I selected",
      requestHandlers: {
        "chat.history": () => history.promise,
        "chat.send": { status: "started", messageSeq: 1 },
      },
    });
    let loading: ReturnType<typeof loadChatHistory> | undefined;
    const sending = handleSendChat(host, undefined, {
      onOutboxAdmitted: () => {
        loading = loadChatHistory(host, { deferBranches: true });
      },
    });
    try {
      await vi.waitFor(() => expect(host.chatLoading).toBe(true));
      expect(host.chatMessage).toBe("");
      expect(host.chatQueue).toHaveLength(1);
      expectRequestCounts(host.request, { "chat.send": 0 });
    } finally {
      history.resolve(
        sessionHistory({
          key: sessionKey,
          activeLeafEntryId: "different-branch-leaf",
          updatedAt: 2,
        }),
      );
      await loading;
      await sending;
    }

    expect(host.chatDisplayedLeafEntryId).toBe("different-branch-leaf");
    expect(findChatSendPayload(host)).toHaveProperty("expectedLeafEntryId", expectedLeafEntryId);
    expectRequestCounts(host.request, { "chat.send": 1 });
  },
);

it.each(["connection", "conversation"] as const)(
  "does not deliver stale queued work after a %s change during history",
  async (change) => {
    const { history, host } = pendingHistoryHost({
      chatMessage: "Queued before history",
      requestHandlers: { "chat.send": { status: "started" } },
    });
    const loading = startHistory(host);
    const sending = handleSendChat(host);
    try {
      await vi.waitFor(() => expect(host.chatQueue).toHaveLength(1));
      if (change === "connection") {
        host.connectionEpoch += 1;
      } else {
        host.sessionKey = "agent:main:another-conversation";
      }
    } finally {
      history.resolve({ messages: [], sessionId: "old-session" });
      await loading;
      await sending;
    }
    expectRequestCounts(host.request, { "chat.send": 0 });
    expect(host.chatMessage).toBe("");
  },
);

it.each([false, true])(
  "delivers the next early message after discarding the first during history (switch pane: %s)",
  async (switchPane) => {
    const sessionKey = "agent:main:main";
    const current = sessionHistory({
      activeLeafEntryId: "current-leaf",
      hasActiveRun: false,
      status: "done",
    });
    const { history, host } = pendingHistoryHost({
      sessionKey,
      chatMessage: "Discard this first message",
      requestHandlers: {
        "chat.history": current,
      },
    });
    applyChatCacheSnapshot(host, cachedTranscript("cached-session", "cached-leaf"));
    const loading = startHistory(host);
    const sending = [handleSendChat(host)];
    try {
      await vi.waitFor(() => expect(host.chatQueue).toHaveLength(1));
      const firstId = host.chatQueue[0]!.id;
      host.chatMessage = "Keep this second message";
      sending.push(handleSendChat(host));
      await vi.waitFor(() => expect(host.chatQueue).toHaveLength(2));
      chatOutboxOwner(host).remove(host, firstId);
      expect(host.chatQueue).toEqual([
        expect.objectContaining({ text: "Keep this second message", sendAttempts: 0 }),
      ]);
      expect(host.chatMessage).toBe("");
      expectRequestCounts(host.request, { "chat.send": 0 });
      if (switchPane) {
        host.sessionKey = "agent:main:other";
        host.currentSessionId = "other-session";
        host.chatDisplayedLeafEntryId = "other-leaf";
      }
    } finally {
      history.resolve(current);
      await loading;
      await Promise.all(sending);
    }

    expectRequestCounts(host.request, { "chat.send": 1 });
    const payload = findChatSendPayload(host);
    expect(payload).toMatchObject({
      sessionKey,
      message: "Keep this second message",
      sessionId: "current-session",
    });
    if (switchPane) {
      expect(requestCalls(host.request, "chat.history")[0]?.[1]).toMatchObject({ sessionKey });
    }
    expect(payload).not.toHaveProperty("expectedLeafEntryId", "cached-leaf");
    expect(host.chatQueue).toEqual([]);
  },
);

it.each(["steer", "interrupt", "queue"] as const)(
  "preserves the selected %s policy when initial history reveals an active run",
  async (followUpMode) => {
    const sessionKey = "agent:main:main";
    const message = "Apply my selected follow-up mode";
    const { history, host } = pendingHistoryHost({
      sessionKey,
      chatMessage: message,
      sessionsResult: sessionListResult(1, [sessionRow({ hasActiveRun: false, status: "done" })]),
    });
    applyChatCacheSnapshot(host, cachedTranscript("current-session", "cached-leaf"));
    const loading = startHistory(host);
    const sending = handleSendChat(host, undefined, { followUpMode });
    try {
      await vi.waitFor(() => expect(host.chatQueue).toHaveLength(1));
      expect(host.chatMessage).toBe("");
      expect(host.chatQueue[0]).toMatchObject({ text: message, sendAttempts: 0 });
      expectRequestCounts(host.request, { "chat.send": 0 });
    } finally {
      history.resolve({
        ...sessionHistory({
          activeLeafEntryId: "active-leaf",
          activeRunIds: ["active-run"],
          hasActiveRun: true,
          status: "running",
          updatedAt: 2,
        }),
        inFlightRun: { runId: "active-run", text: "Work started after the cached snapshot" },
      });
      await loading;
      await sending;
    }

    if (followUpMode === "queue") {
      expectRequestCounts(host.request, { "chat.send": 0 });
      expect(host.chatQueue).toEqual([
        expect.objectContaining({ text: message, sendAttempts: 0, sendState: "waiting-idle" }),
      ]);
    } else {
      expect(findChatSendPayload(host)).toMatchObject({
        sessionKey,
        message,
        queueMode: followUpMode,
      });
      expectRequestCounts(host.request, { "chat.send": 1 });
      expect(host.chatQueue).toEqual([]);
    }
  },
);

it("resumes an early interrupt message for its captured session after switching panes", async () => {
  const queueMode = "interrupt";
  const sessionKey = "agent:work:research";
  const message = "Continue the selected work";
  const { history, host } = pendingHistoryHost({
    sessionKey,
    currentSessionId: "cached-source-session",
    chatDisplayedLeafEntryId: "cached-source-leaf",
    chatRunId: "cached-source-run",
    chatFollowUpMode: queueMode,
    chatMessage: message,
  });
  const loading = startHistory(host);
  const sending = handleSendChat(host);
  try {
    await vi.waitFor(() => expect(host.chatQueue).toHaveLength(1));
    expect(host.chatMessage).toBe("");
    expect(host.chatQueue[0]).toMatchObject({ sessionKey, queueMode, sendAttempts: 0 });
    expectRequestCounts(host.request, { "chat.send": 0 });
    host.sessionKey = "agent:main:another-conversation";
    host.currentSessionId = "new-pane-session";
    host.chatDisplayedLeafEntryId = "new-pane-leaf";
    host.chatRunId = null;
  } finally {
    history.resolve({ messages: [], sessionId: "source-session" });
    await loading;
    await sending;
  }
  expectRequestCounts(host.request, { "chat.send": 0 });

  await resumeStoredChatOutboxes(host);

  const payload = findChatSendPayload(host);
  expect(payload).toMatchObject({ sessionKey, queueMode, message });
  expect(payload).not.toHaveProperty("sessionId");
  expect(payload).not.toHaveProperty("expectedLeafEntryId");
  expect(payload).not.toHaveProperty("expectedRunId");
  expect(host.currentSessionId).toBe("new-pane-session");
  expectRequestCounts(host.request, { "chat.send": 1 });
});
