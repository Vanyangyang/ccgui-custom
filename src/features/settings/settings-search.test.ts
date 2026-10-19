import { describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import {
  matchSettingsSearch,
  registerSettingsSearchEntries,
  settingsSearchEntries,
  type SettingsSearchEntry,
} from "./settings-search";

const translate = (key: string) => i18n.t(key);

/** Entry with overridable coordinates; `labelText` is never used here, so the
 *  union stays satisfied without a cast. */
function entry(
  over: Partial<{
    page: string;
    anchor: string;
    labelKey: string;
    sectionKey: string;
    keywords: string[];
  }> = {},
): SettingsSearchEntry {
  return {
    page: over.page ?? "demo",
    anchor: over.anchor ?? "petCharacter",
    labelKey: over.labelKey ?? "settings.petCharacter",
    sectionKey: over.sectionKey ?? "settings.pet",
    ...(over.keywords ? { keywords: over.keywords } : {}),
  };
}

describe("matchSettingsSearch", () => {
  it("matches the row label", () => {
    const hits = matchSettingsSearch([entry()], "角色", translate);
    expect(hits).toEqual([
      {
        entry: entry(),
        label: i18n.t("settings.petCharacter"),
        section: i18n.t("settings.pet"),
      },
    ]);
  });

  it("matches the card heading, so 「桌面宠物」 finds that card's rows", () => {
    const other = entry({ anchor: "petScale", labelKey: "settings.petScale" });
    const hits = matchSettingsSearch([entry(), other], "桌面宠物", translate);
    expect(hits.map((hit) => hit.entry.anchor)).toEqual([
      "petCharacter",
      "petScale",
    ]);
  });

  it("matches aliases case-insensitively without rendering them", () => {
    const hits = matchSettingsSearch(
      [entry({ keywords: ["pet", "spritesheet"] })],
      "PET",
      translate,
    );
    expect(hits.map((hit) => hit.label)).toEqual([i18n.t("settings.petCharacter")]);
    expect(hits[0].label.toLowerCase()).not.toContain("pet");
  });

  it("keeps declaration order and drops rows that do not match", () => {
    const hits = matchSettingsSearch(
      [
        entry({ anchor: "theme", labelKey: "settings.theme" }),
        entry({ anchor: "petEnabled", labelKey: "settings.petEnabled" }),
        entry({ anchor: "petScale", labelKey: "settings.petScale" }),
      ],
      "宠物大小",
      translate,
    );
    expect(hits.map((hit) => hit.entry.anchor)).toEqual(["petScale"]);
  });

  it("returns nothing for a blank or unmatched query", () => {
    expect(matchSettingsSearch([entry()], "   ", translate)).toEqual([]);
    expect(matchSettingsSearch([entry()], "zzz", translate)).toEqual([]);
  });

  it("strips i18next placeholders from the result label", () => {
    // 「管理历史记录 ({{count}})」 — a result row names the setting, not the
    // count of records behind it.
    const hits = matchSettingsSearch(
      [
        entry({
          anchor: "promptHistoryManage",
          labelKey: "settings.promptHistoryManageTitle",
          sectionKey: "settings.promptHistoryManage",
        }),
      ],
      "管理",
      translate,
    );
    expect(hits[0].label).toBe("管理历史记录");
  });
});

describe("settingsSearchEntries", () => {
  it("registers each (page, anchor) once, so HMR re-runs stay harmless", () => {
    const before = settingsSearchEntries().length;
    const once = entry({ page: "register-test", anchor: "theme" });
    registerSettingsSearchEntries([once]);
    registerSettingsSearchEntries([once]);
    expect(settingsSearchEntries()).toHaveLength(before + 1);
  });
});
