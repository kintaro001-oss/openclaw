import { WebClient, type WebClientOptions } from "@slack/web-api";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { createSlackWriteClient, resolveSlackWriteClientOptions } from "./client.js";
import { appendSlackStream, startSlackStream, stopSlackStream } from "./streaming.js";

type StreamMethod = "chat.startStream" | "chat.appendStream" | "chat.stopStream";
type SlackFetch = NonNullable<WebClientOptions["fetch"]>;
const STREAM_TS = "1700000000.000100";
const success = () => Response.json({ ok: true, ts: STREAM_TS });
const rateLimited = (retryAfter = "0", body: BodyInit = "rate limited") =>
  new Response(body, { status: 429, headers: { "retry-after": retryAfter } });
const send = (client: WebClient, text = "answer") =>
  client.apiCall("chat.postMessage", { channel: "CFIXTURE", text });

function transport(reply = (_attempt: number) => rateLimited(), method = "chat.postMessage") {
  const requests = new Map<string, string[]>();
  const responses: Response[] = [];
  const fetch: SlackFetch = async (input, init) => {
    const current = new URL(input).pathname.split("/").at(-1) ?? "";
    if (typeof init?.body !== "string") {
      throw new Error("Expected Slack's URL-encoded request");
    }
    const bodies = requests.get(current) ?? [];
    requests.set(current, bodies);
    bodies.push(init.body);
    const response = current === method ? reply(bodies.length) : success();
    responses.push(response);
    return response;
  };
  return { fetch, requests, responses };
}

async function runStreamOperation(method: StreamMethod, fetch: SlackFetch) {
  const clientOptions: WebClientOptions = {
    fetch,
    slackApiUrl: "https://synthetic.slack.invalid/api/",
    retryConfig: { retries: 2, minTimeout: 1, maxTimeout: 1 },
    teamId: "TFIXTURE",
  };
  const client = new WebClient("synthetic-rate-limit-fixture", clientOptions);
  const session = await startSlackStream({
    client,
    clientOptions,
    channel: "CFIXTURE",
    threadTs: "1700000000.000001",
    teamId: "TRECIPIENT",
    userId: "UFIXTURE",
    text: method === "chat.startStream" ? "answer" : "prefix",
    chunks: [],
  });
  if (method !== "chat.startStream") {
    await appendSlackStream({
      session,
      text: "answer",
      ...(method === "chat.appendStream" ? { chunks: [] } : {}),
    });
  }
  await stopSlackStream({ session });
  return session;
}

describe("Slack explicit rate-limit recovery", () => {
  it.each(["retry", "abort"] as const)(
    "allows %s while a discarded 429 body and its cancellation remain pending",
    async (action) => {
      const cleanup = createDeferred<void>();
      let bodyController!: ReadableStreamDefaultController;
      let cancelled = false;
      const body = new ReadableStream({
        start(controller) {
          bodyController = controller;
        },
        cancel() {
          cancelled = true;
          return cleanup.promise;
        },
      });
      const { fetch, responses } = transport(
        (attempt) =>
          attempt === 1 ? rateLimited(action === "abort" ? "60" : "0", body) : success(),
        action === "retry" ? "chat.startStream" : "chat.postMessage",
      );
      const operation =
        action === "retry"
          ? runStreamOperation("chat.startStream", fetch)
          : send(createSlackWriteClient("stalled-cancel", { fetch, timeout: 20 }));
      const settled = operation.then(
        () => "delivered",
        () => "aborted",
      );
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcome = await Promise.race([
          settled,
          new Promise<string>((resolve) => {
            deadline = setTimeout(() => resolve("stalled"), 1_000);
          }),
        ]);
        expect({ outcome, cancelled, attempts: responses.length }).toEqual({
          outcome: action === "retry" ? "delivered" : "aborted",
          cancelled: true,
          attempts: action === "retry" ? 3 : 1,
        });
      } finally {
        clearTimeout(deadline);
        bodyController.error(new Error("test cleanup"));
        cleanup.resolve();
        await settled;
      }
    },
  );
  it.each(["chat.startStream", "chat.appendStream", "chat.stopStream"] as const)(
    "retries rejected %s with identical bodies, including a broken start response",
    async (method) => {
      const brokenBody = method === "chat.startStream";
      const body = brokenBody
        ? new ReadableStream({
            start(controller) {
              controller.error(new Error("rejected response body interrupted"));
            },
          })
        : JSON.stringify({ ok: false, error: "ratelimited" });
      const { fetch, requests } = transport(
        (attempt) => (attempt === 1 ? rateLimited("0", body) : success()),
        method,
      );
      const session = await runStreamOperation(method, fetch);
      const attempts = requests.get(method) ?? [];
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toBe(attempts[1]);
      const params = new URLSearchParams(attempts[1]);
      if (!brokenBody) {
        expect(params.get("team_id")).toBe("TFIXTURE");
        expect(JSON.parse(params.get("chunks") ?? "[]")).toEqual([
          { type: "markdown_text", text: "answer" },
        ]);
      }
      expect(session).toMatchObject({ stopped: true, delivered: true, pendingText: "" });
    },
  );

  it("does not replay an ambiguous socket response after an explicit rate-limit retry", async () => {
    const { fetch, requests } = transport((attempt) => {
      if (attempt === 1) {
        return rateLimited();
      }
      throw new Error("synthetic lost acknowledgment");
    }, "chat.appendStream");
    await expect(runStreamOperation("chat.appendStream", fetch)).rejects.toThrow();
    expect(requests.get("chat.appendStream")).toHaveLength(2);
    expect(requests.has("chat.stopStream")).toBe(false);
  });

  it("revalidates direct-delivery authority before a refused write is retried", async () => {
    let authorized = true;
    const { fetch, responses } = transport(() => {
      authorized = false;
      return rateLimited();
    });
    const client = createSlackWriteClient("synthetic-live-authority-fixture", { fetch }, () => {
      if (!authorized) {
        throw new Error("direct delivery is no longer active");
      }
    });

    await expect(send(client)).rejects.toThrow("direct delivery is no longer active");
    expect(responses).toHaveLength(1);
  });

  it("bounds rate-limit recovery for 2147001 to one request", async () => {
    const { fetch, responses } = transport(() => rateLimited("2147001"));
    const client = createSlackWriteClient("synthetic-budget-fixture", { fetch });
    await expect(send(client)).rejects.toThrow();
    expect(responses).toHaveLength(1);
    expect(responses.every((response) => response.bodyUsed)).toBe(true);
  });

  it("does not multiply the retry budget when pre-resolved options are reused", async () => {
    const { fetch, responses } = transport();
    const options = resolveSlackWriteClientOptions({ fetch });
    const client = createSlackWriteClient("synthetic-reused-fixture", options);
    await expect(send(client)).rejects.toThrow();
    expect(responses).toHaveLength(3);
  });
});
