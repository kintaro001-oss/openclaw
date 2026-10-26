import { describe, expect, it, vi } from "vitest";
import { VisitorPolicyClient } from "./cloudflare.js";
import { VisitorAccessError } from "./errors.js";
import {
  visitorConfig as config,
  githubProvider,
  githubRule,
  namedPolicy,
} from "./visitors.test-support.js";

const collectionUrl =
  "https://api.cloudflare.com/client/v4/accounts/test-account/access/apps/test-app/policies";
const oidc = (overrides: Record<string, unknown> = {}) => ({
  oidc: { ...githubRule.oidc, ...overrides },
});

function cloudflareResponse(result: unknown, resultInfo?: unknown) {
  return Response.json({ success: true, result, result_info: resultInfo });
}
const policyPage = (policies: unknown[]) => cloudflareResponse(policies, { total_pages: 2 });

function fetchSequence(...responses: unknown[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) {
    fetcher.mockResolvedValueOnce(
      response instanceof Response ? response : cloudflareResponse(response),
    );
  }
  return fetcher;
}

const requestBody = (fetcher: ReturnType<typeof fetchSequence>, index: number) =>
  JSON.parse(String(fetcher.mock.calls[index]?.[1]?.body)) as unknown;

const methods = (fetcher: ReturnType<typeof fetchSequence>) =>
  fetcher.mock.calls.map(([, request]) => request?.method).join(" ");

describe("VisitorPolicyClient", () => {
  it.each([
    ["githubAccountIdClaim", false],
    ["issuer", true],
  ] as const)("pins %s through renewal (after response: %s)", async (field, afterResponse) => {
    let provider = { ...githubProvider };
    const policy = namedPolicy([42]);
    const fetcher = fetchSequence([], policy, [policy], policy);
    const client = new VisitorPolicyClient(config, fetcher, undefined, () => provider);
    const changeMapping = () => {
      provider = { ...githubProvider, [field]: "changed" };
    };
    fetcher.mockImplementationOnce(async () => {
      changeMapping();
      return cloudflareResponse(namedPolicy([42, 43]));
    });
    await expect(client.update(() => [42])).resolves.toEqual([42]);
    await expect(
      client.update(() => {
        if (!afterResponse) {
          changeMapping();
        }
        return afterResponse ? [42, 43] : [42];
      }),
    ).rejects.toThrow("mapping changed");
    expect(methods(fetcher)).toEqual(afterResponse ? "GET POST GET GET PUT" : "GET POST GET GET");
  });

  it("rereads dashboard targets and preserves restrictions on update", async () => {
    const original = namedPolicy(["A@b.com", 42]);
    const restrictions = {
      precedence: 9,
      session_duration: "12h",
      approval_required: true,
      approval_groups: [{ approvals_needed: 1, email_addresses: ["approver@example.com"] }],
      mfa_config: { mfa_disabled: false },
    };
    const updated = {
      ...namedPolicy(["a@b.com", "m@b.com", 42]),
      ...restrictions,
      created_at: "2026-08-28T00:00:00Z",
    };
    const fetcher = fetchSequence([original], original, [updated], updated, updated);
    const client = new VisitorPolicyClient(config, fetcher, undefined, () => githubProvider);
    await expect(client.read()).resolves.toEqual({
      id: original.id,
      targets: ["a@b.com", 42],
    });

    const expected = ["a@b.com", "m@b.com", 42, "n@b.com", 84];
    await expect(client.update((targets) => [...targets, "n@b.com", 84])).resolves.toEqual(
      expected,
    );

    const { id, ...payload } = namedPolicy(expected);
    expect(requestBody(fetcher, 4)).toEqual({ ...payload, ...restrictions });
    expect(fetcher.mock.calls[4]?.[0]).toBe(`${collectionUrl}/${id}`);
    expect(fetcher.mock.calls[4]?.[1]?.method).toBe("PUT");
  });

  it.each<[Record<string, unknown>, (typeof githubProvider | null)?]>([
    [{ decision: "deny" }],
    [{ include: [{ everyone: {} }] }],
    [{ include: [{ email: { email: "first@example.com" }, everyone: {} }] }],
    [{ include: [githubRule] }, null],
    [{ include: [oidc({ identity_provider_id: "other-provider" })] }],
    [{ include: [oidc({ claim_name: "login" })] }],
    [{ include: [{ ...githubRule, everyone: {} }] }],
    [{ include: [oidc({ login: "visitor" })] }],
    [{ include: [oidc({ claim_value: "042" })] }],
    [{ include: [oidc({ claim_value: "9007199254740992" })] }],
    [{ include: [oidc({ claim_value: 42 })] }],
    [{ require: [{ email_domain: { domain: "example.com" } }] }],
    [{ exclude: [{ email: { email: "excluded@example.com" } }] }],
    [{ name: "GitHub organization" }],
    [{ id: "other-policy" }],
  ])(
    "refuses policy %j before mutation (provider: %j)",
    async (override, provider = githubProvider) => {
      const policy = namedPolicy();
      const fetcher = fetchSequence([policy], { ...policy, ...override });
      const change = vi.fn(() => ["next@example.com"]);
      const readProvider = () => provider ?? undefined;
      const client = new VisitorPolicyClient(config, fetcher, undefined, readProvider);
      await expect(client.update(change)).rejects.toBeInstanceOf(VisitorAccessError);
      expect(change).not.toHaveBeenCalled();
      expect(methods(fetcher)).toBe("GET GET");
    },
  );

  it.each([false, true])("discovers policies; rejects duplicates: %s", async (duplicate) => {
    const policy = namedPolicy();
    const fetcher = fetchSequence(
      policyPage([duplicate ? policy : { id: "other", name: "Maintainers" }]),
      policyPage([{ ...policy, id: duplicate ? "duplicate" : policy.id }]),
      ...(duplicate ? [] : [policy]),
    );
    const client = new VisitorPolicyClient(config, fetcher);
    if (duplicate) {
      await expect(client.update(() => [])).rejects.toBeInstanceOf(VisitorAccessError);
    } else {
      await expect(client.read()).resolves.toEqual({
        id: policy.id,
        targets: ["first@example.com"],
      });
    }
    expect(fetcher.mock.calls[1]?.[0]).toBe(`${collectionUrl}?page=2&per_page=100`);
    expect(methods(fetcher)).toBe(duplicate ? "GET GET" : "GET GET GET");
  });

  it.each([
    ["network", () => Promise.reject(new Error(config.apiToken))],
    ["http", async () => new Response(config.apiToken, { status: 403 })],
    ["api", async () => Response.json({ success: false, errors: [{ message: config.apiToken }] })],
    ["json", async () => new Response(config.apiToken)],
  ] as const)("never exposes token-bearing %s failures", async (_mode, response) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(response);
    const error = await new VisitorPolicyClient(config, fetcher)
      .read()
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(VisitorAccessError);
    expect(String(error)).not.toContain(config.apiToken);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });

  it("fences an obsolete service before the durable callback runs", async () => {
    const abort = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
      abort.abort();
      return cloudflareResponse([]);
    });
    const change = vi.fn(() => ["next@example.com"]);
    await expect(
      new VisitorPolicyClient(config, fetcher, abort.signal).update(change),
    ).rejects.toBeInstanceOf(VisitorAccessError);
    expect(change).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
