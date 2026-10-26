import { createServer } from "node:http";
import { promisify } from "node:util";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RealtimeVoiceResponseOutcome } from "openclaw/plugin-sdk/realtime-voice";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { assert, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { listenOnLoopback } from "../test-support/hanging-loopback-server.js";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";
const responseId = "response_1";
const send = (ws: WebSocket, event: Record<string, unknown>) => ws.send(JSON.stringify(event));
const done = (response: Record<string, unknown>, id = responseId) => ({
  type: "response.done",
  response: { id, ...response },
});
async function capture(
  terminalEvent: Record<string, unknown>,
  mode: "queued" | "tools" | "throw" = "queued",
) {
  let responseCreates = 0;
  const errors: string[] = [];
  const events: string[] = [];
  const outcomes: RealtimeVoiceResponseOutcome[] = [];
  const responseCreated = createDeferred<void>();
  const finished = createDeferred<void>();
  const server = createServer();
  const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });
  wss.on("connection", (ws) => {
    let messageCount = 0;
    ws.on("message", (message) => {
      const { type } = JSON.parse(String(message)) as { type: string };
      if (++messageCount === 1 && type === "session.update") {
        send(ws, { type: "session.updated" });
      }
      if (type !== "response.create") {
        return;
      }
      responseCreates++;
      if (mode === "queued") {
        finished.resolve();
      } else if (mode === "throw") {
        send(ws, { type: "response.created", response: { id: "response_2" } });
        send(ws, done({ status: "completed", output: [] }, "response_2"));
      }
    });
  });
  const port = await listenOnLoopback(server);
  const bridge = buildOpenAIRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "fixture-value", azureEndpoint: `http://127.0.0.1:${port}` },
    onAudio() {},
    onClearAudio() {},
    onError: (error) => errors.push(error.message),
    onResponseDone: (result) => {
      outcomes.push(result);
      events.push(`outcome:${result.status}`);
      if (result.responseId === "response_2") {
        finished.resolve();
      }
      if (mode === "throw" && result.responseId === "response_1") {
        throw new Error("consumer callback failed");
      }
    },
    onToolCall: ({ callId }) => events.push(`tool:${callId}`),
    onEvent: (event) => {
      events.push(`${event.direction}:${event.type}`);
      if (event.direction === "server" && event.type === "response.created") {
        responseCreated.resolve();
      }
      if (mode === "tools" && event.direction === "server" && event.type === terminalEvent.type) {
        queueMicrotask(finished.resolve);
      }
    },
  });
  try {
    await bridge.connect();
    const socket = [...wss.clients][0];
    assert(socket, "expected a connected fixture socket");
    send(socket, { type: "response.created", response: { id: responseId } });
    await withTimeout(responseCreated.promise, 2_000);
    if (mode !== "tools") {
      bridge.sendUserMessage?.("Continue after the terminal response.");
    }
    send(socket, terminalEvent);
    await withTimeout(finished.promise, 2_000);
    return { responseCreates, errors, events, outcomes, connected: bridge.isConnected() };
  } finally {
    await bridge.close();
    for (const socket of wss.clients) {
      socket.terminate();
    }
    await promisify(wss.close.bind(wss))();
    await promisify(server.close.bind(server))();
  }
}
const completedTool = {
  type: "function_call",
  call_id: "call_tool",
  name: "lookup_weather",
  arguments: "{}",
};
const invalidStatus = (message: string) => ({
  status: "failed",
  reason: "invalid_response_status",
  error: { type: "invalid_response_status", message },
});
const rateLimit = { type: "server_error", code: "rate_limit_exceeded" };
const cancelled = { reason: "client_cancelled" };
const maxTokens = { reason: "max_output_tokens" };
it.each([
  ["completed", undefined, { status: "completed" }],
  ["cancelled", cancelled, { status: "cancelled", ...cancelled }],
  ["failed", { error: rateLimit }, { status: "failed", error: rateLimit }],
  ["incomplete", maxTokens, { status: "incomplete", ...maxTokens }],
  [undefined, undefined, invalidStatus("missing terminal status")],
  ["in_progress", undefined, invalidStatus("invalid status in_progress")],
] as const)(
  "normalizes %s without closing the reusable socket",
  async (status, status_details, expected) => {
    const { events, ...actual } = await capture(
      done({ status, status_details, output: [completedTool] }),
      status === "completed" ? "tools" : "queued",
    );
    expect(actual.errors).toEqual([]);
    expect(actual.outcomes).toMatchObject([{ responseId, ...expected }]);
    expect(actual.connected).toBe(true);
    expect(actual.responseCreates).toBe(status === "completed" ? 0 : 1);
    const terminal = events.filter((event) =>
      /^(tool:|outcome:|server:response\.done$)/.test(event),
    );
    expect(terminal).toEqual([
      ...(status === "completed" ? ["tool:call_tool"] : []),
      `outcome:${expected.status}`,
      "server:response.done",
    ]);
  },
);

it("drains a queued follow-up when the terminal consumer throws", async () => {
  const captured = await capture(done({ status: "failed", output: [] }), "throw");
  expect(captured.errors).toEqual([]);
  expect(captured.outcomes).toMatchObject([
    { responseId, status: "failed" },
    { responseId: "response_2", status: "completed" },
  ]);
  expect(captured.responseCreates).toBe(1);
  expect(captured.connected).toBe(true);
});
