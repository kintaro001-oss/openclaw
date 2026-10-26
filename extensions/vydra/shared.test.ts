import http from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { fetchWithRuntimeDispatcher } from "openclaw/plugin-sdk/runtime-fetch";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { listenOnLoopback } from "../test-support/hanging-loopback-server.js";
import { downloadVydraAsset, extractVydraResultUrls } from "./shared.js";

type DownloadOptions = Partial<Parameters<typeof downloadVydraAsset>[0]>;

describe("downloadVydraAsset", () => {
  installPinnedHostnameTestHooks();

  const requestPolicyFor = (url: string, allowPrivateNetwork = false) => ({
    allowPrivateNetwork,
    headers: new Headers(),
    headerOrigin: new URL(url).origin,
  });
  const download = (response: Response | typeof fetch, overrides: DownloadOptions = {}) => {
    vi.stubGlobal("fetch", vi.fn(typeof response === "function" ? response : async () => response));
    return downloadVydraAsset({
      url: `https://cdn.vydra.example/generated/test.${overrides.kind === "video" ? "mp4" : "png"}`,
      kind: "image",
      timeoutMs: 250,
      maxBytes: 1024 * 1024,
      requestPolicy: requestPolicyFor("https://cdn.vydra.example"),
      ...overrides,
    });
  };
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([200, 500])("times out dripping HTTP %i with a frozen clock", async (statusCode) => {
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const server = http.createServer((_req, res) => {
      res.on("error", () => {});
      res.writeHead(statusCode, {
        "Content-Type": statusCode === 200 ? "image/png" : "text/plain",
      });
      const drip = () => res.write(statusCode === 200 ? Buffer.from([0x00]) : "e");
      drip(); // Keep the chunk-idle timeout from firing.
      const dripTimer = setInterval(drip, 20);
      res.on("close", () => clearInterval(dripTimer));
    });
    onTestFinished(() => {
      server.closeAllConnections();
      return server[Symbol.asyncDispose]();
    });
    server.on("clientError", (_err, socket) => socket.destroy());
    const url = `http://127.0.0.1:${await listenOnLoopback(server)}`;
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const headersReceived = createDeferred<void>();
    const settled = vi.fn();
    const result = download(
      async (input, init) => {
        const response = await fetchWithRuntimeDispatcher(input, init);
        headersReceived.resolve();
        return response;
      },
      { url: `${url}/test.png`, requestPolicy: requestPolicyFor(url, true) },
    );
    void result.then(settled, settled);
    // Connection setup must finish before advancing the body deadline.
    await Promise.race([headersReceived.promise, result]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(249);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).rejects.toThrow("Vydra image download timed out after 250ms");
  });

  it.each([502, 200])("preserves body failures and clears timers (HTTP %i)", async (status) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const result = await download(
      new Response(
        new ReadableStream({
          start: (controller) => controller.error(new Error("broken body")),
        }),
        {
          status,
          ...(status === 502 ? { headers: { "x-request-id": "req" } } : {}),
        },
      ),
    ).catch((error: unknown) => error);
    expect(vi.getTimerCount()).toBe(0);
    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject(
      status === 502
        ? { name: "ProviderHttpError", status: 502, statusCode: 502, requestId: "req" }
        : { message: "broken body" },
    );
  });

  it("rejects an empty downloaded video", async () => {
    const response = new Response("", { headers: { "content-type": "video/mp4" } });
    await expect(download(response, { kind: "video" })).rejects.toThrow(
      "Vydra video download: malformed video response",
    );
  });

  it("keeps valid downloads alive beyond the binary reader's default idle timeout", async () => {
    vi.useFakeTimers();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          setTimeout(() => controller.close(), 31_000);
        },
      }),
      { headers: { "content-type": "video/mp4" } },
    );
    const result = download(response, { kind: "video", timeoutMs: 45_000 });
    const assertion = expect(result).resolves.toMatchObject({ buffer: Buffer.from([1, 2, 3]) });
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
  });
});

it("preserves URL priority, traversal bounds and independent result arrays", () => {
  const url = (name: string) => `https://cdn.example/${name}.png`;
  let data: Record<string, unknown> = {
    imageUrl: url("edge"),
    data: { imageUrl: url("too-deep") },
  };
  for (let depth = 1; depth < 5; depth++) {
    data = { data };
  }
  const payload = {
    audioUrl: "https://cdn.example/other.mp3",
    videoUrl: "https://cdn.example/other.mp4",
    imageUrls: [url("second"), [` ${url("first")} `]],
    imageUrl: ` \t${url("first")}\n`,
    url: url("shared"),
    resultUrl: url("result"),
    outputs: [{ imageUrl: url("second"), url: url("nested") }, [[{ imageUrl: url("array") }]]],
    data,
  };
  const expected = ["first", "second", "result", "shared", "nested", "array", "edge"].map(url);
  const urls = extractVydraResultUrls(payload, "image");
  expect(urls).toEqual(expected);
  urls.push(url("caller-owned"));
  expect(extractVydraResultUrls(payload, "image")).toEqual(expected);
});
