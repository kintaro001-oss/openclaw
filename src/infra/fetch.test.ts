import { describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { resolveFetch, wrapFetchWithAbortSignal } from "./fetch.js";

async function waitForMicrotaskTurn(): Promise<void> {
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
}

function createForeignSignalHarness() {
  let abortHandler: (() => void) | null = null;
  const removeEventListener = vi.fn((event: string, handler: () => void) => {
    if (event === "abort" && abortHandler === handler) {
      abortHandler = null;
    }
  });

  const fakeSignal = {
    aborted: false,
    addEventListener: (event: string, handler: () => void) => {
      if (event === "abort") {
        abortHandler = handler;
      }
    },
    removeEventListener,
  } as unknown as AbortSignal;

  return {
    fakeSignal,
    removeEventListener,
    triggerAbort: () => abortHandler?.(),
  };
}

function createThrowingCleanupSignalHarness(cleanupError: Error) {
  const removeEventListener = vi.fn(() => {
    throw cleanupError;
  });
  const fakeSignal = {
    aborted: false,
    addEventListener: (_eventValue: string, _handler: () => void) => {},
    removeEventListener,
  } as unknown as AbortSignal;
  return { fakeSignal, removeEventListener };
}

function createSeenInitFetch() {
  let seenInit: RequestInit | undefined;
  const fetchImpl = withFetchPreconnect(
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenInit = init;
      return {} as Response;
    }),
  );
  return { fetchImpl, wrapped: wrapFetchWithAbortSignal(fetchImpl), getSeenInit: () => seenInit };
}

function createSymbolHeaderInit(enumerable: boolean): RequestInit {
  const headers = { "Content-Type": "application/json" } as Record<string, string> & {
    [key: symbol]: unknown;
  };
  Object.defineProperty(headers, Symbol("sensitiveHeaders"), {
    value: new Set(["content-type"]),
    enumerable,
  });
  return { headers };
}

describe("wrapFetchWithAbortSignal", () => {
  it.each([
    { name: "init body", input: "https://example.com", init: { method: "POST", body: "hi" } },
    {
      name: "Request body",
      input: new Request("https://example.com", { method: "POST", body: "hi" }),
      init: undefined,
    },
    {
      name: "existing duplex",
      input: "https://example.com",
      init: { method: "POST", body: "hi", duplex: "half" },
    },
  ])("sets or preserves duplex for $name", async ({ input, init }) => {
    const { wrapped, getSeenInit } = createSeenInitFetch();
    await wrapped(input, init);
    expect(getSeenInit()).toMatchObject({ duplex: "half" });
  });

  it("converts foreign abort signals to native controllers", async () => {
    const { fetchImpl, wrapped, getSeenInit } = createSeenInitFetch();

    const { fakeSignal, triggerAbort } = createForeignSignalHarness();

    const promise = wrapped("https://example.com", { signal: fakeSignal });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const seenSignal = getSeenInit()?.signal;
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal).not.toBe(fakeSignal);

    triggerAbort();
    expect(seenSignal?.aborted).toBe(true);

    await promise;
  });

  it("does not emit an extra unhandled rejection when wrapped fetch rejects", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    const fetchError = new TypeError("fetch failed");
    const fetchImpl = withFetchPreconnect(
      vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.reject(fetchError)),
    );
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    const { fakeSignal, removeEventListener } = createForeignSignalHarness();

    try {
      await expect(wrapped("https://example.com", { signal: fakeSignal })).rejects.toBe(fetchError);
      await Promise.resolve();
      await waitForMicrotaskTurn();

      expect(unhandled).toStrictEqual([]);
      expect(removeEventListener).toHaveBeenCalledOnce();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it.each([
    { sync: false, cleanupThrows: true },
    { sync: true, cleanupThrows: false },
    { sync: true, cleanupThrows: true },
  ])(
    "preserves fetch failure (sync: $sync, cleanup throws: $cleanupThrows)",
    async ({ sync, cleanupThrows }) => {
      const failure = new TypeError("fetch failed");
      const { fakeSignal, removeEventListener } = cleanupThrows
        ? createThrowingCleanupSignalHarness(new TypeError("cleanup failed"))
        : createForeignSignalHarness();
      const wrapped = wrapFetchWithAbortSignal(
        withFetchPreconnect(
          vi.fn(() => {
            if (sync) {
              throw failure;
            }
            return Promise.reject(failure);
          }),
        ),
      );
      if (sync) {
        expect(() => wrapped("https://example.com", { signal: fakeSignal })).toThrow(failure);
      } else {
        await expect(wrapped("https://example.com", { signal: fakeSignal })).rejects.toBe(failure);
      }
      expect(removeEventListener).toHaveBeenCalledOnce();
    },
  );

  it("skips listener cleanup when foreign signal is already aborted", async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const fetchImpl = withFetchPreconnect(vi.fn(async () => ({ ok: true }) as Response));
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    const fakeSignal = {
      aborted: true,
      addEventListener,
      removeEventListener,
    } as unknown as AbortSignal;

    await wrapped("https://example.com", { signal: fakeSignal });

    expect(addEventListener).not.toHaveBeenCalled();
    expect(removeEventListener).not.toHaveBeenCalled();
  });

  it("passes through foreign signal-like objects without addEventListener", async () => {
    const { wrapped, getSeenInit } = createSeenInitFetch();

    const fakeSignal = {
      aborted: false,
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    await wrapped("https://example.com", { signal: fakeSignal });

    expect(getSeenInit()?.signal).toBe(fakeSignal);
  });

  it("passes through native AbortSignal instances unchanged", async () => {
    const { wrapped, getSeenInit } = createSeenInitFetch();
    const controller = new AbortController();

    await wrapped("https://example.com", { signal: controller.signal });

    expect(getSeenInit()?.signal).toBe(controller.signal);
  });

  it("passes through foreign signals unchanged when AbortController is unavailable", async () => {
    const { wrapped, getSeenInit } = createSeenInitFetch();
    const fakeSignal = {
      aborted: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const previousAbortController = globalThis.AbortController;
    vi.stubGlobal("AbortController", undefined);

    try {
      await wrapped("https://example.com", { signal: fakeSignal });
    } finally {
      vi.stubGlobal("AbortController", previousAbortController);
    }

    expect(getSeenInit()?.signal).toBe(fakeSignal);
  });

  it("returns the same function when called with an already wrapped fetch", () => {
    const fetchImpl = withFetchPreconnect(vi.fn(async () => ({ ok: true }) as Response));
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    expect(wrapFetchWithAbortSignal(wrapped)).toBe(wrapped);
    expect(resolveFetch(wrapped)).toBe(wrapped);
  });

  it("keeps preconnect bound to the original fetch implementation", () => {
    const preconnectSpy = vi.fn(function (this: unknown) {
      return this;
    });
    const fetchImpl = vi.fn(async () => ({ ok: true }) as Response) as unknown as typeof fetch & {
      preconnect: (url: string, init?: { credentials?: RequestCredentials }) => unknown;
    };
    fetchImpl.preconnect = preconnectSpy;

    const wrapped = wrapFetchWithAbortSignal(fetchImpl) as typeof fetch & {
      preconnect: (url: string, init?: { credentials?: RequestCredentials }) => unknown;
    };

    const seenThis = wrapped.preconnect("https://example.com");

    expect(preconnectSpy).toHaveBeenCalledOnce();
    expect(seenThis).toBe(fetchImpl);
  });

  it.each([
    { enumerable: true, name: "enumerable" },
    { enumerable: false, name: "non-enumerable" },
  ])(
    "drops $name header symbol metadata before calling the wrapped fetch",
    async ({ enumerable }) => {
      const { fetchImpl, getSeenInit } = createSeenInitFetch();
      const wrapped = wrapFetchWithAbortSignal(fetchImpl);
      const init = createSymbolHeaderInit(enumerable);

      await wrapped("https://example.com", init);

      const seenHeaders = getSeenInit()?.headers;
      expect(seenHeaders).not.toBe(init.headers);
      expect(Object.getOwnPropertySymbols(seenHeaders as object)).toStrictEqual([]);
      expect(new Headers(seenHeaders).get("content-type")).toBe("application/json");
      expect(Object.getOwnPropertySymbols(init.headers as object)).toHaveLength(1);
    },
  );
});

describe("resolveFetch", () => {
  it("returns undefined when neither an explicit nor global fetch exists", () => {
    const previousFetch = globalThis.fetch;
    vi.stubGlobal("fetch", undefined);
    try {
      expect(resolveFetch(undefined)).toBeUndefined();
    } finally {
      vi.stubGlobal("fetch", previousFetch);
    }
  });
});
