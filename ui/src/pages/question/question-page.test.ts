/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { questionPanelIn } from "../chat/components/chat-question-card.test-support.ts";
import "./question-page.tsx";

type QuestionPage = HTMLElementTagNameMap["openclaw-question-page"];
const answers = { answers: { audience: ["The design team"] } };
const question = (id = "q1") => ({
  id,
  status: "pending",
  createdAtMs: Date.now(),
  expiresAtMs: Date.now() + 60_000,
  questions: [{ questionId: "audience", header: "To", question: id, options: [], isOther: true }],
});
const reply = (id = "q1") => ({ question: question(id) });

async function mount(request: GatewayRequestHandler) {
  const { gateway, publish } = createApplicationGateway();
  const update = (patch: Partial<ApplicationGatewaySnapshot>) =>
    publish({ ...gateway.snapshot, ...patch });
  update({ client: createTestGatewayClient(request), phase: "connected" });
  const provider = createApplicationContextProvider({ gateway } as ApplicationContext);
  const page = document.createElement("openclaw-question-page");
  page.questionId = "q1";
  provider.append(page);
  document.body.append(provider);
  await settle(page);
  return { page, update };
}

async function settle(page: QuestionPage) {
  await Promise.resolve();
  await Promise.resolve();
  await page.updateComplete;
}

function retry(page: QuestionPage) {
  return page.querySelector<HTMLButtonElement>(".approval-page__state .btn");
}

function panelButton(page: QuestionPage, action: string) {
  return page.querySelector<HTMLButtonElement>(`.chat-question-panel__${action}`)!;
}

function typeAnswer(page: QuestionPage) {
  const input = page.querySelector("textarea")!;
  input.value = "The design team";
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

beforeEach(() => i18n.setLocale("en"));
afterEach(() => document.body.replaceChildren());

it.each(["question", "outside"] as const)("restores only question focus (%s)", async (focusAt) => {
  const request = vi.fn().mockResolvedValue(reply());
  const { page } = await mount(request);
  await questionPanelIn(page);
  const input = page.querySelector("textarea")!;
  const outside = document.body.appendChild(document.createElement("button"));
  const target = focusAt === "question" ? input : outside;
  target.focus();
  expect(document.activeElement).toBe(target);

  page.questionId = "";
  await settle(page);

  await waitForSolid(() => {
    expect(input.isConnected).toBe(false);
    const next = focusAt === "question" ? page.querySelector("#question-page-title") : outside;
    expect(document.activeElement).toBe(next);
  });
  expect(page.textContent).toContain("Unavailable");
  expect(request).toHaveBeenCalledTimes(1);
});

it("keeps focus on the collapsed question so it can be reopened", async () => {
  const { page } = await mount(vi.fn().mockResolvedValue(reply()));
  await questionPanelIn(page);
  typeAnswer(page);
  const collapse = panelButton(page, "collapse");
  collapse.focus();
  collapse.click();
  await waitForSolid(() => {
    expect(panelButton(page, "collapsed-button")).not.toBeNull();
    expect(document.activeElement).toBe(panelButton(page, "collapsed-button"));
  });

  panelButton(page, "collapsed-button").click();
  await waitForSolid(() => {
    expect(document.activeElement).toBe(page.querySelector(".chat-question-panel"));
    expect(page.querySelector("textarea")?.value).toBe("The design team");
  });
});

it("recovers a failed reconnect lookup without losing the typed answer", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(reply())
    .mockRejectedValueOnce(new Error("temporary transport failure"))
    .mockResolvedValueOnce(reply())
    .mockResolvedValueOnce({ status: "answered", answers });
  const { page, update } = await mount(request);
  await questionPanelIn(page);
  typeAnswer(page);

  update({ phase: "reconnecting" });
  update({ phase: "connected" });
  await settle(page);
  await waitForSolid(() => expect(retry(page)?.textContent?.trim()).toBe("Retry"));
  expect(page.textContent).toContain("Could not load this question. Try again.");
  retry(page)!.click();
  await settle(page);
  await questionPanelIn(page);
  expect(page.querySelector("textarea")?.value).toBe("The design team");
  panelButton(page, "advance").click();
  await settle(page);
  const resolution = { id: "q1", answers };
  expect(request).toHaveBeenLastCalledWith("question.resolve", resolution, expect.any(Object));
  await waitForSolid(() => expect(page.textContent).toContain("Answered"));
  expect(page.querySelector(".chat-question-summary")?.textContent).toContain("The design team");
});

it.each(["initial-id", "retry-id", "retry-client"])("retires stale lookup (%s)", async (change) => {
  const retried = change !== "initial-id";
  const pending = createDeferred<unknown>();
  const current = createDeferred<unknown>();
  const request = vi.fn();
  if (retried) {
    request.mockRejectedValueOnce(new Error("temporary lookup failure"));
  }
  request.mockReturnValueOnce(pending.promise).mockReturnValueOnce(current.promise);
  const { page, update } = await mount(request);
  if (retried) {
    await waitForSolid(() => expect(retry(page)?.textContent?.trim()).toBe("Retry"));
    retry(page)!.click();
  }
  await waitForSolid(() => {
    expect(page.querySelector("main")?.getAttribute("aria-busy")).toBe("true");
    expect(retry(page)).toBeNull();
    expect(document.title).toContain("Loading");
  });
  if (change !== "retry-client") {
    page.questionId = "q2";
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(retried ? 3 : 2));
  } else {
    update({ client: createTestGatewayClient(() => current.promise) });
  }
  const id = change === "retry-client" ? "q1" : "q2";
  current.resolve(reply(id));
  await waitForSolid(() => expect(page.textContent).toContain(id));
  await settle(page);
  await questionPanelIn(page);
  expect(page.querySelector("main")?.getAttribute("aria-busy")).toBe("false");
  pending.reject(new Error("old lookup failed"));
  await settle(page);
  expect(page.querySelector("textarea")).not.toBeNull();
  expect(retry(page)).toBeNull();
});

it("keeps confirmed missing questions unavailable without a retry", async () => {
  const error = new GatewayRequestError({
    code: "INVALID_REQUEST",
    message: "question not found",
    details: { reason: "QUESTION_NOT_FOUND" },
  });
  const { page } = await mount(vi.fn().mockRejectedValue(error));
  await waitForSolid(() => expect(page.textContent).toContain("Unavailable"));
  expect(retry(page)).toBeNull();
});

it("loads only the final question when native IDs change in one turn", async () => {
  const request = vi.fn().mockResolvedValueOnce(reply()).mockResolvedValueOnce(reply("q3"));
  const { page } = await mount(request);
  await questionPanelIn(page);

  page.questionId = "q2";
  page.questionId = "q3";
  await waitForSolid(() => expect(page.textContent).toContain("q3"));
  await questionPanelIn(page);

  expect(request.mock.calls.map(([, params]) => params)).toEqual([{ id: "q1" }, { id: "q3" }]);
});
