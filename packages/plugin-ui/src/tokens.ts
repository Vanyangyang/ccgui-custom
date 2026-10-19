/**
 * 宿主语义 token 公开契约（兼容承诺）。
 *
 * plugin-ui 的全部样式只消费这份清单里的 CSS 自定义属性；宿主
 * （desktop-cc-gui src/styles/theme.css）承诺：
 *   1. 不重命名、不删除清单内的 token；
 *   2. 语义 token 在 light 与 .dark 下都有定义（组件不写 dark: 分支，
 *      深浅色完全跟随宿主 token 翻转）。
 *
 * 每条样式声明都带 light 主题的 fallback 值（var(--token, fallback)），
 * 因此 token 意外缺失时插件退化为浅色默认外观，而不是崩坏。
 *
 * 宿主侧回归测试：src/features/plugins/plugin-ui-tokens.test.ts
 * 逐条断言 theme.css 仍定义这些 token——重命名会立刻红。
 *
 * 新增 token = 扩约（minor）；改语义/删除 = 违约（本包发 major）。
 */
export const PLUGIN_UI_TOKEN_CONTRACT = [
  /* 字体 / 形状 / 阴影（@theme 层，全主题常量） */
  "--font-sans",
  "--radius-2lg",
  "--shadow-card",
  "--shadow-dropdown",
  /* 文本 */
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-tertiary",
  "--color-text-placeholder",
  "--color-text-white",
  "--color-text-error-primary",
  "--color-notification-success-foreground",
  /* 背景 */
  "--color-background-primary-default",
  "--color-background-secondary-default",
  "--color-background-tertiary-default",
  "--color-background-tertiary-hover",
  /* 边框 */
  "--color-border-button-default",
  "--color-border-button-hover",
  "--color-separator-border",
  "--color-border-focus-ring",
  "--color-border-error-default",
  /* 强调色 / 气泡 */
  "--color-accent-500",
  "--color-accent-600",
  "--color-bubble-user",
  /* 主按钮渐变与禁用态 */
  "--gradient-button-primary-default",
  "--gradient-button-primary-hover",
  "--gradient-button-primary-active",
  "--gradient-button-primary-disabled",
  "--color-button-primary-disabled-foreground",
] as const;

export type PluginUiToken = (typeof PLUGIN_UI_TOKEN_CONTRACT)[number];
