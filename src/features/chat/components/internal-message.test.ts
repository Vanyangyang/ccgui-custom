import { describe, expect, it } from "vitest";
import type { SessionMeta } from "@/lib/ipc";
import { internalMessageTitle, parseInternalMessage } from "./internal-message";

const source = { engine: "agy", sessionId: "source-session" };
const header = '[Message from CC GUI {"engine":"agy","session_id":"source-session"}]';

describe("internal message display wrapper", () => {
  it.each(["\n", "\r\n"])("recognizes saved and live headers with %j without changing the body", newline => {
    const body = `中文🙂${newline}${newline}\`\`\`ts${newline}const value = "原文";${newline}\`\`\`${newline}  `;
    expect(parseInternalMessage(`${header}${newline}${newline}${body}`)).toEqual({ source, text: body });
  });

  it.each([
    `用户引用：\n${header}\n\n正文`,
    `${header}\n正文`,
    '[Message from CC GUI {bad json}]\n\n正文',
    '[Message from CC GUI {"engine":"agy","session_id":42}]\n\n正文',
    '[Message from CC GUI {"engine":"","session_id":"source-session"}]\n\n正文',
    '[Message from CC GUI {"engine":"agy","session_id":""}]\n\n正文',
    '[Message from CC GUI {"engine":"agy","session_id":"line\\nbreak"}]\n\n正文',
  ])("leaves unrecognized content intact: %s", text => {
    expect(parseInternalMessage(text)).toBeNull();
  });

  it("prefers a unique current manual title, then the automatic title, then a short identity", () => {
    const session = { ...source, workspacePath: "/ws", title: "自动名称", customTitle: "手动名称" } as SessionMeta;
    expect(internalMessageTitle(source, [session])).toBe("手动名称");
    expect(internalMessageTitle(source, [{ ...session, customTitle: "" }])).toBe("自动名称");
    expect(internalMessageTitle(source, [])).toBe("agy · source-s");
    expect(internalMessageTitle(source, [session, { ...session, workspacePath: "/other" }])).toBe("agy · source-s");
    expect(internalMessageTitle(source, [{ ...session, engine: "codex" }])).toBe("agy · source-s");
    expect(internalMessageTitle({ ...source, workspacePath: "/other" }, [session, { ...session, workspacePath: "/other", customTitle: "确切来源" }])).toBe("确切来源");
  });
});
