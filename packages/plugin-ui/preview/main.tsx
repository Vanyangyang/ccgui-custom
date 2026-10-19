import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
/* 真实消费路径：走 exports map + 宿主完整 index.css（token 编译产物） */
import "../../../src/index.css";
import "@ccgui/plugin-ui/styles.css";
import { Badge, Button, Input, Select, Textarea } from "@ccgui/plugin-ui";

function Row({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>{children}</div>
    </div>
  );
}

function Panel() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 18,
        padding: 20,
        background: "var(--color-background-full, #fff)",
        color: "var(--color-text-primary)",
        fontFamily: "var(--font-sans)",
        fontSize: 13,
        minHeight: "100%",
      }}
    >
      <Row label="Button — primary / secondary / ghost / sm / disabled">
        <Button variant="primary">导出 PNG + PDF</Button>
        <Button variant="secondary">新建</Button>
        <Button variant="ghost">刷新</Button>
        <Button variant="secondary" size="sm">
          在 Finder 中显示
        </Button>
        <Button variant="primary" disabled>
          处理中…
        </Button>
        <Button variant="secondary" disabled>
          禁用
        </Button>
      </Row>
      <Row label="Input / Select / invalid / disabled">
        <Input style={{ width: 180 }} defaultValue="~/Documents/ccgui-release-notes" />
        <Select style={{ width: 140 }} defaultValue="article.md">
          <option value="article.md">article.md</option>
          <option value="v1.0.6.md">v1.0.6.md</option>
        </Select>
        <Input style={{ width: 120 }} placeholder="deepseek-flash" />
        <Input style={{ width: 120 }} invalid defaultValue="bad value" />
        <Input style={{ width: 100 }} disabled defaultValue="disabled" />
      </Row>
      <Row label="Badge">
        <Badge>v1.0.6</Badge>
        <Badge tone="accent">已切换到 ~/Documents</Badge>
        <Badge tone="success">导出完成</Badge>
        <Badge tone="error">导出失败</Badge>
      </Row>
      <Row label="Chat bubbles + composer">
        <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
          <div className="pui-bubble-user">你好，帮我把公告改成更轻松的语气</div>
          <div className="pui-bubble-agent">
            好的。当前目录里已经有一篇写好的文章（article.md，CC GUI v1.0.6，含 3 个功能小节 + 5 张截图）。
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
            <Textarea
              style={{ flex: 1, minHeight: 44 }}
              placeholder="描述你的任务，Enter 发送，Shift+Enter 换行"
            />
            <Button variant="primary">发送</Button>
          </div>
        </div>
      </Row>
    </div>
  );
}

function App() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", minHeight: "100vh" }}>
      <Panel />
      <div className="dark">
        <Panel />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
