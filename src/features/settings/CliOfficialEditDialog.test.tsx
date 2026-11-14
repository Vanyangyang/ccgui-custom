import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    getCliConfig: vi.fn(async () => ({})),
    checkCcSwitch: vi.fn(async () => ({ installed: false })),
    officialConfigRead: vi.fn(),
    officialConfigWrite: vi.fn(async () => {}),
  },
}));
vi.mock("@/lib/platform", () => ({ pickFile: vi.fn() }));
vi.mock("@/lib/transport", () => ({ listen: vi.fn(async () => () => {}) }));

import { ipc } from "@/lib/ipc";
import { CliOfficialEditDialog } from "./CliOfficialEditDialog";
import { useCliConfig, type CliConfigState } from "./useCliConfig";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const path = "C:\\Users\\Example\\.gemini\\antigravity-cli\\settings.json";
const settings = {
  mcpServers: {
    local: {
      command: '"C:\\Program Files\\nodejs\\node.exe"',
      args: ["C:\\Tools\\mcp\\server.js", '--label="Windows path"'],
    },
  },
  unknown: { text: "保留字段", enabled: true },
};
const raw = JSON.stringify(settings);
let root: Root;
let container: HTMLDivElement;
let cli: CliConfigState;

function Harness() {
  cli = useCliConfig("agy");
  return <CliOfficialEditDialog cli={cli} />;
}

function button(key: string) {
  const result = Array.from(document.querySelectorAll("button")).find(
    (element) => element.textContent === i18n.t(key),
  );
  expect(result).toBeDefined();
  return result!;
}

async function load(content: string, format = "json") {
  vi.mocked(ipc.officialConfigRead).mockResolvedValue([{ path, format, content, exists: true }]);
  await act(async () => root.render(<Harness />));
  await act(async () => cli.setOfficialEditing(true));
  expect(ipc.officialConfigRead).toHaveBeenCalledWith("agy");
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("official JSON editor BOM handling", () => {
  it.each(["", "\uFEFF"])("saves content unchanged with prefix %j", async (prefix) => {
    const content = prefix + raw;
    await load(content);
    expect(button("common.confirm").disabled).toBe(false);
    await act(async () => button("common.confirm").click());
    expect(ipc.officialConfigWrite).toHaveBeenCalledWith("agy", [{ path, content }]);
  });

  it.each(["", "\uFEFF"])("formats JSON preserving prefix %j and Windows commands", async (prefix) => {
    await load(prefix + raw);
    await act(async () => button("settings.cliFormatJson").click());
    const content = prefix + JSON.stringify(settings, null, 2) + "\n";
    expect(document.querySelector("textarea")?.value).toBe(content);
    expect(button("common.confirm").disabled).toBe(false);
    await act(async () => button("common.confirm").click());
    expect(ipc.officialConfigWrite).toHaveBeenCalledWith("agy", [{ path, content }]);
    expect(JSON.parse(content.slice(prefix.length))).toEqual(settings);
  });

  it.each(["{broken", "\uFEFF{broken", "\uFEFF\uFEFF{}"])(
    "keeps invalid JSON %j unchanged and disables save",
    async (content) => {
      await load(content);
      expect(button("common.confirm").disabled).toBe(true);
      await act(async () => button("settings.cliFormatJson").click());
      expect(document.querySelector("textarea")?.value).toBe(content);
      expect(button("common.confirm").disabled).toBe(true);
      await act(async () => button("common.confirm").click());
      expect(ipc.officialConfigWrite).not.toHaveBeenCalled();
    },
  );

  it.each(["[]", "\uFEFF[]", "\uFEFFnull"])("rejects non-object JSON %j", async (content) => {
    await load(content);
    expect(button("common.confirm").disabled).toBe(true);
    await act(async () => button("settings.cliFormatJson").click());
    expect(button("common.confirm").disabled).toBe(true);
    expect(ipc.officialConfigWrite).not.toHaveBeenCalled();
  });

  it("leaves TOML validation and raw saving unchanged", async () => {
    const content = '\uFEFFcommand = "C:\\\\Tools\\\\server.exe"';
    await load(content, "toml");
    expect(button("common.confirm").disabled).toBe(false);
    expect(document.body.textContent).not.toContain(i18n.t("settings.cliFormatJson"));
    await act(async () => button("common.confirm").click());
    expect(ipc.officialConfigWrite).toHaveBeenCalledWith("agy", [{ path, content }]);
  });
});
