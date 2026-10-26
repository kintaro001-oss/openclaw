/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveThemeBranding } from "../../../../packages/gateway-protocol/src/theme.ts";
import { createChangeListeners } from "../../../../src/shared/listeners.ts";
import type { ApplicationContext, ApplicationTheme } from "../../app/context.ts";
import { getLobsterdexEntries, recordLobsterVisit } from "../../components/lobster-dex.ts";
import { i18n } from "../../i18n/index.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { LobsterdexPage } from "./lobsterdex-page.tsx";

const firstSeenAt = new Date("2026-07-10T12:00:00.000Z").getTime();
beforeEach(() => {
  i18n.setLocale("en");
  vi.stubGlobal("localStorage", window.localStorage);
  localStorage.clear();
  vi.spyOn(Date, "now").mockReturnValue(firstSeenAt);
});
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function theme(lobsterdex: boolean) {
  const listeners = createChangeListeners();
  const source = {
    branding: { ...resolveThemeBranding(undefined), lobsterdex },
    subscribe: listeners.subscribe,
  };
  return {
    // SAFETY: Lobsterdex consumes only branding and its subscription from the theme owner.
    source: source as unknown as ApplicationTheme,
    publish(visible: boolean) {
      source.branding = { ...source.branding, lobsterdex: visible };
      listeners.publish();
      flush();
    },
  };
}

function mountLobsterdex(source = { theme: theme(true).source }) {
  // SAFETY: This page reads only theme, base path, and navigation from the application.
  const context = Object.assign(source, {
    basePath: "",
    navigate: () => {},
  }) as unknown as ApplicationContext;
  const view = mountSolid(() => (
    <ApplicationProvider value={context}>
      <LobsterdexPage />
    </ApplicationProvider>
  ));
  return Object.assign(view, {
    find: (selector: string) => view.container.querySelector<HTMLElement>(selector),
  });
}

it("follows the replacement theme's Lobsterdex availability", () => {
  const first = theme(true);
  const second = theme(false);
  const [current, setCurrent] = createSignal(first.source);
  const view = mountLobsterdex({
    get theme() {
      return current();
    },
  });
  const expectGrid = (visible: boolean) => {
    flush();
    expect(view.find(".lobsterdex-page__grid") !== null).toBe(visible);
  };
  expectGrid(true);
  setCurrent(second.source);
  expectGrid(false);
  first.publish(true);
  expectGrid(false);
  second.publish(true);
  expectGrid(true);
});

it.each(["shown", "hidden", "disposed"] as const)("handles the initial hash (%s)", async (mode) => {
  const previousUrl = location.href;
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  history.replaceState(null, "", "#lobsterdex-blue");
  const current = theme(mode !== "hidden");
  const view = mountLobsterdex({ theme: current.source });
  try {
    await Promise.resolve();
    flush();
    if (mode === "hidden") {
      current.publish(true);
    }
    const card = view.find("#lobsterdex-blue")!;
    const scroll = vi.fn();
    card.scrollIntoView = scroll;
    expect(card.classList.contains("lobsterdex-page__card--highlight")).toBe(mode !== "hidden");
    vi.advanceTimersByTime(16);
    expect(scroll).not.toHaveBeenCalled();
    if (mode === "disposed") {
      view.unmount();
    }
    vi.advanceTimersByTime(16);
    expect(scroll).toHaveBeenCalledTimes(mode === "shown" ? 1 : 0);
    if (mode !== "shown") {
      return;
    }
    expect(scroll).toHaveBeenLastCalledWith({ block: "center" });
    card.dispatchEvent(Object.assign(new Event("animationend"), { animationName: "other" }));
    expect(card.classList.contains("lobsterdex-page__card--highlight")).toBe(true);
    card.dispatchEvent(
      Object.assign(new Event("animationend"), { animationName: "lobsterdex-card-highlight" }),
    );
    expect(card.classList.contains("lobsterdex-page__card--highlight")).toBe(false);

    history.replaceState(null, "", "#lobsterdex-crimson");
    current.publish(false);
    current.publish(true);
    const nextCard = view.find("#lobsterdex-crimson")!;
    nextCard.scrollIntoView = scroll;
    vi.advanceTimersByTime(32);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(nextCard.classList.contains("lobsterdex-page__card--highlight")).toBe(false);
  } finally {
    view.unmount();
    history.replaceState(null, "", previousUrl);
    vi.useRealTimers();
  }
});

it("discovers palettes, preserving first visitors, lore and shiny sightings", () => {
  const name = "Clawnstantine";
  recordLobsterVisit("crimson", { name });
  const { find } = mountLobsterdex();
  flush();
  const expectText = (selector: string, expected: string) =>
    expect(find(selector)?.textContent).toBe(expected);
  const card = "#lobsterdex-clawnstantine";
  expectText(".lobsterdex-page__count", "1/49 visited");
  expectText(`${card} h3`, "?");
  expectText(`${card} .lobsterdex-page__lore`, "All tides lead here.");
  expect(find(`${card} .lobsterdex-page__date`)).toBeNull();

  recordLobsterVisit("clawnstantine", { name, shiny: true });
  recordLobsterVisit("clawnstantine", { name: "Impostor" });
  flush();
  const date = new Date(firstSeenAt).toLocaleDateString("en");
  expectText(`${card} h3`, name);
  expect(getLobsterdexEntries().get("crimson")?.name).toBe(name);
  expectText(`${card} .lobsterdex-page__lore`, "Built an empire. Still rules from the ledge.");
  expect(find(`${card} .lobsterdex-page__date`)?.textContent).toContain(date);
  expect(find(`${card} .lobsterdex-page__dates`)?.textContent).toContain(`✦ Shiny spotted ${date}`);
  expect(find(card)?.querySelectorAll("time")).toHaveLength(2);
  expect(find(`${card} .lobsterdex-page__star`)).not.toBeNull();
  expect(find(card)?.classList.contains("lobsterdex-page__card--unseen")).toBe(false);
});
