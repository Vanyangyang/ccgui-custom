# @ccgui/plugin-ui

CC GUI 插件共享 UI 组件库。解决"插件 UI 全靠手搓、与宿主两套观感"的问题：宿主的设计系统是编译期的（Tailwind v4 + BoardUI 组件），插件拿不到；本包以**插件自己 bundle** 的形态提供组件，样式全部消费宿主语义 token，插件 UI 自动与宿主同观感、同深浅色。

## 兼容性

- **纯新增、opt-in**：不引入本包的插件不受任何影响；宿主零改动、SDK 无新 API、不依赖 `sdkVersion`。
- **样式通道**：组件样式是普通 CSS，插件 `import "@ccgui/plugin-ui/styles.css"` 后随自己的 `styles.css` 一起进三件套产物——走宿主 install-time 审查通道（`@layer ccgui-plugins`），**不需要 theme 权限**。
- **React**：`react` 是 peerDependency，组件被 bundle 进插件产物后与插件同一棵 React 树，不触碰双 React 树红线。
- **token 契约**：样式只消费 [`src/tokens.ts`](./src/tokens.ts) 清单里的宿主 CSS 变量。宿主承诺不重命名/删除（`src/features/plugins/plugin-ui-tokens.test.ts` 回归看守）；每条声明带 light fallback，token 意外缺失时退化为浅色默认外观而非崩坏。新增 token = 扩约（minor）；改语义/删除 = 违约（本包 major）。

## 用法

```bash
pnpm add @ccgui/plugin-ui    # 插件仓内；本地开发用 file: 指到本目录
```

```tsx
// src/main.tsx（插件入口）——先引本包样式，再引自己的，自己的覆盖在后
import "@ccgui/plugin-ui/styles.css";
import "./styles.css";

// 组件与插件同一棵 React 树，直接用
import { Button, Input, Select, Badge, Textarea } from "@ccgui/plugin-ui";

<Button variant="primary" onClick={doExport}>导出 PNG + PDF</Button>
<Button variant="secondary" size="sm">刷新</Button>
<Input placeholder="版本号" invalid={hasError} />
<Select value={file} onChange={…}>…</Select>
<Badge tone="success">已发布</Badge>
```

对话界面的气泡类（`.pui-bubble-user` / `.pui-bubble-agent`）在 `styles.css` 里，直接用类名即可，用户气泡颜色跟宿主 `--color-bubble-user`。

## 组件

| 组件 | 说明 |
|---|---|
| `Button` | `variant: primary/secondary/ghost`，`size: md/sm`；primary 复刻宿主 CTA 渐变与 hover 淡入 |
| `Input` / `Textarea` | `invalid` 走 error token；focus ring 用 `--color-border-focus-ring` |
| `Select` | 原生 select 去默认箭头 + chevron；保留原生弹出层 |
| `Badge` | `tone: neutral/accent/success/error` |

## 约束

- 不引入任何运行时依赖（无 Radix、无 Tailwind）；交互复杂的浮层组件暂不提供，避免插件 bundle 膨胀。
- 组件不写 `dark:` 分支；深浅色完全由宿主 `.dark` 翻转 token 实现。
- 新增组件样式只允许引用契约清单内的 token；需要新 token 时先扩 `src/tokens.ts` 并同步宿主 `theme.css` 与回归测试。
