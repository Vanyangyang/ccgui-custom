import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { sessionKey, useChatStore } from "../store";
import { annotationDraftText, submitImageAnnotation, type ImageAnnotationTarget } from "./image-annotation-target";

vi.mock("@/lib/transport", () => ({ isWeb: false, invoke: vi.fn(), listen: vi.fn(async () => () => {}), webToken: null }));

const original = useChatStore.getState();
const tab = { engine: "claude", sessionId: "annotate-one", workspacePath: "/fixture" };
const key = sessionKey(tab.engine, tab.sessionId, tab.workspacePath);
const box = { id: 1, x: 0.123, y: 0.3, width: 0.277, height: 0.224, note: "按钮文字\n被截断" };
const PNG = `data:image/png;base64,${btoa("png-bytes")}`;
const t = i18n.t.bind(i18n);

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useChatStore.setState({ ...original, active: tab, openTabs: [tab], drafts: { [key]: "已有草稿" } });
});
afterEach(() => useChatStore.setState(original, true));

function target(supportsImages: boolean): ImageAnnotationTarget & { attachFiles: ReturnType<typeof vi.fn> } {
  return { sessionKey: key, supportsImages, attachFiles: vi.fn() };
}

describe("image annotation target", () => {
  it("formats one line per box with whole-percent bounds", () => {
    expect(annotationDraftText(t, { name: "design.png", sourcePath: "C:/work/design.png" }, [box], true)).toBe(
      "[图片批注] design.png（附带标注图，编号框与下列编号对应）\n原图：C:/work/design.png\n1. x 12%–40%，y 30%–52%：按钮文字 被截断",
    );
  });

  it("attaches the original and the annotated copy, then appends to the draft without sending", async () => {
    const into = target(true);
    const render = vi.fn(async () => new Blob(["annotated"], { type: "image/png" }));
    await submitImageAnnotation(into, { src: PNG, name: "design.png", includeOriginal: true }, [box], t, render);
    expect(render).toHaveBeenCalledWith(PNG, [box]);
    const files = into.attachFiles.mock.calls[0][0] as File[];
    expect(files.map((file) => [file.name, file.type])).toEqual([["design.png", "image/png"], ["design-annotated.png", "image/png"]]);
    expect(useChatStore.getState().drafts[key]).toMatch(/^已有草稿\n\n\[图片批注\] design\.png/);
  });

  it("adds only the annotated copy for an existing attachment", async () => {
    const into = target(true);
    await submitImageAnnotation(into, { src: PNG, name: "shot.png", includeOriginal: false }, [box], t,
      async () => new Blob(["annotated"], { type: "image/png" }));
    expect((into.attachFiles.mock.calls[0][0] as File[]).map((file) => file.name)).toEqual(["shot-annotated.png"]);
  });

  it("falls back to text for engines without image input", async () => {
    const into = target(false);
    const render = vi.fn();
    await submitImageAnnotation(into, { src: PNG, name: "design.png", sourcePath: "C:/work/design.png", includeOriginal: true }, [box], t, render);
    expect(render).not.toHaveBeenCalled();
    expect(into.attachFiles).not.toHaveBeenCalled();
    expect(useChatStore.getState().drafts[key]).toContain("（当前引擎不支持图片附件，仅附文字批注）\n原图：C:/work/design.png");
  });

  it("leaves the draft untouched when rendering fails", async () => {
    const into = target(true);
    await expect(submitImageAnnotation(into, { src: PNG, name: "design.png", includeOriginal: true }, [box], t,
      async () => { throw new Error("decode failed"); })).rejects.toThrow("decode failed");
    expect(into.attachFiles).not.toHaveBeenCalled();
    expect(useChatStore.getState().drafts[key]).toBe("已有草稿");
  });
});
