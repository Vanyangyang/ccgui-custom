import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useVirtualizer } from "@tanstack/react-virtual";
import "../../src/index.css";
import "@/lib/i18n";
import Markdown from "@/features/chat/components/Markdown";
import { useScrollFollow, useTailPin } from "@/features/chat/components/use-scroll-follow";

const unit = "稳定文字与 emoji 🙂 不应丢失。Already displayed text stays intact. **粗体** 与 `inline code`。\n\n";
const source = unit.repeat(45);

function Harness() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [length, setLength] = useState(0);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState("Ready");
  const samples = useRef({ observations: 0, gaps: 0, maxGap: 0 });
  const live = running && length < source.length;
  const tool = length >= 1500;
  const count = tool ? 23 : 22;
  const virtualizer = useVirtualizer({ count, getScrollElement: () => scrollRef.current, estimateSize: () => 72, overscan: 8 });
  const { isFollowing, scrollToBottom, resumeFollow } = useScrollFollow({ scrollRef });
  useTailPin({ scrollRef, count, items: [], streaming: live, isFollowing, scrollToBottom });

  useLayoutEffect(() => {
    const inner = scrollRef.current?.querySelector("[data-virtual-inner]");
    if (!inner) return;
    const observer = new ResizeObserver(() => {
      const element = scrollRef.current!;
      if (!running || !isFollowing()) return;
      const gap = Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);
      samples.current.observations++;
      if (gap > 1) samples.current.gaps++;
      samples.current.maxGap = Math.max(samples.current.maxGap, gap);
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [running, isFollowing]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setLength(value => Math.min(source.length, value + 100)), 144);
    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (!running || live) return;
    const timer = window.setTimeout(() => {
      const expectedText = source.replaceAll("**", "").replaceAll("`", "").replaceAll("\n\n", "\n").trim();
      const complete = scrollRef.current?.querySelector(".prose-chat")?.textContent?.trim() === expectedText;
      setResult(JSON.stringify({ status: samples.current.gaps === 0 && complete ? "PASS" : "FAIL", ...samples.current, complete, received: length, expected: source.length }));
      setRunning(false);
    }, 400);
    return () => clearTimeout(timer);
  }, [running, live, length]);

  return <main style={{ width: 760, margin: "20px auto" }}>
    <button onClick={() => { samples.current = { observations: 0, gaps: 0, maxGap: 0 }; setLength(0); setResult("Running"); setRunning(true); resumeFollow(); }}>Replay 100 chars / 144ms</button>
    <button onClick={resumeFollow}>Resume follow</button>
    <output style={{ display: "block" }}>{result}</output>
    <div ref={scrollRef} style={{ height: 440, overflowY: "auto", border: "1px solid gray" }}>
      <div data-virtual-inner style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map(row => <div key={row.key} data-index={row.index} ref={virtualizer.measureElement} style={{ position: "absolute", width: "100%", padding: 12, transform: `translateY(${row.start}px)` }}>
          {row.index < 20 ? <p>历史消息 {row.index}：保持已完成内容不变。</p> : row.index === 20 ? <Markdown text={source.slice(0, length)} workspacePath="" streaming={live} /> : tool && row.index === 21 ? <div style={{ height: 110 }}>read SessionTabStrip.tsx — 工具结果</div> : <p>响应中</p>}
        </div>)}
      </div>
    </div>
  </main>;
}

createRoot(document.getElementById("fixture")!).render(<Harness />);
