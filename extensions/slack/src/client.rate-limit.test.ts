import { setTimeout as delay } from "node:timers/promises";
import { WebClient, type WebClientOptions } from "@slack/web-api";
import { expect, it } from "vitest";
import { createSlackWriteClient, resolveSlackWriteClientOptions } from "./client.js";
import { appendSlackStream, startSlackStream, stopSlackStream } from "./streaming.js";

type StreamMethod = "chat.startStream" | "chat.appendStream" | "chat.stopStream";
type SlackFetch = NonNullable<WebClientOptions["fetch"]>;
const success = () => Response.json({ ok: true, ts: "1700000000.000100" });
const rateLimited = (retryAfter = "0", body: BodyInit = "rate limited") =>
  new Response(body, { status: 429, headers: { "retry-after": retryAfter } });
const write = (fetch: SlackFetch, opts: WebClientOptions = {}, assert?: () => void) => {
  const client = createSlackWriteClient("fixture", { fetch, ...opts }, assert);
  return client.apiCall("chat.postMessage", { channel: "CFIXTURE", text: "answer" });
};

function transport(reply = (_attempt: number) => rateLimited(), method = "chat.postMessage") {
  const requests = new Map<string, Array<RequestInit["body"]>>();
  const responses: Response[] = [];
  const fetch: SlackFetch = async (input, init) => {
    const current = new URL(input).pathname.split("/").at(-1) ?? "";
    const bodies = requests.get(current) ?? [];
    requests.set(current, bodies);
    bodies.push(init?.body);
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
  };
  const session = await startSlackStream({
    client: new WebClient("fixture", clientOptions),
    clientOptions,
    channel: "CFIXTURE",
    threadTs: "1700000000.000001",
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

it.each(["retry", "abort"] as const)("pending 429 cancellation: %s", async (action) => {
  const cleanup = Promise.withResolvers<void>();
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
  const { fetch, responses } = transport((attempt) =>
    attempt === 1 ? rateLimited(action === "abort" ? "60" : "0", body) : success(),
  );
  const operation = write(fetch, { timeout: action === "abort" ? 20 : 0 });
  const settled = operation.then(() => "delivered").catch(() => "aborted");
  const deadline = new AbortController();
  try {
    const outcome = await Promise.race([
      settled,
      delay(1_000, "stalled", { signal: deadline.signal }),
    ]);
    expect({ outcome, cancelled, attempts: responses.length }).toEqual({
      outcome: action === "retry" ? "delivered" : "aborted",
      cancelled: true,
      attempts: action === "retry" ? 2 : 1,
    });
  } finally {
    deadline.abort();
    bodyController.error(new Error("test cleanup"));
    cleanup.resolve();
    await settled;
  }
});
it.each([
  ["chat.startStream", false],
  ["chat.appendStream", false],
  ["chat.stopStream", false],
  ["chat.appendStream", true],
] as const)("retries %s (lost ack: %s)", async (method, lostAck) => {
  const body =
    method === "chat.startStream"
      ? new ReadableStream({
          start: (controller) => controller.error(new Error("broken response body")),
        })
      : "rate limited";
  const { fetch, requests } = transport((attempt) => {
    if (attempt === 1) {
      return rateLimited("0", body);
    }
    if (lostAck) {
      throw new Error("synthetic lost acknowledgment");
    }
    return success();
  }, method);
  const operation = runStreamOperation(method, fetch);
  if (lostAck) {
    await expect(operation).rejects.toThrow("synthetic lost acknowledgment");
    expect(requests.has("chat.stopStream")).toBe(false);
  } else {
    await expect(operation).resolves.toMatchObject({ delivered: true });
  }
  const attempts = requests.get(method) ?? [];
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toBe(attempts[1]);
});

it("revalidates direct-delivery authority before a refused write is retried", async () => {
  let authorized = true;
  const { fetch, responses } = transport(() => {
    authorized = false;
    return rateLimited();
  });
  const operation = write(fetch, {}, () => {
    if (!authorized) {
      throw new Error("direct delivery is no longer active");
    }
  });

  await expect(operation).rejects.toThrow("direct delivery is no longer active");
  expect(responses).toHaveLength(1);
});
it.each([
  ["2147001", 1],
  ["0", 3],
] as const)("bounds reused retries: %s", async (retryAfter, count) => {
  const { fetch, responses } = transport(() => rateLimited(retryAfter));
  await expect(write(fetch, resolveSlackWriteClientOptions({ fetch }))).rejects.toThrow();
  expect(responses).toHaveLength(count);
  expect(responses.every((response) => response.bodyUsed)).toBe(true);
});
