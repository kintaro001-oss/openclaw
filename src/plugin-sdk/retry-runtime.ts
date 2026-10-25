import { formatErrorMessage } from "../infra/errors.js";
import {
  type RetryConfig,
  type RetryOptions,
  resolveRetryConfig,
  retryAsync,
} from "../infra/retry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

export type RetryRunner = <T>(fn: () => Promise<T>, label?: string) => Promise<T>;

/** Default retry envelope for channel API operations that hit transient network edges. */
const CHANNEL_API_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 400,
  maxDelayMs: 30_000,
  jitter: 0.1,
};

const CHANNEL_API_RETRY_RE =
  /429|421|timeout|connect|reset|closed|unavailable|temporarily|misdirected request/i;
const log = createSubsystemLogger("retry-policy");

function getChannelApiRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const candidate =
    // Telegram-style clients may expose retry_after on the root error, response,
    // or nested error object; keep all shapes aligned so rate-limit sleeps match.
    "parameters" in err && err.parameters && typeof err.parameters === "object"
      ? (err.parameters as { retry_after?: unknown }).retry_after
      : "response" in err &&
          err.response &&
          typeof err.response === "object" &&
          "parameters" in err.response
        ? (
            err.response as {
              parameters?: { retry_after?: unknown };
            }
          ).parameters?.retry_after
        : "error" in err && err.error && typeof err.error === "object" && "parameters" in err.error
          ? (err.error as { parameters?: { retry_after?: unknown } }).parameters?.retry_after
          : undefined;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate * 1000 : undefined;
}

/**
 * Creates a generic rate-limit-aware retry runner from explicit retry policy pieces.
 *
 * @deprecated Retained for plugins built against OpenClaw 2026.10.4 and earlier through
 * `openclaw/plugin-sdk/retry-runtime`; compose resolveRetryConfig and retryAsync. Tracked by
 * `plugin-sdk-private-runtime-shipped-exports`.
 */
export function createRateLimitRetryRunner(params: {
  retry?: RetryConfig;
  configRetry?: RetryConfig;
  verbose?: boolean;
  defaults: Required<RetryConfig>;
  logLabel: string;
  shouldRetry: (err: unknown) => boolean;
  retryAfterMs?: (err: unknown) => number | undefined;
}): RetryRunner {
  const retryConfig = resolveRetryConfig(params.defaults, {
    ...params.configRetry,
    ...params.retry,
  });
  return <T>(fn: () => Promise<T>, label?: string) =>
    retryAsync(fn, {
      ...retryConfig,
      label,
      shouldRetry: params.shouldRetry,
      retryAfterMs: params.retryAfterMs,
      onRetry: params.verbose
        ? (info) => {
            const labelText = info.label ?? "request";
            const maxRetries = Math.max(1, info.maxAttempts - 1);
            log.warn(
              `${params.logLabel} ${labelText} rate limited, retry ${info.attempt}/${maxRetries} in ${info.delayMs}ms`,
            );
          }
        : undefined,
    });
}

export function createChannelApiRetryRunner(params: {
  retry?: RetryConfig;
  configRetry?: RetryConfig;
  verbose?: boolean;
  retryAfterMaxDelayMs?: number;
  shouldRetry?: RetryOptions["shouldRetry"];
  retryAfterMs?: RetryOptions["retryAfterMs"];
  /**
   * When true, the custom shouldRetry predicate is used exclusively —
   * the default channel API fallback regex is NOT OR'd in.
   * Use this for non-idempotent operations (e.g. sendMessage) where
   * the regex fallback would cause duplicate message delivery.
   */
  strictShouldRetry?: boolean;
}): RetryRunner {
  const retryConfig = resolveRetryConfig(CHANNEL_API_RETRY_DEFAULTS, {
    ...params.configRetry,
    ...params.retry,
  });
  // Channel APIs often wrap network failures differently by provider. Keep the
  // fallback regex unless callers opt into strict idempotency control.
  const shouldRetry: NonNullable<RetryOptions["shouldRetry"]> = !params.shouldRetry
    ? (err: unknown) => CHANNEL_API_RETRY_RE.test(formatErrorMessage(err))
    : params.strictShouldRetry
      ? params.shouldRetry
      : (err: unknown, attempt: number) =>
          params.shouldRetry?.(err, attempt) || CHANNEL_API_RETRY_RE.test(formatErrorMessage(err));

  return <T>(fn: () => Promise<T>, label?: string) =>
    retryAsync(fn, {
      ...retryConfig,
      label,
      shouldRetry,
      retryAfterMs: params.retryAfterMs ?? getChannelApiRetryAfterMs,
      ...(params.retryAfterMaxDelayMs !== undefined
        ? { retryAfterMaxDelayMs: params.retryAfterMaxDelayMs }
        : {}),
      onRetry: params.verbose
        ? (info) => {
            const maxRetries = Math.max(1, info.maxAttempts - 1);
            log.warn(
              `channel send retry ${info.attempt}/${maxRetries} for ${info.label ?? label ?? "request"} in ${info.delayMs}ms: ${formatErrorMessage(info.err)}`,
            );
          }
        : undefined,
    });
}

/** Transient failures that prove the request did not reach the remote server. */
const PRE_CONNECT_NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Network failures that are transient for idempotent or deduplicated requests. */
const TRANSIENT_NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  ...PRE_CONNECT_NETWORK_ERROR_CODES,
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Classifies a normalized transport code without imposing a plugin-specific error shape. */
export function classifyTransientNetworkErrorCode(code: string | undefined) {
  const normalized = code?.trim().toUpperCase();
  if (!normalized) {
    return undefined;
  }
  if (PRE_CONNECT_NETWORK_ERROR_CODES.has(normalized)) {
    return "pre-connect";
  }
  return TRANSIENT_NETWORK_ERROR_CODES.has(normalized) ? "ambiguous" : undefined;
}

export {
  resolveRetryConfig,
  retryAsync,
  type RetryConfig,
  type RetryInfo,
  type RetryOptions,
} from "../infra/retry.js";
export { isTransientNetworkError } from "../infra/retryable-network-errors.js";
export { sleepWithAbort } from "../infra/backoff.js";
export {
  /** @deprecated Use createChannelApiRetryRunner. */
  createChannelApiRetryRunner as createTelegramRetryRunner,
  CHANNEL_API_RETRY_DEFAULTS as TELEGRAM_RETRY_DEFAULTS,
};
/** @deprecated Retained for plugins built against OpenClaw 2026.10.4 and earlier; tracked by `plugin-sdk-private-runtime-shipped-exports`. */

export { parseRetryAfterHeaderSeconds } from "../infra/retry-after.js";
