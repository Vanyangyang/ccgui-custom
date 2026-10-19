import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import i18n from "../../src/lib/i18n";
import Markdown from "../../src/features/chat/components/Markdown";
import budget from "../fixtures/interactive-answer/gpt-budget.md?raw";
import { Button } from "../../src/components/base/buttons/button";

const broken = '文字说明仍然保留。\n\n```ccgui-ui\nroot = Text(@OpenUrl("https://example.test"))\n```';
const slider = '```ccgui-ui\nroot = Stack([Heading("餐饮预算", "lg"), Slider($people, "人数", 1, 50, 1, "人"), Metric("餐饮费用", $people * 120, "元"), Select($kind, "活动形式", ["室内", "户外"]), Toggle($extra, "包含交通"), Text($kind), Metric("交通费用", $extra ? 300 : 0, "元")])\n$people = 12\n$kind = "室内"\n$extra = false\n```';

function Fixture() {
  const [scenario, setScenario] = useState("gpt");
  const [mounted, setMounted] = useState(true);
  const [dark, setDark] = useState(false);
  const [language, setLanguage] = useState(i18n.language);
  const [replay, setReplay] = useState<string | null>(null);
  const source = replay ?? (scenario === "broken" ? broken : scenario === "controls" ? slider : budget);
  const stream = () => {
    setScenario("gpt"); setReplay(""); let offset = 0;
    const timer = setInterval(() => {
      offset += 80;
      if (offset >= budget.length) { clearInterval(timer); setReplay(null); }
      else setReplay(budget.slice(0, offset));
    }, 30);
  };
  return <main className="min-h-dvh bg-background-primary-default px-3 py-8 text-text-primary">
    <div className="mx-auto max-w-[750px]">
      <header className="mb-6 space-y-3">
        <h1 className="text-heading-3">GPT 交互式回答试用</h1>
        <p className="text-body-2-regular text-text-secondary">下面是一次真实 GPT 生成的预算工具。调整参数即可试用；此预览不会再次调用模型。</p>
        <div className="flex flex-wrap gap-2">
          <Button size="small" variant="secondary" onClick={() => { setScenario("gpt"); setReplay(null); }}>GPT 预算示例</Button>
          <Button size="small" variant="secondary" onClick={() => { setScenario("controls"); setReplay(null); }}>控件示例</Button>
          <Button size="small" variant="secondary" onClick={() => { setScenario("broken"); setReplay(null); }}>异常回退</Button>
          <Button size="small" variant="secondary" onClick={stream} disabled={replay !== null}>回放生成过程</Button>
          <Button size="small" variant="secondary" onClick={() => { document.documentElement.classList.toggle("dark", !dark); setDark(!dark); }}>{dark ? "浅色" : "深色"}</Button>
          <Button size="small" variant="secondary" onClick={() => { const next = language.startsWith("zh") ? "en" : "zh"; void i18n.changeLanguage(next); setLanguage(next); }}>{language.startsWith("zh") ? "English" : "中文"}</Button>
          <Button size="small" variant="secondary" onClick={() => setMounted(value => !value)}>{mounted ? "暂时收起回答" : "重新显示回答"}</Button>
        </div>
      </header>
      {mounted && <Markdown text={source} workspacePath="/interactive-answer-fixture" streaming={replay !== null} interactive interactiveIdentity={`fixture-${scenario}`} />}
      <p className="mt-8 text-caption-1-regular text-text-tertiary">参数在本页内保留；刷新后恢复初始值。这里验证界面，生产接入入口是 Codex 会话中的 /ui。</p>
    </div>
  </main>;
}
createRoot(document.getElementById("fixture")!).render(<Fixture />);
