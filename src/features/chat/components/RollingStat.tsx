/**
 * 「已编辑」pill 上 +N / −N 的数字滚动：自实现 odometer（逐位 0-9 滚动条 + translateY）。
 *
 * 历史：该动画最初来自参考工程 `features/composer/components/run-status/RollingStat.tsx`。
 * 早期实现基于 @number-flow/react，其 shadow DOM 依赖 CSS mask / mix-blend-mode:
 * plus-lighter / will-change / mod() 等重型特性，在 Windows WebView2 上符号与首位数字
 * 长期重叠错位（Mac 正常、本地不可复现），故改为纯 CSS transition——无 mask、无
 * blend-mode、无 will-change。v1.0.0 重构把运行态条迁到 features/chat 时漏掉了本组件，
 * 这里按同一契约补回，样式改为 Tailwind 类，不再单独维护一份 CSS 文件。
 *
 * 注意：
 * - 每位数字列挂载或 digit 变化时，经一帧 RAF 切到目标位，由 CSS transition 完成滚动。
 * - 首挂 displayValue 为 0，经双 RAF 切到目标 value，形成「从 0 起滚」。
 * - prefers-reduced-motion 时 transition 关闭，直接跳变（motion-reduce:transition-none）。
 * - 数字列全部 aria-hidden，语义值由根节点 role="img" + aria-label 固定，屏读与
 *   测试读的是目标值而不是滚动条内容。
 */
import { memo, useEffect, useRef, useState } from "react";
import { cx } from "@/utils/cx";

/** 略放慢，方便肉眼观察位滚动 */
const DEFAULT_DURATION_MS = 900;
const CELLS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

export type RollingStatProps = {
  value: number;
  /** 前缀，如 "+" / "−" */
  prefix?: string;
  className?: string;
  /** 滚动时长（ms），映射到滚动条的 transition-duration */
  durationMs?: number;
  /** 测试与 a11y：固定最终语义值 */
  "data-testid"?: string;
};

/** 单个数字位：0-9 纵向滚动条，translateY(-N em) 选中当前位 */
function DigitColumn({ digit, durationMs }: { digit: number; durationMs: number }) {
  // 首挂从 0 起滚；digit 变化时从当前位滚到目标位
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (shown === digit) return;
    const id = window.requestAnimationFrame(() => setShown(digit));
    return () => window.cancelAnimationFrame(id);
  }, [digit, shown]);

  return (
    <span className="inline-block h-[1em] overflow-hidden" data-rolling-digit aria-hidden>
      <span
        className="flex flex-col transition-transform ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
        style={{
          transform: `translateY(-${shown}em)`,
          transitionDuration: `${Math.max(0, durationMs)}ms`,
        }}
      >
        {CELLS.map((d) => (
          <span key={d} className="block h-[1em] leading-none">
            {d}
          </span>
        ))}
      </span>
    </span>
  );
}

export const RollingStat = memo(function RollingStat({
  value,
  prefix = "",
  className,
  durationMs = DEFAULT_DURATION_MS,
  "data-testid": testId,
}: RollingStatProps) {
  const target = Math.max(0, Math.round(value));
  // 首挂非 0 时从 0 起滚；后续更新从当前 display 滚到新 value
  const [displayValue, setDisplayValue] = useState(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let outer = 0;
    let inner = 0;

    // 首挂目标就是 0：display 已经是 0，无需滚动；只记录已应用，避免在
    // effect 里同步 setState。
    if (!mountedRef.current && target === 0) {
      mountedRef.current = true;
      return;
    }

    // 首挂：先确保 0 已 paint，再设目标（触发滚动动画）
    // 后续：同样经两帧设目标（display 已是旧值，过渡起点已 paint）
    outer = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(() => {
        if (cancelled) return;
        setDisplayValue(target);
        mountedRef.current = true;
      });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(outer);
      window.cancelAnimationFrame(inner);
    };
  }, [target]);

  const digits = String(displayValue).split("").map(Number);

  return (
    <span
      className={cx("inline-flex items-center leading-none", className)}
      data-testid={testId}
      data-value={target}
      data-display-value={displayValue}
      role="img"
      aria-label={`${prefix}${target}`}
    >
      {prefix ? (
        <span className="shrink-0" aria-hidden>
          {prefix}
        </span>
      ) : null}
      {digits.map((d, i) => (
        // key 用「从右往左的位序」，位数增长时新列挂左侧、已有列保持滚动状态
        <DigitColumn key={digits.length - 1 - i} digit={d} durationMs={durationMs} />
      ))}
    </span>
  );
});
