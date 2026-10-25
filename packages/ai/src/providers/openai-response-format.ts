import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ResponseFormatTextConfig } from "openai/resources/responses/responses.js";

const JSON_SCHEMA_RESPONSE_FORMAT_NAME = "openclaw_response";

/**
 * Maps the shared JSON Schema option to Chat Completions while preserving the
 * older provider-shaped json_object/json_schema inputs accepted by model params.
 */
export function resolveOpenAICompletionsResponseFormat(
  responseFormat: Record<string, unknown> | undefined,
  supportsJsonSchemaResponseFormat: boolean,
): Record<string, unknown> | undefined {
  if (!responseFormat) {
    return undefined;
  }
  if (
    responseFormat.type === "json_object" ||
    responseFormat.type === "text" ||
    (responseFormat.type === "json_schema" && isRecord(responseFormat.json_schema))
  ) {
    return responseFormat;
  }
  if (!supportsJsonSchemaResponseFormat) {
    return undefined;
  }
  return {
    type: "json_schema",
    json_schema: {
      name: JSON_SCHEMA_RESPONSE_FORMAT_NAME,
      schema: responseFormat,
    },
  };
}

/** Maps shared or provider-shaped structured-output options to the Responses API text format. */
export function resolveOpenAIResponsesTextFormat(
  responseFormat: Record<string, unknown>,
): ResponseFormatTextConfig {
  if (responseFormat.type === "json_schema") {
    const descriptor = isRecord(responseFormat.json_schema)
      ? responseFormat.json_schema
      : responseFormat;
    // SAFETY: Caller-authored native name/schema fields pass through for provider validation.
    return { ...descriptor, type: "json_schema" } as ResponseFormatTextConfig;
  }
  if (responseFormat.type === "json_object" || responseFormat.type === "text") {
    return { ...responseFormat, type: responseFormat.type };
  }
  return {
    type: "json_schema",
    name: JSON_SCHEMA_RESPONSE_FORMAT_NAME,
    schema: responseFormat,
  };
}
