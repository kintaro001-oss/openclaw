import { jsonResponse } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  ssrfPolicyFromHttpBaseUrlAllowedHostname: (baseUrl: string) => ({
    allowedHostnames: [new URL(baseUrl).hostname],
  }),
}));

import { buildKilocodeProvider, buildKilocodeProviderWithDiscovery } from "./api.js";
import {
  discoverKilocodeModels,
  KILOCODE_DEFAULT_COST,
  KILOCODE_MODELS_URL,
} from "./provider-models.js";

function modelById(models: Awaited<ReturnType<typeof discoverKilocodeModels>>, id: string) {
  return models.find((model) => model.id === id) ?? expect.fail(`missing model ${id}`);
}

const requireRecord = createRequireRecord("record", "expected-label-record");

function pricing(prompt: string, completion: string, cacheRead?: string, cacheWrite?: string) {
  return { prompt, completion, input_cache_read: cacheRead, input_cache_write: cacheWrite };
}

function cost<T>(input: T, output: T, cacheRead: T, cacheWrite: T) {
  return { input, output, cacheRead, cacheWrite };
}

function makeGatewayModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "anthropic/claude-sonnet-4",
    name: "Anthropic: Claude Sonnet 4",
    context_length: 200000,
    architecture: { input_modalities: ["text", "image"] },
    top_provider: { max_completion_tokens: 8192 },
    pricing: pricing("0.000003", "0.000015", "0.0000003", "0.00000375"),
    supported_parameters: ["reasoning"],
    ...overrides,
  };
}

const autoModel = makeGatewayModel({
  id: "kilo-auto/balanced",
  name: "Auto Balanced",
  pricing: pricing("0.000000325", "0.00000195", "0.0000000325", "0.00000040625"),
});

function stubResponse(response: Response) {
  fetchWithSsrFGuardMock.mockResolvedValue({ response, release: vi.fn(async () => {}) });
}

function discoverModels(data: unknown[]) {
  stubResponse(jsonResponse({ data }));
  return discoverKilocodeModels();
}

afterEach(() => fetchWithSsrFGuardMock.mockReset());
afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

it("preserves the public advisory builder for HTTP 200 with no rows", async () => {
  stubResponse(jsonResponse({ data: [] }));
  await expect(buildKilocodeProviderWithDiscovery()).resolves.toEqual(buildKilocodeProvider());
});

it("parses gateway models with correct pricing conversion", async () => {
  const models = await discoverModels([autoModel, makeGatewayModel()]);

  expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
  const guardedFetch = requireRecord(fetchWithSsrFGuardMock.mock.calls[0]?.[0], "fetch params");
  expect(guardedFetch).toMatchObject({
    url: KILOCODE_MODELS_URL,
    auditContext: "kilocode.model_discovery",
  });
  expect(guardedFetch.policy).toEqual({ allowedHostnames: ["api.kilo.ai"] });
  const guardedInit = requireRecord(guardedFetch.init, "guarded fetch init");
  expect(Object.fromEntries(new Headers(guardedInit.headers as HeadersInit))).toEqual({
    accept: "application/json",
  });
  expect(guardedFetch.timeoutMs).toBeGreaterThan(0);
  expect(guardedFetch.timeoutMs).toBeLessThanOrEqual(5000);
  expect(models).toHaveLength(2);

  expect(modelById(models, "anthropic/claude-sonnet-4")).toMatchObject({
    cost: cost(expect.closeTo(3), expect.closeTo(15), expect.closeTo(0.3), expect.closeTo(3.75)),
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 8192,
  });
});

it("preserves known default-model pricing for unknown routing rates with valid cache prices", async () => {
  const models = await discoverModels([
    { ...autoModel, pricing: pricing("unavailable", "-1", "0.0000003", "0.00000375") },
    makeGatewayModel({ id: "kilo-auto/frontier", pricing: pricing("-1", "-1") }),
    makeGatewayModel({ id: "kilo-auto/free", pricing: pricing("0", "0", "0", "0") }),
  ]);
  expect(modelById(models, "kilo-auto/balanced").cost).toEqual({
    ...KILOCODE_DEFAULT_COST,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  });
  for (const id of ["kilo-auto/frontier", "kilo-auto/free"]) {
    expect(modelById(models, id).cost).toEqual(cost(0, 0, 0, 0));
  }
});

it("rejects malformed model list envelopes", async () => {
  for (const payload of [[], { data: {} }]) {
    stubResponse(jsonResponse(payload));
    await expect(discoverKilocodeModels({ discoveryMode: "strict" })).rejects.toThrow(
      "Kilocode model list: malformed JSON response",
    );
  }
});

it("does not restore seed models when no usable live rows remain", async () => {
  stubResponse(jsonResponse({ data: [null] }));
  await expect(discoverKilocodeModels({ discoveryMode: "strict" })).resolves.toEqual([]);
});

it.each([
  [-1, { max_completion_tokens: 8192.5 }, 1000000, 65536],
  [Number.POSITIVE_INFINITY, { max_completion_tokens: 0 }, 1000000, 65536],
  [1048576, { context_length: 524288, max_completion_tokens: 512000 }, 524288, 512000],
])(
  "resolves catalog window %s and provider limits %j to %s/%s",
  async (context_length, top_provider, contextWindow, maxTokens) => {
    const models = await discoverModels([makeGatewayModel({ context_length, top_provider })]);
    expect(modelById(models, "anthropic/claude-sonnet-4")).toMatchObject({
      contextWindow,
      maxTokens,
    });
  },
);

it("detects text-only models without image modality", async () => {
  const models = await discoverModels([
    makeGatewayModel({ architecture: { input_modalities: ["text"] }, supported_parameters: [] }),
  ]);
  expect(modelById(models, "anthropic/claude-sonnet-4")).toMatchObject({
    input: ["text"],
    reasoning: false,
  });
});

it("excludes image-output models while retaining chat and static routing entries", async () => {
  const models = await discoverModels([
    makeGatewayModel({
      id: "google/gemini-3.1-flash-image",
      architecture: { output_modalities: ["image", "text"] },
    }),
    makeGatewayModel(),
  ]);
  expect(models.map((model) => model.id)).toEqual([
    "kilo-auto/balanced",
    "anthropic/claude-sonnet-4",
  ]);
});

it("keeps a later valid duplicate when an earlier entry is malformed", async () => {
  const models = await discoverModels([
    { ...autoModel, name: "Broken Auto Balanced", pricing: undefined },
    autoModel,
    makeGatewayModel(),
  ]);
  expect(modelById(models, "kilo-auto/balanced")).toMatchObject({
    name: "Auto Balanced",
    cost: { input: expect.closeTo(0.325) },
  });
  expect(modelById(models, "anthropic/claude-sonnet-4").id).toBe("anthropic/claude-sonnet-4");
});
