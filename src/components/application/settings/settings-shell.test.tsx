import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Settings from "lucide-react/dist/esm/icons/settings";
import i18n from "@/lib/i18n";
import type { SettingsSearchEntry } from "@/features/settings/settings-search";
import { SettingsRow } from "./settings-rows";
import { SettingsShell, type SettingsNavGroup } from "./settings-shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// jsdom has no ResizeObserver; the rail's sortable list measures with one.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

const GROUPS: SettingsNavGroup[] = [
  {
    id: "system",
    label: "系统",
    items: [{ key: "demo", label: "演示页", icon: Settings }],
  },
];
const TITLES = { demo: "演示页" };
const ENTRIES: SettingsSearchEntry[] = [
  {
    page: "demo",
    anchor: "petCharacter",
    labelKey: "settings.petCharacter",
    sectionKey: "settings.pet",
  },
];

/** Paints the stub page's row on demand: 通用 renders its rows only once its
 *  settings read lands, which is why a search hit cannot just querySelector on
 *  click. Driving the paint from the test (instead of a timer) keeps both the
 *  "nothing to scroll to yet" and the "reveal it once it appears" halves of
 *  that behavior deterministic. */
let paintPage: (() => void) | null = null;

function LatePage() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    paintPage = () => setReady(true);
    return () => {
      paintPage = null;
    };
  }, []);
  return ready ? (
    <SettingsRow
      anchor="petCharacter"
      label={i18n.t("settings.petCharacter")}
    />
  ) : (
    <p>加载中…</p>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function render() {
  await act(async () => {
    root.render(
      <SettingsShell
        onClose={() => {}}
        defaultPage="demo"
        ariaLabel="设置"
        groups={GROUPS}
        titles={TITLES}
        renderPage={() => <LatePage />}
        searchEntries={ENTRIES}
      />,
    );
  });
}

async function typeQuery(value: string) {
  const input = document.querySelector<HTMLInputElement>("nav input");
  if (!input) throw new Error("settings search input not rendered");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Let the page paint the row the reveal is waiting for. */
async function paintLatePage() {
  if (!paintPage) throw new Error("stub page not mounted");
  await act(async () => {
    paintPage!();
  });
}

/** Rail button whose text contains every fragment — a hit row reads
 *  「角色」 over its card heading 「桌面宠物」. */
function railButton(...fragments: string[]): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>("nav button")].find(
      (button) => {
        const text = button.textContent ?? "";
        return fragments.every((fragment) => text.includes(fragment));
      },
    ) ?? null
  );
}

function anchoredRow(anchor: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-setting-anchor="${anchor}"]`,
  );
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

describe("SettingsShell search", () => {
  it("lists rows inside the page under the page title, as a path", async () => {
    await render();
    await typeQuery("宠物");
    expect(
      railButton(i18n.t("settings.petCharacter"), i18n.t("settings.pet")),
    ).not.toBeNull();
    // The page-title lane stays empty for a query no page name contains; the
    // page name still heads the hit lane.
    expect(railButton("演示页")).toBeNull();
    expect(
      [...document.querySelectorAll("nav span")].some(
        (el) => el.textContent?.trim() === "演示页",
      ),
    ).toBe(true);
  });

  it("keeps filtering page titles (the lane that existed before)", async () => {
    await render();
    await typeQuery("演示");
    expect(railButton("演示页")).not.toBeNull();
    expect(railButton(i18n.t("settings.petCharacter"))).toBeNull();
  });

  it("reveals the hit once the page paints it, and flashes the row", async () => {
    await render();
    await typeQuery("宠物");
    const hit = railButton(
      i18n.t("settings.petCharacter"),
      i18n.t("settings.pet"),
    );
    expect(hit).not.toBeNull();
    await click(hit!);
    // 通用's rows arrive with its settings read: nothing to scroll to yet.
    expect(anchoredRow("petCharacter")).toBeNull();
    await paintLatePage();
    const row = anchoredRow("petCharacter");
    expect(row).not.toBeNull();
    expect(row!.className).toContain("ring-border-focus-ring");
  });

  it("drops the reveal ring after the flash window", async () => {
    vi.useFakeTimers();
    await render();
    await typeQuery("宠物");
    await click(
      railButton(i18n.t("settings.petCharacter"), i18n.t("settings.pet"))!,
    );
    await paintLatePage();
    expect(anchoredRow("petCharacter")!.className).toContain(
      "ring-border-focus-ring",
    );
    await act(async () => {
      vi.advanceTimersByTime(1200);
    });
    expect(anchoredRow("petCharacter")!.className).not.toContain(
      "ring-border-focus-ring",
    );
  });

  it("opens the top hit on Enter", async () => {
    await render();
    await typeQuery("宠物");
    const input = document.querySelector<HTMLInputElement>("nav input")!;
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await paintLatePage();
    expect(anchoredRow("petCharacter")).not.toBeNull();
  });

  it("shows the empty line when neither lane matches", async () => {
    await render();
    await typeQuery("zzz");
    expect(document.querySelector("nav")!.textContent).toContain(
      i18n.t("settings.searchEmpty"),
    );
  });
});

describe("SettingsShell search behind a pane tab", () => {
  const PANE_GROUPS: SettingsNavGroup[] = [
    {
      id: "system",
      label: "系统",
      items: [{ key: "pane", label: "分页页", icon: Settings }],
    },
  ];
  const PANE_ENTRIES: SettingsSearchEntry[] = [
    {
      page: "pane",
      anchor: "paneRow",
      labelKey: "settings.petScale",
      sectionKey: "settings.pet",
      activatorAnchor: "paneTab",
    },
  ];

  /** Page whose row only exists while 公网-style pane tab is selected. */
  function PanePage() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button
          type="button"
          data-setting-anchor="paneTab"
          aria-pressed={open}
          onClick={() => setOpen(true)}
        >
          远程
        </button>
        {open && (
          <SettingsRow anchor="paneRow" label={i18n.t("settings.petScale")} />
        )}
      </>
    );
  }

  it("opens the pane, then scrolls to and flashes the row inside it", async () => {
    await act(async () => {
      root.render(
        <SettingsShell
          onClose={() => {}}
          defaultPage="pane"
          ariaLabel="设置"
          groups={PANE_GROUPS}
          titles={{ pane: "分页页" }}
          renderPage={() => <PanePage />}
          searchEntries={PANE_ENTRIES}
        />,
      );
    });
    await typeQuery("宠物大小");
    await click(
      railButton(i18n.t("settings.petScale"), i18n.t("settings.pet"))!,
    );
    const row = anchoredRow("paneRow");
    expect(row).not.toBeNull();
    expect(row!.className).toContain("ring-border-focus-ring");
    expect(
      container.querySelector("[data-setting-anchor=\"paneTab\"]")!
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
