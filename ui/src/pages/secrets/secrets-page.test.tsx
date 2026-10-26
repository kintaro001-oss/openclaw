import { createSignal, Show } from "solid-js";
import { afterEach, expect, it } from "vitest";
import type { SecretStoreEntry } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import {
  createApplicationGatewaySnapshot,
  createApplicationGateway,
} from "../../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { SecretsPage } from "./secrets-page.tsx";

registerSettingsEnglish();
afterEach(cleanupSolid);

function entry(name: string): SecretStoreEntry {
  return {
    name,
    kind: "env",
    value: "https://service.example.test",
    scopeKind: "team",
    scopeId: "",
    createdAtMs: 1,
    updatedAtMs: 2,
  };
}

function mountPage(request: ReturnType<typeof createGatewayRequestMock>) {
  const snapshot = createApplicationGatewaySnapshot({
    client: createTestGatewayClient(request),
    phase: "connected",
    sessionKey: "main",
    hello: gatewayHelloForMethods(["secrets.store.list", "secrets.store.set"]),
  });
  const source = createApplicationGateway(snapshot);
  let pathname = "/settings/secrets";
  const listeners = new Set<() => void>();
  // SAFETY: Secrets consumes the Gateway and pathname subscription from this fixture.
  const context = {
    gateway: source.gateway,
    router: {
      getState: () => ({ location: { pathname } }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as ApplicationContext;
  const provider = createSolidApplicationContextProvider(context);
  let hide = () => {};
  const page = mountSolid(
    () => {
      const [visible, setVisible] = createSignal(true);
      hide = () => setVisible(false);
      return (
        <Show when={visible()}>
          <SecretsPage />
        </Show>
      );
    },
    { wrapper: provider.wrapper },
  );
  flush();
  const query = <T extends Element = HTMLElement>(selector: string) =>
    page.container.querySelector<T>(selector)!;
  const dialog = () => query("openclaw-modal-dialog");
  const submit = () => query<HTMLButtonElement>('.secrets-store-dialog button[type="submit"]');
  const input = (selector: string, value: string) => {
    const field = query<HTMLInputElement | HTMLTextAreaElement>(selector);
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return field;
  };
  const openDraft = async (name = "EXAMPLE_URL") => {
    query<HTMLButtonElement>("button.primary").click();
    await waitForSolid(() => expect(dialog()).not.toBeNull());
    const field = input('input[name="name"]', name);
    input('textarea[name="value"]', "https://example.test");
    flush();
    return field;
  };
  return {
    page,
    source,
    snapshot,
    query,
    dialog,
    submit,
    openDraft,
    waitText: (text: string) =>
      waitForSolid(() => expect(page.container.textContent).toContain(text)),
    leaveRoute: () => {
      pathname = "/settings/profile";
      for (const listener of listeners) {
        listener();
      }
      hide();
    },
  };
}

it("keeps reconnect reads current and releases the Gateway binding when the page unmounts", async () => {
  const stale = createDeferred<{ entries: SecretStoreEntry[] }>();
  const previousRequest = createGatewayRequestMock(async () => stale.promise);
  const { page, source, snapshot, query, dialog, openDraft, waitText } = mountPage(previousRequest);
  expect(previousRequest).toHaveBeenCalledExactlyOnceWith("secrets.store.list", {});

  source.publish({ ...snapshot, phase: "reconnecting" });
  flush();
  const currentRequest = createGatewayRequestMock(async () => ({
    entries: [entry("CURRENT_URL")],
  }));
  source.publish({ ...snapshot, client: createTestGatewayClient(currentRequest) });
  await waitText("CURRENT_URL");
  expect(currentRequest).toHaveBeenCalledExactlyOnceWith("secrets.store.list", {});
  stale.resolve({ entries: [entry("STALE_URL")] });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  flush();
  expect(page.container.textContent).toContain("CURRENT_URL");
  expect(page.container.textContent).not.toContain("STALE_URL");

  const name = await openDraft("api_token");
  await waitForSolid(() => expect(name.value).toBe("API_TOKEN"));
  expect(query<HTMLInputElement>('input[value="secret"]').checked).toBe(true);
  query<HTMLButtonElement>('.secrets-store-dialog button[type="button"]').click();
  await waitForSolid(() => expect(dialog()).toBeNull());

  page.unmount();
  const retiredRequest = createGatewayRequestMock(async () => ({ entries: [] }));
  source.publish({ ...snapshot, client: createTestGatewayClient(retiredRequest) });
  flush();
  expect(retiredRequest).not.toHaveBeenCalled();
});

it("retains a failed save draft, retries it, and releases pending presentation on reconnect", async () => {
  const firstSave = createDeferred<unknown>();
  const secondSave = createDeferred<unknown>();
  let saveCount = 0;
  const request = createGatewayRequestMock(async (method) => {
    if (method === "secrets.store.list") {
      return { entries: [entry("SERVICE_URL")] };
    }
    if (method === "secrets.store.set") {
      saveCount += 1;
      return saveCount === 1 ? firstSave.promise : secondSave.promise;
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const { page, source, snapshot, query, dialog, submit, openDraft, waitText } = mountPage(request);
  await waitText("SERVICE_URL");
  await openDraft();
  submit().click();
  await waitForSolid(() => expect(submit().textContent).toContain("Saving"));
  expect(submit().disabled).toBe(true);
  firstSave.reject(new Error("Synthetic save unavailable"));
  await waitForSolid(() => expect(submit().disabled).toBe(false));
  expect(page.container.textContent).toContain("Synthetic save unavailable");
  expect(query<HTMLInputElement>('input[name="name"]').value).toBe("EXAMPLE_URL");
  submit().click();
  await waitForSolid(() => expect(submit().disabled).toBe(true));
  expect(saveCount).toBe(2);
  const replacement = createGatewayRequestMock(async () => ({ entries: [entry("CURRENT_URL")] }));
  source.publish({ ...snapshot, client: createTestGatewayClient(replacement) });
  await waitText("CURRENT_URL");
  expect(dialog()).toBeNull();
  secondSave.reject(new Error("Retired save unavailable"));
  await Promise.resolve();
  flush();
  expect(page.container.textContent).not.toContain("Retired save unavailable");
});

it("releases route teardown while an admitted save is still pending", async () => {
  const save = createDeferred<unknown>();
  const request = createGatewayRequestMock(async (method) =>
    method === "secrets.store.set" ? save.promise : { entries: [entry("SERVICE_URL")] },
  );
  const { page, query, submit, openDraft, waitText, leaveRoute } = mountPage(request);
  await waitText("SERVICE_URL");
  await openDraft();
  submit().click();
  await waitForSolid(() => expect(submit().disabled).toBe(true));
  leaveRoute();
  await waitForSolid(() => expect(query("openclaw-secrets-page")).toBeNull());
  save.reject(new Error("Retired route save unavailable"));
  await Promise.resolve();
  flush();
  expect(page.container.textContent).not.toContain("Retired route save unavailable");
});
