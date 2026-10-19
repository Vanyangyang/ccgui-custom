import { afterAll, describe, expect, it, vi } from "vitest";
import type { ILink, Terminal } from "@xterm/xterm";

const originalPlatform = window.navigator.platform;
afterAll(() => {
  Object.defineProperty(window.navigator, "platform", {
    value: originalPlatform,
    configurable: true,
  });
});

function setPlatform(platform: string) {
  Object.defineProperty(window.navigator, "platform", {
    value: platform,
    configurable: true,
  });
}

const mocks = vi.hoisted(() => ({
  // dir path → entry names; the existence probe lists the candidate's parent.
  dirs: new Map<string, string[]>(),
  listDir: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({
  ipc: {
    listDir: (path: string) => {
      mocks.listDir(path);
      const names = mocks.dirs.get(path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase());
      if (!names) return Promise.reject(new Error("no such dir"));
      return Promise.resolve(names.map((name) => ({ name })));
    },
  },
}));

import { createPathLinkProvider } from "./links";

/** Minimal buffer fake: rows padded to `cols` like xterm's translateToString(false). */
function fakeTerm(rows: string[], wrapped: boolean[], cols: number): Terminal {
  const lines = rows.map((text, i) => ({
    isWrapped: wrapped[i],
    translateToString: (trimRight: boolean) => {
      const padded = text.padEnd(cols, " ");
      return trimRight ? padded.trimEnd() : padded;
    },
  }));
  return {
    buffer: { active: { getLine: (i: number) => lines[i] } },
  } as unknown as Terminal;
}

function getLinks(
  term: Terminal,
  y: number,
  cwd: string,
  onActivate: (path: string) => void = () => {},
): Promise<ILink[] | undefined> {
  const provider = createPathLinkProvider({ term, cwd, onActivate });
  const { promise, resolve } = Promise.withResolvers<ILink[] | undefined>();
  provider.provideLinks(y, resolve);
  return promise;
}

const CWD = "/Users/x/Desktop";

describe("terminal path link provider", () => {
  it("links a path with trailing prose, covering only the path", async () => {
    mocks.dirs.set("/users/x/desktop/out", ["app.dmg"]);
    const term = fakeTerm(["Signing /Users/x/Desktop/out/app.dmg ok"], [false], 80);
    const links = await getLinks(term, 1, CWD);
    expect(links).toHaveLength(1);
    expect(links?.[0].text).toBe("/Users/x/Desktop/out/app.dmg");
    expect(links?.[0].range).toEqual({ start: { x: 9, y: 1 }, end: { x: 36, y: 1 } });
  });

  it("links spaced CJK paths with cell-correct range", async () => {
    mocks.dirs.set("/users/x/desktop/cc gui 项目", ["app.app"]);
    const line = "/Users/x/Desktop/CC GUI 项目/app.app";
    const term = fakeTerm([line], [false], 80);
    const links = await getLinks(term, 1, CWD);
    expect(links).toHaveLength(1);
    expect(links?.[0].text).toBe(line);
    // 24 ASCII cells + 2 wide chars (项目) at 2 cells each + "/app.app" 8 cells.
    expect(links?.[0].range).toEqual({ start: { x: 1, y: 1 }, end: { x: 36, y: 1 } });
  });

  it("strips sentence punctuation from the candidate before probing", async () => {
    mocks.dirs.set("/users/x/desktop/cc gui", ["gui_1.0.6_aarch64.dmg"]);
    const term = fakeTerm(["Bundling /Users/x/Desktop/CC GUI/GUI_1.0.6_aarch64.dmg)"], [false], 120);
    // Probe never sees the ")" — and the link must not cover it.
    const links = await getLinks(term, 1, CWD);
    expect(links?.[0].text).toBe("/Users/x/Desktop/CC GUI/GUI_1.0.6_aarch64.dmg");
  });

  it("joins soft-wrapped rows so long paths still link", async () => {
    mocks.dirs.set("/users/x/desktop/cc gui 项目", ["app.app"]);
    const term = fakeTerm(
      ["/Users/x/Desktop/CC ", "GUI 项目/app.app"],
      [false, true],
      20,
    );
    const links = await getLinks(term, 2, CWD);
    expect(links).toHaveLength(1);
    expect(links?.[0].range.start).toEqual({ x: 1, y: 1 });
    expect(links?.[0].range.end).toEqual({ x: 16, y: 2 });
  });

  it("ignores URLs and word-glued relative tokens", async () => {
    const term = fakeTerm(
      ["see https://example.com/a/b and github.com/foo/bar"],
      [false],
      120,
    );
    expect(await getLinks(term, 1, CWD)).toBeUndefined();
  });

  it("does not link paths that fail the existence probe", async () => {
    mocks.dirs.set("/users/x/desktop", ["real.txt"]);
    const term = fakeTerm(["missing /Users/x/Desktop/nope.txt here"], [false], 80);
    expect(await getLinks(term, 1, CWD)).toBeUndefined();
  });

  it("links outside-cwd paths without probing (no grant dialog on hover)", async () => {
    const term = fakeTerm(["at /usr/local/bin/node done"], [false], 80);
    const callsBefore = mocks.listDir.mock.calls.length;
    const links = await getLinks(term, 1, CWD);
    expect(links?.[0].text).toBe("/usr/local/bin/node");
    expect(mocks.listDir.mock.calls.length).toBe(callsBefore);
  });

  it("reveals only with the platform modifier: ⌥ on mac, Ctrl elsewhere", async () => {
    mocks.dirs.set("/users/x/desktop", ["artifact.dmg"]);
    const term = fakeTerm(["built /Users/x/Desktop/artifact.dmg now"], [false], 80);
    const onActivate = vi.fn();
    const links = await getLinks(term, 1, CWD, onActivate);
    const link = links?.[0];
    if (!link) throw new Error("expected a link");
    const click = (modifiers: { altKey?: boolean; ctrlKey?: boolean }) =>
      link.activate(modifiers as MouseEvent, link.text);

    setPlatform("MacIntel");
    click({});
    click({ ctrlKey: true });
    expect(onActivate).not.toHaveBeenCalled();
    click({ altKey: true });
    expect(onActivate).toHaveBeenCalledExactlyOnceWith("/Users/x/Desktop/artifact.dmg");

    onActivate.mockClear();
    setPlatform("Win32");
    click({});
    click({ altKey: true });
    expect(onActivate).not.toHaveBeenCalled();
    click({ ctrlKey: true });
    expect(onActivate).toHaveBeenCalledExactlyOnceWith("/Users/x/Desktop/artifact.dmg");
  });
});
