import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useVirtualizer } from "@tanstack/react-virtual";
import "../../src/index.css";
import "@/lib/i18n";
import { ThinkingSurface } from "@/features/chat/components/ProcessDisclosure";
import { useScrollFollow, useTailPin } from "@/features/chat/components/use-scroll-follow";

const source = Array.from({ length: 100 }, (_, index) => `[row-${index.toString().padStart(3, "0")}] ${index % 10 < 5 ? "A long paragraph with 中文和 emoji 🙂 and code references. ".repeat(5) : "<Button disabled={pending}>"}\n`).join("");

function Harness() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [length, setLength] = useState(2100);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState("Ready");
  const virtualizer = useVirtualizer({ count: 3, getScrollElement: () => scrollRef.current, estimateSize: () => 72, overscan: 3 });
  const { isFollowing, scrollToBottom } = useScrollFollow({ scrollRef });
  useTailPin({ scrollRef, count: 3, items: [], streaming: running, isFollowing, scrollToBottom });
  useEffect(() => {
    if (!running) return;
    let sent = 2100;
    let frame = 0;
    let previous = new Map<string, number>();
    let maxDown = 0;
    let maxUp = 0;
    let backtracks = 0;
    let samples = 0;
    let previousHeight = 0;
    let maxShrink = 0;
    let prefixRetained = true;
    let settle = 0;
    const measure = () => {
      const body = scrollRef.current?.querySelector(".whitespace-pre-wrap");
      const textNode = body?.firstChild;
      const current = new Map<string, number>();
      if (body) {
        const height = body.getBoundingClientRect().height;
        maxShrink = Math.max(maxShrink, previousHeight - height);
        previousHeight = height;
        prefixRetained &&= (body.textContent ?? "").startsWith("[row-000]");
      }
      if (textNode?.nodeType === Node.TEXT_NODE) {
        for (const match of (textNode.textContent ?? "").matchAll(/\[row-\d+\]/g)) {
          const range = document.createRange();
          range.setStart(textNode, match.index!);
          range.setEnd(textNode, match.index! + match[0].length);
          const top = range.getBoundingClientRect().top;
          current.set(match[0], top);
          const before = previous.get(match[0]);
          if (before !== undefined) {
            const delta = top - before;
            maxDown = Math.max(maxDown, delta);
            maxUp = Math.max(maxUp, -delta);
            if (delta > 2) backtracks++;
          }
        }
      }
      previous = current;
      samples++;
      frame = requestAnimationFrame(measure);
    };
    frame = requestAnimationFrame(measure);
    const timer = window.setInterval(() => {
      sent += 100;
      setLength(sent);
      if (sent >= 8100) {
        clearInterval(timer);
        settle = window.setTimeout(() => {
          cancelAnimationFrame(frame);
          const complete = scrollRef.current?.querySelector(".whitespace-pre-wrap")?.textContent === source.slice(0, sent);
          setResult(JSON.stringify({ status: prefixRetained && maxShrink <= 1 && complete ? "PASS" : "FAIL", samples, backtracks, maxDown, maxUp, maxShrink, prefixRetained, complete, received: sent }));
          setRunning(false);
        }, 300);
      }
    }, 144);
    return () => { clearInterval(timer); clearTimeout(settle); cancelAnimationFrame(frame); };
  }, [running]);
  return <main style={{ width: 760, margin: "20px auto" }}>
    <button onClick={() => { setLength(2100); setResult("Running"); setRunning(true); }}>Replay thinking</button>
    <output style={{ display: "block" }}>{result}</output>
    <div ref={scrollRef} style={{ height: 650, overflowY: "auto", border: "1px solid gray" }}>
      <div data-virtual-inner style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map(row => <div key={row.key} data-index={row.index} ref={virtualizer.measureElement} style={{ position: "absolute", width: "100%", padding: 12, transform: `translateY(${row.start}px)` }}>
          {row.index === 0 ? <div style={{ height: 250 }}>bash — 已完成工具</div> : row.index === 1 ? <ThinkingSurface text={source.slice(0, length)} live /> : <p>响应中</p>}
        </div>)}
      </div>
    </div>
  </main>;
}
createRoot(document.getElementById("fixture")!).render(<Harness />);
