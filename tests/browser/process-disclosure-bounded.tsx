import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import i18n from "@/lib/i18n";
import { ProcessDisclosure, type ProcessSearchTarget } from "@/features/chat/components/ProcessDisclosure";
import type { ProcessItem } from "@/features/chat/components/timeline-rows";

const tools: ProcessItem[] = Array.from({ length: 540 }, (_, index) => ({
  type: "tool",
  text: `工具 ${index} 中文 👨‍👩‍👧‍👦`,
  args: { command: `读取 ${index} 🙂` },
  result: `结果 ${index} ✅`,
}));

function Harness() {
  const [count, setCount] = useState(120);
  const [generation, setGeneration] = useState(0);
  const [searchTarget, setSearchTarget] = useState<ProcessSearchTarget>();
  const seenTools = useRef(new Set<string>());
  const reset = (nextCount: number) => {
    seenTools.current = new Set();
    setCount(nextCount);
    setGeneration((value) => value + 1);
    setSearchTarget(undefined);
  };
  const find = (itemIndex: number) => setSearchTarget((previous) => ({ itemIndex, requestKey: String(Number(previous?.requestKey ?? 0) + 1) }));
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1>有界过程历史验证</h1>
      <div className="my-4 flex gap-4">
        <button onClick={() => reset(120)}>120 tools</button>
        <button onClick={() => reset(500)}>500 tools</button>
        <button onClick={() => setCount((value) => Math.min(value + 40, tools.length))}>Append 40</button>
        <button onClick={() => find(0)}>Find first tool</button>
        <button onClick={() => find(count - 1)}>Find last tool</button>
      </div>
      <div data-process-fixture>
        <ProcessDisclosure key={generation} items={tools.slice(0, count)} autoExpand processId={generation} seenTools={seenTools.current} searchTarget={searchTarget} />
      </div>
    </main>
  );
}

void i18n.changeLanguage("zh").then(() => {
  createRoot(document.getElementById("fixture")!).render(<Harness />);
});
