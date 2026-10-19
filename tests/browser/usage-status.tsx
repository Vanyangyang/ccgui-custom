// Production components with document-local IPC/storage; never starts a model.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { StatusBar } from "../../src/components/application/ai-chat/ai-chat-composer";
import { CodexQuotaStatus } from "../../src/features/chat/components/CodexQuotaStatus";
import { useCodexQuota } from "../../src/features/chat/components/use-codex-quota";
import { ThroughputStatus } from "../../src/features/chat/components/ThroughputStatus";
import { AgyQuotaStatus } from "../../src/features/chat/components/AgyQuotaStatus";
import { selectAgyContext } from "../../src/features/chat/components/agy-context";
import { beginThroughput, type ThroughputState } from "../../src/features/chat/throughput";
import i18n from "../../src/lib/i18n";
import "../../src/index.css";

declare global {
  interface Window {
    __usageStatusFixture: { state: { failStats: boolean; global: {outputTokens:number;elapsedMs:number}; calls: unknown[] }; emit: (event: string) => void };
  }
}

const params = new URLSearchParams(location.search);
const agy = params.get("engine") === "agy";
await i18n.changeLanguage(params.get("lang") === "en" ? "en" : "zh");
const sample: ThroughputState = { ...beginThroughput("fixture-run"), ended:true,
  sample:{version:1,source:"codex_app_server",status:"complete",outputTokens:1000,elapsedMs:20000,generation:null,generationReason:"unavailable_timing"} };

function Footer({sessionId}: {sessionId:string}) {
  const quota = useCodexQuota(agy ? "agy" : "codex", "__local_settings_json__", "C:/fixture");
  if (agy) {
    const context = selectAgyContext(null, undefined, 1_000_000);
    return <StatusBar branch="main" folders={["Workspace"]} selectedFolder="Workspace"
      contextMax={context.max} contextMaxKnown={context.capacityKnown} contextOccupancyKnown={context.occupancyKnown} contextShowCapacity
      quotaStatus={<AgyQuotaStatus model="gemini-pro" now={1_900_000_000} loading={false} refresh={async () => {}}
        snapshot={params.get("quota") === "unavailable" ? {status:"unavailable",groups:[],errorCode:"cli_unavailable"} : {status:"ready",collectedAt:1_900_000_000,...(params.get("credits") === "0" ? {credits:{remaining:0}} : {}),groups:[{id:"gemini",windows:{fiveHour:{usedPercentage:42.83,resetsAt:1_900_003_600},sevenDay:{usedPercentage:86.28,resetsAt:1_900_086_400}}}]}} />}
      throughputStatus={<ThroughputStatus throughput={null} />} />;
  }
  return <StatusBar branch="main" folders={["Workspace"]} selectedFolder="Workspace" usagePct={30} contextMax={760000}
    quotaStatus={<CodexQuotaStatus snapshot={quota.snapshot} now={quota.now} loading={quota.loading} refresh={quota.refresh} />}
    throughputStatus={<ThroughputStatus throughput={sample} scope={{engine:"codex",sessionId,workspacePath:"C:/fixture"}} />} />;
}

function Fixture() {
  const [sessionId,setSessionId] = useState("fixture-a");
  const [result,setResult] = useState("RUNNING");
  const [language,setLanguage] = useState(i18n.language);
  useEffect(() => {
    let disposed = false;
    void (async () => {
      await document.fonts.ready;
      await new Promise(resolve => setTimeout(resolve,800));
      if (disposed) return;
      const rows = [...document.querySelectorAll<HTMLElement>("[data-usage-frame]")].map(frame => ({
        width:frame.clientWidth,overflow:frame.scrollWidth>frame.clientWidth+1,
        content:frame.textContent,
      }));
      // Fixture reports 47% used; the quota UI displays 53% remaining.
      const passed = rows.length === 3 && rows.every(row => !row.overflow && (agy
        ? row.content?.includes("57.17%") && row.content.includes("1M") && !row.content.includes("tokens/s")
        : row.content?.includes("53%") && row.content?.includes("tokens/s")));
      document.documentElement.dataset.result = passed ? "PASS" : "FAIL";
      setResult(JSON.stringify({passed,rows},null,2));
    })();
    return () => {disposed=true;};
  }, [sessionId,language]);
  return <main className="flex min-h-dvh flex-col items-start gap-6 bg-background-primary-default p-3 text-text-primary">
    <h1 className="text-heading-3">{agy ? "AGY quota & known context capacity / no TPS sample" : "Codex subscription & turn throughput"}</h1>
    <p className="text-caption-1-regular">{agy ? "模拟 AGY：已知窗口 1M，实际占用未知，未测出 TPS。无模型调用。" : "模拟整轮效率：本轮 50，会话 A 10，会话 B 40，全局 30 tokens/s。无模型调用。"}</p>
    <div className="flex flex-wrap gap-2">
      <button data-testid="language" className="rounded border p-2" onClick={() => {const next=language === "en" ? "zh":"en";void i18n.changeLanguage(next);setLanguage(next);}}>中文 / English</button>
      <button data-testid="session" className="rounded border p-2" onClick={() => setSessionId(id => id === "fixture-a" ? "fixture-b":"fixture-a")}>切换会话 / Switch session</button>
      <button data-testid="fail" className="rounded border p-2" onClick={() => {window.__usageStatusFixture.state.failStats=true;window.__usageStatusFixture.emit("throughput://changed");}}>模拟读取失败 / Read failure</button>
      <button data-testid="update" className="rounded border p-2" onClick={() => window.__usageStatusFixture.emit("throughput://changed")}>刷新统计事件 / Statistics event</button>
    </div>
    {[768,480,320].map(width => <section key={width} style={{width,maxWidth:"100%"}}>
      <p className="mb-2 text-caption-1-regular">{width}px · {sessionId}</p>
      <div data-usage-frame className="w-full rounded-lg border border-border-button-default p-2"><Footer sessionId={sessionId} /></div>
    </section>)}
    <pre id="result" className="max-w-full whitespace-pre-wrap break-words text-caption-1-regular">{result}</pre>
  </main>;
}
createRoot(document.getElementById("fixture")!).render(<Fixture />);
