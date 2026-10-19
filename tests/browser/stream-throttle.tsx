// Open /tests/browser/stream-throttle.html with the Vite dev server running.
// Real React commits exercise effect cleanup and pre-paint synchronization.
import React, { StrictMode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { streamParseInterval, useThrottled } from "../../src/hooks/use-throttled";

type Commit = { input: string; shown: string; interval: number; at: number };
const commits: Commit[] = [];
function Probe({ text, interval }: { text: string; interval: number }) {
  const shown = useThrottled(text, interval);
  useLayoutEffect(() => { commits.push({ input: text, shown, interval, at: performance.now() }); });
  return <div id="shown">{shown}</div>;
}
const root = createRoot(document.getElementById("fixture")!);
const results: string[] = [];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function check(ok: boolean, description: string) {
  if (!ok) throw new Error(description);
  results.push(description);
}
function render(text: string, interval: number) {
  flushSync(() => root.render(<StrictMode><Probe text={text} interval={interval} /></StrictMode>));
}
const shown = () => document.getElementById("shown")!.textContent;
async function run() {
  render("", 128);
  render("first pending text", 128);
  render("first pending text completed 🙂", 0);
  check(shown() === "first pending text completed 🙂", "completion commits full text immediately");
  check(commits.filter(c => c.interval === 0).every(c => c.shown === c.input), "no stale completion commit");

  render("first pending text completed 🙂 pending", 128);
  render("replacement is a different and substantially longer message", 128);
  check(shown() === "replacement is a different and substantially longer message", "longer replacement bypasses throttle");
  render("短", 128);
  check(shown() === "短", "truncation bypasses throttle");
  await sleep(160);
  check(shown() === "短", "obsolete timer cannot restore replaced text");

  render("", 32);
  const startIndex = commits.length;
  let text = "";
  for (let i = 0; i < 40; i++) {
    text += "你好🙂";
    render(text, streamParseInterval(text.length));
    await sleep(4);
  }
  await sleep(160);
  check(shown() === text, "continuous arrivals eventually show exact Unicode text");
  const streamed = commits.slice(startIndex);
  let previous = "", changes = 0;
  for (const c of streamed) {
    if (!c.shown.startsWith(previous)) throw new Error(`stream rolled back: ${JSON.stringify({ previous, current: c.shown, input: c.input })}`);
    if (c.shown !== previous) changes++;
    previous = c.shown;
  }
  results.push("visible stream is append-only");
  check(changes < 35, "dense arrivals remain coalesced");
  render(text + " pending", 128);
  const beforeUnmount = commits.length;
  flushSync(() => root.unmount());
  await sleep(160);
  check(commits.length === beforeUnmount, "unmount cancels pending work");
  document.getElementById("result")!.textContent = JSON.stringify({ status: "PASS", checks: [...new Set(results)], denseInputUpdates: 40, visibleUpdates: changes }, null, 2);
}
run().catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ status: "FAIL", error: String(error) }); });
