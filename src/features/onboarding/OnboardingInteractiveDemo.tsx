import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Bell from "lucide-react/dist/esm/icons/bell";
import Check from "lucide-react/dist/esm/icons/check";
import FolderCode from "lucide-react/dist/esm/icons/folder-code";
import Pause from "lucide-react/dist/esm/icons/pause";
import Play from "lucide-react/dist/esm/icons/play";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import Sparkles from "lucide-react/dist/esm/icons/sparkles";
import { cx } from "@/utils/cx";
import type { OnboardingTopicId } from "./store";

interface OnboardingInteractiveDemoProps {
  topic: OnboardingTopicId;
  stepIndex: number;
}

const STAGE_COUNT = 3;
const AUTO_INTERVAL_MS = 2600;

export function OnboardingInteractiveDemo({
  topic,
  stepIndex,
}: OnboardingInteractiveDemoProps) {
  const { i18n } = useTranslation();
  const isEn = i18n.language?.startsWith("en");

  const [stage, setStage] = useState(0);
  const [autoPlay, setAutoPlay] = useState(true);

  // Interactive states for hands-on sandbox controls
  const [proxyPreset, setProxyPreset] = useState<"7897" | "7890" | "10809">("7897");
  const [selfDevRemoveConsented, setSelfDevRemoveConsented] = useState(false);
  const [handoffMode, setHandoffMode] = useState<"smart" | "local" | "excerpt">("smart");
  const [sidechatMode, setSidechatMode] = useState<"readonly" | "execute">("readonly");
  const [activeBox, setActiveBox] = useState<1 | 2>(1);
  const [iuiWorkers, setIuiWorkers] = useState(6);
  const [iuiStrategy, setIuiStrategy] = useState<"conservative" | "balanced" | "aggressive">("balanced");
  const [iuiApplied, setIuiApplied] = useState(false);

  // Reset stage when topic or stepIndex changes
  useEffect(() => {
    setStage(stepIndex % STAGE_COUNT);
    setAutoPlay(true);
    setIuiApplied(false);
    setSelfDevRemoveConsented(false);
  }, [topic, stepIndex]);

  // Auto-cycle stages (Option 2 advantage: effortless animated step-by-step demo)
  useEffect(() => {
    if (!autoPlay) return;
    if (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      setStage((prev) => {
        const next = (prev + 1) % STAGE_COUNT;
        if (topic === "intelligenceUi") {
          setIuiWorkers(next === 0 ? 4 : next === 1 ? 8 : 12);
          setIuiStrategy(
            next === 0 ? "conservative" : next === 1 ? "balanced" : "aggressive",
          );
        }
        if (topic === "handoff") {
          setHandoffMode(next === 0 ? "smart" : next === 1 ? "local" : "excerpt");
        }
        if (topic === "sidechat") {
          setSidechatMode(next === 1 ? "execute" : "readonly");
        }
        if (topic === "imageAnnotation") {
          setActiveBox(next === 1 ? 2 : 1);
        }
        return next;
      });
    }, AUTO_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [autoPlay, topic]);

  const handleManualStage = (idx: number) => {
    setAutoPlay(false);
    setStage(idx);
  };

  const stageLabels: Record<OnboardingTopicId, [string, string, string]> = isEn
    ? {
        proxy: ["1. Default Direct", "2. Optional Port", "3. Ask AI Screenshot"],
        selfUpdate: ["1. GitHub & DIY", "2. 1-Click Build & Update", "3. Removal Guard"],
        handoff: ["1. Context Ring / /handoff", "2. Pick Summary", "3. Switch CLI & Continue"],
        sidechat: ["1. Parallel Split", "2. Read-Only / Execute", "3. Paste Image / Promote"],
        btw: ["1. Quick /btw Ask", "2. Instant Card", "3. Zero History Pollution"],
        imageAnnotation: ["1. Click Annotate", "2. Draw Red Boxes #1-#9", "3. Add to Draft"],
        assistantNotices: ["1. Task Done Bell", "2. AI Aside Card", "3. Insert to Draft"],
        intelligenceUi: ["1. AI Renders Controls", "2. Drag Sliders Live", "3. Apply Parameters"],
      }
    : {
        proxy: ["1. 默认直连无拦截", "2. 按需改端口", "3. 截图发 AI 问配置"],
        selfUpdate: ["1. GitHub 与 DIY", "2. 一键构建并热更新", "3. 移除防误删确认"],
        handoff: ["1. 上下文环 / /handoff", "2. 选压缩模式", "3. 换模型接力新会话"],
        sidechat: ["1. 右侧分栏旁聊", "2. 只读 / 可执行切换", "3. 贴图追问或转独立"],
        btw: ["1. 顺带一问 /btw", "2. 浮卡秒回", "3. 零上下文污染"],
        imageAnnotation: ["1. 预览点「批注」", "2. 画红框写说明", "3. 一键加入草稿"],
        assistantNotices: ["1. 完成提醒铃铛", "2. AI 主动旁白", "3. 一键带入草稿"],
        intelligenceUi: ["1. 生成动态控件", "2. 拖动滑杆实时测算", "3. 参数带回草稿"],
      };

  const labels = stageLabels[topic];

  return (
    <div
      data-testid="onboarding-interactive-demo"
      className="mt-1.5 overflow-hidden rounded-lg border border-border-secondary bg-bg-secondary/70"
    >
      {/* Top stage switcher + Auto/Interactive mode toggle */}
      <div className="flex items-center justify-between gap-1.5 border-b border-border-secondary bg-bg-primary/60 px-2.5 py-1.5">
        <div className="flex items-center gap-1 overflow-x-auto">
          {labels.map((label, idx) => {
            const active = stage === idx;
            return (
              <button
                key={label}
                type="button"
                data-testid={`onboarding-demo-stage-${idx}`}
                onClick={() => handleManualStage(idx)}
                className={cx(
                  "rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap transition-colors duration-150 cursor-pointer",
                  active
                    ? "bg-bg-brand-secondary text-text-brand-secondary"
                    : "text-text-tertiary hover:bg-bg-primary_hover hover:text-text-secondary",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          data-testid="onboarding-demo-autoplay-toggle"
          onClick={() => setAutoPlay((v) => !v)}
          title={
            autoPlay
              ? isEn
                ? "Auto-playing walkthrough (click to pause)"
                : "正在自动循环演练（点击可暂停手动操作）"
              : isEn
                ? "Interactive mode (click to resume auto-play)"
                : "手动交互模式（点击恢复自动循环演练）"
          }
          className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-text-tertiary transition-colors duration-150 hover:bg-bg-primary_hover hover:text-text-primary cursor-pointer"
        >
          {autoPlay ? (
            <>
              <Pause className="size-3 text-fg-brand-primary" />
              <span>{isEn ? "Auto" : "自动演练"}</span>
            </>
          ) : (
            <>
              <Play className="size-3" />
              <span>{isEn ? "Manual" : "手动操作"}</span>
            </>
          )}
        </button>
      </div>

      {/* Interactive + Animated Stage Body */}
      <div className="p-2.5 text-xs">
        {topic === "proxy" && (
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-md border border-border-secondary bg-bg-primary px-2.5 py-1.5">
              <div className="flex items-center gap-2">
                <span
                  className={cx(
                    "inline-block size-2 rounded-full",
                    stage === 0 ? "bg-fg-success-primary" : "bg-fg-brand-primary",
                  )}
                />
                <span className="font-medium text-text-primary">
                  {stage === 0
                    ? isEn
                      ? "Default: No forced proxy gate"
                      : "默认状态：无强制代理拦截（直连可用）"
                    : stage === 1
                      ? isEn
                        ? `Custom Proxy: http://127.0.0.1:${proxyPreset}`
                        : `自定义代理：http://127.0.0.1:${proxyPreset}`
                      : isEn
                        ? "Screenshot → Ask Local AI"
                        : "截图当前页 + 代理软件 → 询问本机 AI"}
                </span>
              </div>
              <div className="flex items-center gap-1">
                {(["7897", "7890", "10809"] as const).map((port) => (
                  <button
                    key={port}
                    type="button"
                    onClick={() => {
                      setAutoPlay(false);
                      setStage(1);
                      setProxyPreset(port);
                    }}
                    className={cx(
                      "rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors duration-150 cursor-pointer",
                      proxyPreset === port && stage === 1
                        ? "bg-bg-brand-solid text-text-white"
                        : "bg-bg-secondary text-text-secondary hover:text-text-primary",
                    )}
                  >
                    :{port}
                  </button>
                ))}
              </div>
            </div>
            {stage === 2 && (
              <div className="rounded-md border border-accent-300/40 bg-bg-brand-secondary/30 px-2.5 py-1.5 text-[11px] text-text-secondary">
                {isEn
                  ? 'AI Reply: "Your Clash mixed port is 7890 — enter http://127.0.0.1:7890 and click Save."'
                  : "🤖 本机 AI 回复示例：「看到你截图里的混合端口是 7890，在代理地址填入 http://127.0.0.1:7890 点击保存即可！」"}
              </div>
            )}
          </div>
        )}

        {topic === "selfUpdate" && (
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-md border border-status-purple-border/60 bg-status-purple-bg/20 px-2.5 py-1.5">
              <div className="flex items-center gap-2">
                <FolderCode className="size-4 text-status-purple-text" />
                <span className="font-medium text-text-primary">ccgui-custom</span>
                <span className="rounded-sm bg-status-purple-bg px-1.5 py-0.5 text-[10px] font-medium text-status-purple-text">
                  {isEn ? "Self-Dev" : "自开发"}
                </span>
              </div>
              <span className="text-[11px] text-text-tertiary">
                {stage === 0
                  ? isEn
                    ? "git clone · DIY Here"
                    : "GitHub 克隆 · DIY 专属工程"
                  : stage === 1
                    ? isEn
                      ? "Build & Live Update Button"
                      : "一键「构建并热更新」按钮"
                    : isEn
                      ? "Removal Consent Guard"
                      : "防误删知情确认弹窗"}
              </span>
            </div>

            {stage !== 2 ? (
              <div className="flex items-center justify-between gap-2 rounded-md bg-bg-primary/70 px-2.5 py-1.5">
                <span className="text-[11px] text-text-secondary">
                  {stage === 0
                    ? isEn
                      ? "① Clone from GitHub (`pnpm maint:build` for first install). To DIY CC GUI, chat directly in `ccgui-custom [Self-Dev]`!"
                      : "① 首次从 GitHub 克隆可执行 `pnpm maint:build` 安装；后续想自己 DIY 改造客户端，直接在 `ccgui-custom [自开发]` 发会话让 AI 修改！"
                    : isEn
                      ? "② AI edits auto-light \"Ready to update\", or click \"Build & Live Update\" in Settings → Workspaces anytime after `git pull`!"
                      : "② AI 改完会对状态栏登记「待更新」；若手动 `git pull` 或改码，也可在「设置 → 工作区」点「构建并热更新」一键无感热切换！"}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setAutoPlay(false);
                    setStage((s) => (s + 1) % STAGE_COUNT);
                  }}
                  className="inline-flex shrink-0 items-center gap-1 rounded bg-bg-brand-secondary px-2 py-0.5 text-[11px] font-medium text-text-brand-secondary cursor-pointer"
                >
                  <RefreshCw className="size-3" />
                  {isEn ? "Next" : "下一步"}
                </button>
              </div>
            ) : (
              <div
                data-testid="onboarding-demo-self-dev-remove-guard"
                className="space-y-1.5 rounded-md border border-status-purple-border bg-status-purple-bg/30 p-2"
              >
                <div className="text-[11px] font-medium text-status-purple-text">
                  {isEn
                    ? "🛡️ Notice when removing: Dedicated DIY self-dev directory (disk files stay intact; reopen anytime in Settings → Workspaces)."
                    : "🛡️ 移除时弹出紫色「须知」：这是 CC GUI 专属 DIY 自开发工程目录（不删磁盘文件，下次可在「设置 → 工作区」重新打开）。"}
                </div>
                <div className="flex items-center justify-between gap-2 pt-0.5">
                  <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-text-primary">
                    <input
                      type="checkbox"
                      checked={selfDevRemoveConsented}
                      onChange={(e) => {
                        setAutoPlay(false);
                        setSelfDevRemoveConsented(e.target.checked);
                      }}
                      className="size-3.5 rounded accent-brand-primary"
                    />
                    <span>
                      {isEn
                        ? "I understand & confirm removal (try checking)"
                        : "必须勾选「我已知悉…」才解锁移除（可点击体验）"}
                    </span>
                  </label>
                  <span
                    className={cx(
                      "shrink-0 rounded px-2 py-0.5 text-[10px] font-semibold transition-opacity duration-150",
                      selfDevRemoveConsented
                        ? "bg-bg-error-solid text-text-white opacity-100"
                        : "bg-bg-error-solid/40 text-text-white/60 opacity-60",
                    )}
                  >
                    {isEn ? "Confirm removal" : "确认移除"}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {topic === "handoff" && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between rounded-md border border-border-secondary bg-bg-primary px-2.5 py-1.5">
              <span className="text-[11px] text-text-secondary">
                {stage === 0
                  ? isEn
                    ? "Trigger from bottom-right Context Ring popover or `/handoff`"
                    : "点击右下角「上下文圆环 → 归档并交接」或输入 `/handoff` 即可唤出交接卡"
                  : stage === 1
                    ? isEn
                      ? "Pick compression mode below:"
                      : "自由选择交接压缩方式："
                    : isEn
                      ? "Switch CLI / Model (e.g. Claude → Codex/AGY) & archive old chat"
                      : "发送前可直接在左下角切换接管 CLI 与模型，无缝继续任务"}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                {(
                  [
                    ["smart", isEn ? "Smart" : "智能压缩"],
                    ["local", isEn ? "Local" : "本地结论"],
                    ["excerpt", isEn ? "Excerpt" : "多轮摘录"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setAutoPlay(false);
                      setHandoffMode(id);
                    }}
                    className={cx(
                      "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors duration-150 cursor-pointer",
                      handoffMode === id
                        ? "bg-bg-brand-solid text-text-white"
                        : "bg-bg-secondary text-text-secondary hover:text-text-primary",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <p className="px-1 text-[11px] text-text-tertiary">
              {handoffMode === "smart"
                ? isEn
                  ? "Distills core decisions, modified files, and next steps into a fresh session."
                  : "自动提炼核心结论、已改文件与下一步待办带入新会话。"
                : handoffMode === "local"
                  ? isEn
                    ? "0-token instant local conclusion extraction."
                    : "0 Token 毫秒级提取最近结论与目标。"
                  : isEn
                    ? "Preserves verbatim recent turns for code handoff."
                    : "保留最近多轮关键对话原文接力。"}
            </p>
          </div>
        )}

        {topic === "sidechat" && (
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-md border border-border-secondary bg-bg-primary p-2">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-text-primary">
                <span className="inline-block size-2 rounded-full bg-fg-brand-primary" />
                {isEn ? "Main Chat (Running)" : "主对话（流式执行中）"}
              </div>
              <p className="mt-1 text-[11px] text-text-tertiary">
                {isEn
                  ? "Main task continues uninterrupted."
                  : "主任务持续运行，上下文不被旁支问题打断。"}
              </p>
            </div>
            <div className="rounded-md border border-accent-300/60 bg-bg-brand-secondary/25 p-2">
              <div className="flex items-center justify-between text-[11px] font-medium text-text-brand-secondary">
                <span>{isEn ? "Sidechat Split" : "右侧旁聊分屏"}</span>
                <div className="flex items-center gap-1">
                  {(
                    [
                      ["readonly", isEn ? "Read-only" : "只读"],
                      ["execute", isEn ? "Execute" : "可执行"],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => {
                        setAutoPlay(false);
                        setSidechatMode(mode);
                      }}
                      className={cx(
                        "rounded px-1.5 py-0.5 text-[10px] font-medium cursor-pointer",
                        sidechatMode === mode
                          ? "bg-bg-brand-solid text-text-white"
                          : "bg-bg-primary text-text-secondary",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="mt-1 text-[11px] text-text-secondary">
                {sidechatMode === "readonly"
                  ? isEn
                    ? "Default Read-only: ask questions & paste screenshots safely."
                    : "默认只读讨论与贴图提问；结论可插回主输入框或转独立页签。"
                  : isEn
                    ? "Execute mode: inherits main chat permissions to run tools."
                    : "可执行模式：沿用主对话当前权限，可在旁聊中直接执行操作。"}
              </p>
            </div>
          </div>
        )}

        {topic === "btw" && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between rounded-md border border-border-secondary bg-bg-primary px-2.5 py-1.5">
              <code className="font-mono text-[11px] text-fg-brand-primary">
                /btw {isEn ? "what is Rust PathBuf to String?" : "Rust 里 PathBuf 怎么转 String？"}
              </code>
              <span className="rounded bg-bg-secondary px-1.5 py-0.5 text-[10px] text-text-tertiary">
                {isEn ? "Main Context +0 tokens" : "主对话历史 0 写入"}
              </span>
            </div>
            <div className="rounded-md border border-border-secondary bg-bg-primary px-2.5 py-1.5 text-[11px] text-text-secondary">
              {stage === 0
                ? isEn
                  ? "① Ask a quick syntax question inline while the main agent works."
                  : "① 主任务运行中随时穿插查语法/命令"
                : stage === 1
                  ? isEn
                    ? "② Pop-up card answers instantly: `path.to_string_lossy().into_owned()`"
                    : "② 输入框上方浮卡秒回：`path.to_string_lossy().into_owned()`"
                  : isEn
                    ? "③ Close card when done — zero pollution to main transcript!"
                    : "③ 看完即关，绝不污染主对话上下文！"}
            </div>
          </div>
        )}

        {topic === "imageAnnotation" && (
          <div
            data-testid="onboarding-demo-image-annotation"
            className="space-y-1.5 rounded-md border border-border-secondary bg-bg-primary p-2"
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-text-primary">
                {isEn
                  ? "Image Lightbox → Click \"Annotate\" (Up to 9 boxes)"
                  : "点开任意图片预览 → 点「批注」拖拽画红框（最多 9 处）"}
              </span>
              <div className="flex items-center gap-1">
                {([1, 2] as const).map((num) => (
                  <button
                    key={num}
                    type="button"
                    onClick={() => {
                      setAutoPlay(false);
                      setActiveBox(num);
                    }}
                    className={cx(
                      "rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold cursor-pointer",
                      activeBox === num
                        ? "border-fg-error-primary bg-bg-error-solid text-text-white"
                        : "border-fg-error-primary/50 text-fg-error-primary",
                    )}
                  >
                    #{num}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 rounded bg-bg-secondary/70 px-2 py-1 text-[11px] text-text-secondary">
              <span>
                {activeBox === 1
                  ? isEn
                    ? "Box #1 (12%–38%): \"Align this button to the right\""
                    : "红框 #1 (12%–38%)：「把这个按钮右对齐」"
                  : isEn
                    ? "Box #2 (54%–82%): \"Tighten card padding here\""
                    : "红框 #2 (54%–82%)：「收紧这里的卡片内边距」"}
              </span>
              <span className="shrink-0 rounded bg-bg-brand-secondary px-1.5 py-0.5 text-[10px] font-medium text-text-brand-secondary">
                {isEn ? "Add to Draft" : "加入草稿"}
              </span>
            </div>
          </div>
        )}

        {topic === "assistantNotices" && (
          <div className="rounded-md border border-border-secondary bg-bg-primary p-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Bell className="size-3.5 text-fg-brand-primary" />
                <span className="text-[11px] font-semibold text-text-primary">
                  {stage === 0
                    ? isEn
                      ? "Completion Reminder · ccgui-custom"
                      : "任务完成提醒 · ccgui-custom"
                    : isEn
                      ? "AI Aside · Gemini 4 Argon · medium"
                      : "AI 主动旁白 · Gemini 4 Argon · medium"}
                </span>
              </div>
              <span className="rounded bg-bg-brand-secondary px-1.5 py-0.5 text-[10px] font-medium text-text-brand-secondary">
                {stage === 0 ? (isEn ? "Completed" : "已完成") : "18s"}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-text-secondary">
              {stage === 0
                ? isEn
                  ? "Background session finished verification. Click to jump straight to source chat."
                  : "后台会话已完成构建与测试验证，点击卡片即可一键跳回来源会话。"
                : stage === 1
                  ? isEn
                    ? "Aside observation: Tri-state proxy setting verified; ready for self-update."
                    : "旁白观察：「已完成代理三态保持与引导改造，建议直接发起自更新验收。」"
                  : isEn
                    ? "Appended to composer draft without auto-sending!"
                    : "已将旁白建议追加到当前输入框草稿（不自动发送，由你把关）！"}
            </p>
          </div>
        )}

        {topic === "intelligenceUi" && (
          <div
            data-testid="onboarding-iui-sandbox"
            className="space-y-2 rounded-md border border-border-secondary bg-bg-primary p-2.5"
          >
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-text-primary">
                <Sparkles className="size-3.5 text-fg-brand-primary" />
                {isEn
                  ? "Live Mini Intelligence UI (Try dragging!)"
                  : "迷你 Intelligence UI 交互卡（可直接拖动体验！）"}
              </span>
              <span className="font-mono text-[11px] text-fg-brand-primary">
                {isEn ? `Est. Speedup: ${(iuiWorkers * (iuiStrategy === "aggressive" ? 1.4 : iuiStrategy === "balanced" ? 1.15 : 0.9)).toFixed(1)}x` : `预计提速：${(iuiWorkers * (iuiStrategy === "aggressive" ? 1.4 : iuiStrategy === "balanced" ? 1.15 : 0.9)).toFixed(1)}x`}
              </span>
            </div>

            {/* Interactive slider */}
            <div className="flex items-center gap-2">
              <label
                htmlFor="onboarding-iui-slider"
                className="w-20 shrink-0 text-[11px] text-text-secondary"
              >
                {isEn ? `Workers: ${iuiWorkers}` : `并发数: ${iuiWorkers}`}
              </label>
              <input
                id="onboarding-iui-slider"
                data-testid="onboarding-iui-slider"
                type="range"
                min={1}
                max={16}
                value={iuiWorkers}
                onChange={(e) => {
                  setAutoPlay(false);
                  setIuiApplied(false);
                  setIuiWorkers(Number(e.target.value));
                }}
                className="h-1.5 flex-1 accent-fg-brand-primary cursor-pointer"
              />
            </div>

            {/* Interactive strategy pills + apply button */}
            <div className="flex items-center justify-between gap-2 pt-0.5">
              <div className="flex items-center gap-1">
                {(
                  [
                    ["conservative", isEn ? "Safe" : "保守"],
                    ["balanced", isEn ? "Balanced" : "均衡"],
                    ["aggressive", isEn ? "Fast" : "激进"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setAutoPlay(false);
                      setIuiApplied(false);
                      setIuiStrategy(id);
                    }}
                    className={cx(
                      "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors duration-150 cursor-pointer",
                      iuiStrategy === id
                        ? "bg-bg-brand-solid text-text-white"
                        : "bg-bg-secondary text-text-secondary hover:text-text-primary",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                data-testid="onboarding-iui-apply"
                onClick={() => {
                  setAutoPlay(false);
                  setIuiApplied(true);
                }}
                className="inline-flex items-center gap-1 rounded bg-bg-brand-secondary px-2 py-0.5 text-[10px] font-medium text-text-brand-secondary cursor-pointer"
              >
                {iuiApplied ? (
                  <>
                    <Check className="size-3" />
                    {isEn ? "Added to Draft!" : "已追加至草稿预览！"}
                  </>
                ) : isEn ? (
                  "Continue with Params"
                ) : (
                  "使用这些参数继续讨论"
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
