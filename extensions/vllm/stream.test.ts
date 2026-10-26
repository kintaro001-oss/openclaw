import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { createVllmQwenThinkingWrapper, wrapVllmProviderStream } from "./stream.js";

const makeModel = (overrides: Partial<Model<"openai-completions">> = {}) =>
  ({
    api: "openai-completions",
    provider: "vllm",
    id: "nemotron-3-super",
    reasoning: true,
    ...overrides,
  }) as Model<"openai-completions">;
type PayloadCase = {
  format?: "chat-template" | "top-level";
  thinkingLevel?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
  initialPayload?: Record<string, unknown>;
  contextModelId?: string;
  model?: Partial<Model<"openai-completions">>;
  reasoning?: NonNullable<Parameters<StreamFn>[2]>["reasoning"];
};
function expectPayload(params: PayloadCase, expected: Record<string, unknown>, template = true) {
  let captured: Record<string, unknown> | undefined;
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    const payload = { ...params.initialPayload };
    options?.onPayload?.(payload, _model);
    captured = payload;
    return {} as ReturnType<StreamFn>;
  };

  const model = makeModel({ ...(params.format ? { id: "Qwen/Qwen3-8B" } : {}), ...params.model });
  const thinkingLevel = params.thinkingLevel ?? "high";
  const wrapped = params.format
    ? createVllmQwenThinkingWrapper({ baseStreamFn, format: params.format, thinkingLevel })
    : wrapVllmProviderStream({
        provider: "vllm",
        modelId: params.contextModelId ?? model.id,
        model,
        thinkingLevel,
        streamFn: baseStreamFn,
      } as never);
  // Bypass cases still invoke the base stream and capture its unchanged payload.
  void (wrapped ?? baseStreamFn)(model, { messages: [] } as Context, {
    reasoning: params.reasoning,
  });
  expect(captured).toStrictEqual(template ? { chat_template_kwargs: expected } : expected);
}

describe("vLLM streaming", () => {
  it.each([{ reasoning: false }, { api: "openai-responses" as never }])(
    "leaves unsupported Qwen model %j unchanged",
    (model) => {
      expectPayload(
        { format: "chat-template", model, initialPayload: { temperature: 0.2 } },
        { temperature: 0.2 },
        false,
      );
    },
  );

  it.each(["qwen", "qwen-chat-template"] as const)("sends efforts in %s", (thinkingFormat) => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      const enabled = level !== "off";
      const effort = enabled ? { reasoning_effort: level } : {};
      const thinking = { enable_thinking: enabled, ...effort };
      expectPayload(
        {
          thinkingLevel: "off",
          reasoning: level,
          initialPayload: {
            reasoning_effort: "high",
            reasoning: { effort: "high" },
            reasoningEffort: "high",
          },
          model: {
            id: "qwen3:8b",
            compat: {
              thinkingFormat,
              supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
            },
          },
        },
        thinkingFormat === "qwen"
          ? thinking
          : { chat_template_kwargs: { ...thinking, preserve_thinking: true } },
        false,
      );
    }
  });

  it.each(["compat", "model"] as const)("resolves %s maps and explicit disablement", (source) => {
    const mapping = { low: "LOW", high: "HIGH" };
    for (const supportsReasoningEffort of [true, false]) {
      expectPayload(
        {
          reasoning: "high",
          model: {
            id: "qwen3:8b",
            ...(source === "model" ? { thinkingLevelMap: mapping } : {}),
            compat: {
              thinkingFormat: "qwen-chat-template",
              supportsReasoningEffort,
              supportedReasoningEfforts: ["LOW", "HIGH"],
              ...(source === "compat" ? { reasoningEffortMap: mapping } : {}),
            },
          },
        },
        {
          enable_thinking: true,
          preserve_thinking: true,
          ...(supportsReasoningEffort ? { reasoning_effort: "HIGH" } : {}),
        },
      );
    }
  });

  it.each(["off", "max"] as const)("maps DeepSeek %s and strips hosted fields", (reasoning) => {
    expectPayload(
      {
        contextModelId: "nemotron-3-super",
        reasoning,
        initialPayload: { thinking: { type: "enabled" }, reasoning_effort: "high" },
        model: {
          id: "deepseek-ai/DeepSeek-V4-Flash",
          compat: { supportedReasoningEfforts: ["high", "max"] },
        },
      },
      {
        thinking: reasoning !== "off",
        enable_thinking: reasoning !== "off",
        ...(reasoning !== "off" ? { reasoning_effort: reasoning } : {}),
      },
    );
  });

  it.each<[string, PayloadCase, Record<string, unknown>]>([
    [
      "configured Qwen defaults",
      { format: "chat-template" },
      { enable_thinking: true, preserve_thinking: true },
    ],
    [
      "explicit DeepSeek template kwargs",
      {
        initialPayload: {
          chat_template_kwargs: { thinking: false, enable_thinking: false, drop_thinking: false },
        },
        model: { id: "DeepSeek-V4-Flash" },
      },
      { thinking: false, enable_thinking: false, drop_thinking: false, reasoning_effort: "high" },
    ],
    [
      "underscore-prefixed Nemotron alias",
      { thinkingLevel: "off", model: { id: "yk_nemotron-3-super" } },
      { enable_thinking: false, force_nonempty_content: true },
    ],
    ...[["invalid"], false].map((template): [string, PayloadCase, Record<string, unknown>] => [
      `invalid ${typeof template} template kwargs`,
      { thinkingLevel: "off", initialPayload: { chat_template_kwargs: template } },
      { enable_thinking: false, force_nonempty_content: true },
    ]),
    [
      "Qwen thinking composed with runtime Nemotron defaults",
      {
        thinkingLevel: "off",
        contextModelId: "Qwen/Qwen3-8B",
        model: { compat: { thinkingFormat: "qwen-chat-template" } },
      },
      { enable_thinking: false, preserve_thinking: true, force_nonempty_content: true },
    ],
  ])("preserves %s", (_name, params, expected) => expectPayload(params, expected));

  it("ignores request params when Qwen thinking format compat is not configured", () => {
    expect(
      wrapVllmProviderStream({
        provider: "vllm",
        modelId: "Qwen/Qwen3-8B",
        extraParams: { qwenThinkingFormat: "chat-template" },
        model: makeModel({ id: "Qwen/Qwen3-8B" }),
      } as never),
    ).toBeUndefined();
  });
});
