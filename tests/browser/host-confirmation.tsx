import { createRoot } from "react-dom/client";
import "../../src/index.css";
import i18n from "../../src/lib/i18n";
import { HostConfirmation } from "../../src/features/host-confirmation/HostConfirmation";
const dark = new URLSearchParams(location.search).get("dark") === "1";
const long = new URLSearchParams(location.search).get("long") === "1";
document.documentElement.classList.toggle("dark", dark);
void i18n.changeLanguage("zh");
const calls: boolean[] = [];
Object.assign(window, { confirmationFixture: { calls } });
createRoot(document.getElementById("root")!).render(<HostConfirmation content={{
  title: "确认交接子任务", message: "请核对接班模型与待发送内容。此页面仅包含合成测试数据。".repeat(long ? 50 : 1), dark, language: "zh",
  fields: [{ label: "目标模型", value: "Fixture Model · high" }, { label: "项目", value: "C:/fixture/合成项目/long-project-name-with-unicode-🧭" }, { label: "图片附件", value: "2" }],
  sections: [{ title: "待发原文 · 点击展开", markdown: false, body: "合成待办：保留中文与 emoji 👩‍💻，完成后检查结果。\n".repeat(80) }, { title: "历史摘要 · 点击展开", markdown: true, body: "# 合成摘要 🧭\n\n" + "## 检查事项\n- 中文与 emoji 👩‍💻\n- [外部链接为静态文本](https://example.com)\n\n```ts\nconst fixture = '不会执行';\n```\n\n| 项目 | 结果 |\n| --- | --- |\n| 示例 | 保留格式 |\n\n".repeat(30) }],
  confirmLabel: "确认交接", dismissLabel: "取消",
}} respond={async accepted => { calls.push(accepted); }} />);
