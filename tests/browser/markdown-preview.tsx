// Open /tests/browser/markdown-preview.html with the Vite dev server running.
// Renders the real files-feature MarkdownPreview (Streamdown) against a
// document covering every structure the old unstyled preview mangled:
// GFM tables, heading levels, lists, blockquote, code fence, math, mermaid.
// No app, no backend, no saved state.
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import "../../src/lib/i18n";
import { MarkdownPreview } from "../../src/features/files/MarkdownPreview";

const DOC = `# ChatMoss 服务下线 & 极简退款门户重建计划（审查稿）

版本：v1.0（2026-09-28） 状态：待审查

## 0.2 已确认决策

| 决策点 | 结论 |
| --- | --- |
| 公众号 | 保留（扫码登录依赖它，年审 ¥300/年照付） |
| 自动退款 API | 不做。钱继续在微信商户平台手动退 |
| 门户功能 | 登录后显示 UID（附昵称确认身份），不做订单展示 |

## 0.3 时间硬约束（重要）

| 事项 | 截止时间 | 后果 |
| --- | --- | --- |
| Redis 实例 crs-q2d1yf16 自动续费是开启的 | 2026-10-15 13:34 | 不手动关闭将自动扣款续一年 → 今天就关 |
| MySQL cdb-1qjqwe6f（new_bit，生产库） | 到期 2026-10-15 23:57 | 到期后数据释放。全部迁移验证必须在此之前完成 |

### 三级标题：倒排工期

1. 第 1-2 天备份
2. 第 3-6 天开发新服务
3. 第 7-9 天部署联调

- 数据完整备份、可恢复、可查
- 保留一个极简「退款门户」
  - 用户微信扫码登录后能看到自己的 UID

> [!NOTE]
> 查询工具不连数据库，它通过 HTTP 调线上 5 个端点。

#### 四级标题：关键事实

**加粗**、*斜体*、~~删除线~~、\`inline_code\` 与 [外部链接](https://github.com/vercel/streamdown)。

---

\`\`\`rust
fn main() {
    let deadline = "2026-10-15 23:57";
    println!("迁移必须在此之前完成: {deadline}");
}
\`\`\`

行内公式 $$E = mc^2$$，块公式：

$$
x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}
$$

\`\`\`mermaid
graph LR
    A[备份] --> B[开发新服务]
    B --> C[部署联调]
    C --> D[切换验证]
    D --> E[销毁旧资源]
\`\`\`

- [x] 确认 Redis 自动续费状态
- [ ] 导出生产库快照
`;

function Fixture() {
  return (
    <div className="flex h-dvh flex-col bg-background-primary-default">
      <MarkdownPreview path="/fixture/下线计划.md" draft={DOC} />
    </div>
  );
}

createRoot(document.getElementById("fixture")!).render(<Fixture />);
