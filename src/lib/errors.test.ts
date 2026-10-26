import { expect, it } from "vitest";
import i18n from "./i18n";
import { errorText } from "./errors";

it("localizes provider migration conflicts from native and web errors", async () => {
  const path = "D:\\配置\\config.toml";
  const backup = "D:\\备份\\config.toml";
  const message = "CCGUI_PROVIDER_MIGRATION_CONFLICT:" + JSON.stringify({ path, backup });
  await i18n.changeLanguage("zh");
  expect(errorText(message)).toContain("旧版渠道配置无法自动恢复");
  expect(errorText(message)).toContain(path);
  await i18n.changeLanguage("en");
  expect(errorText(new Error(message))).toContain("Both files have been preserved");
  expect(errorText(new Error(message))).toContain(backup);
});

it("preserves unknown and malformed errors", () => {
  expect(errorText("CCGUI_PROVIDER_MIGRATION_CONFLICT:invalid")).toBe("CCGUI_PROVIDER_MIGRATION_CONFLICT:invalid");
  expect(errorText(new Error("disk full"))).toBe("disk full");
});

it("localizes the Cursor saved-selection gate", async () => {
  const message = "Cursor model is not selected in saved settings; select it in Settings → Collaboration and save before sending";
  await i18n.changeLanguage("zh");
  expect(errorText(message)).toContain("勾选具体模型并保存");
  await i18n.changeLanguage("en");
  expect(errorText(new Error(message))).toContain("Check a specific model");
});

it("localizes worker engine errors without displaying the transport envelope", async () => {
  await i18n.changeLanguage("zh");
  const message = "Cursor model is not selected in saved settings; select it in Settings → Collaboration and save before sending";
  const envelope = { code: "engine_error", message, outcomeUnknown: false };
  for (const error of [envelope, JSON.stringify(envelope), new Error(JSON.stringify(envelope))]) {
    expect(errorText(error)).toBe(i18n.t("settings.cursorModelNotSelected"));
  }
  expect(envelope.outcomeUnknown).toBe(false);
});

it("preserves unrecognized error envelopes", () => {
  for (const message of ['{"code":"future","message":"details","outcomeUnknown":false}',
    '{"code":"engine_error","message":42,"outcomeUnknown":false}', '{malformed']) {
    expect(errorText(message)).toBe(message);
  }
});
