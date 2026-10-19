import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { StreamReveal, REVEAL_MAX_LAG_MS, visibleLineWindow, visiblePrefix, visibleWindow, type RevealClock } from "../src/features/chat/components/stream-reveal.ts";
function clock() {
  let now = 0, id = 0;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { time: number; callback: () => void }>();
  const api: RevealClock = {
    now: () => now,
    frame: cb => { frames.set(++id, cb); return id; },
    cancelFrame: id => { frames.delete(id); },
    timeout: (callback, ms) => { timers.set(++id, {time:now+ms,callback}); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimeout: id => { timers.delete(id as unknown as number); },
  };
  return {api, pending: () => frames.size + timers.size, advance(ms: number, raf = true) {
    now += ms;
    if (raf) { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(cb=>cb()); }
    for (const [id, timer] of [...timers]) if (timer.time <= now) { timers.delete(id); timer.callback(); }
  }};
}
test("one burst becomes multiple monotonic frames and catches up within 240ms", () => {
  const c=clock(), reveal=new StreamReveal(true,c.api);
  reveal.update("x".repeat(100), true);
  const sizes=[];
  for(let i=0;i<15;i++){c.advance(16); sizes.push(reveal.read(0,100));}
  assert.ok(sizes[0] > 0 && sizes[0] < 20);
  assert.ok(sizes.every((value,i) => i===0 || value>=sizes[i-1]));
  assert.equal(sizes.at(-1),100);
  assert.equal(c.pending(),0);
});
test("continuous arrivals do not reset visible text or delay earlier content", () => {
  const c=clock(), reveal=new StreamReveal(true,c.api);
  reveal.update("x".repeat(100),true); c.advance(32);
  const before=reveal.read(0,100);
  assert.ok(before>0 && before<100);
  reveal.update("x".repeat(200),true); c.advance(32);
  assert.ok(reveal.read(0,200)>before);
  for(let i=0;i<13;i++)c.advance(16);
  assert.equal(reveal.read(0,200),200);
});
test("finish, hidden/reduced-motion, replacement and truncation reveal exact content immediately", () => {
  const c=clock(), reveal=new StreamReveal(true,c.api);
  reveal.update("original text",true); c.advance(16);
  reveal.update("replacement",true); assert.equal(reveal.read(0,100),11);
  reveal.update("rep",true); assert.equal(reveal.read(0,100),3);
  reveal.update("replacement",false); assert.equal(reveal.read(0,100),11);
  reveal.update("replacement append",true); reveal.finish();
  assert.equal(reveal.read(0,100),18); assert.equal(c.pending(),0);
});
test("history shows instantly; suspended frames catch up via fallback; disposal cancels work", () => {
  const c=clock(), history=new StreamReveal(false,c.api);
  assert.equal(history.read(0,10),10);
  history.update("history",false); assert.equal(history.read(0,100),7);
  const live=new StreamReveal(true,c.api);
  live.update("stream",true); c.advance(100,false); assert.equal(live.read(0,100),6);
  live.update("stream more",true); live.cancel(); assert.equal(c.pending(),0);
});
test("completed text runs are not notified on subsequent reveal frames", () => {
  const c=clock(), reveal=new StreamReveal(true,c.api); let first=0,last=0;
  reveal.subscribe(0,10,()=>first++); const off=reveal.subscribe(10,90,()=>last++);
  reveal.update("x".repeat(100),true);
  while(reveal.read(0,100)<10)c.advance(16);
  const settledCalls=first;
  for(let i=0;i<15;i++)c.advance(16);
  assert.equal(first,settledCalls); assert.ok(last>first); off();
});
test("no intermediate prefix splits CJK, emoji, flags or combining characters", () => {
  for(const text of ["你好世界","A🙂B","👩‍💻完成","🇨🇳🇸🇬","e\u0301clair"]){
    const boundaries=new Set([0,...[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)].map(s=>s.index+s.segment.length)]);
    for(let n=0;n<=text.length;n++){
      const part=visiblePrefix(text,n);assert.ok(boundaries.has(part.length));assert.ok(text.startsWith(part));assert.ok(part.length<=n);
    }
    assert.equal(visiblePrefix(text,text.length),text);
  }
});

test("continuous arrivals cannot postpone the stalled-frame watchdog forever", () => {
  const c=clock(), reveal=new StreamReveal(true,c.api);
  reveal.update("x",true);
  for(let i=2;i<=5;i++) {c.advance(24,false);reveal.update("x".repeat(i),true);}
  c.advance(4,false);
  assert.equal(reveal.read(0,100),5);
  assert.equal(c.pending(),0);
});

test("thinking window follows revealed text and preserves grapheme boundaries", () => {
  const text="x".repeat(2100)+"👩‍💻"+"y".repeat(2100);
  assert.equal(visibleWindow(text,100,2000),"x".repeat(100));
  assert.equal(visibleWindow(text,3000,2000).length,2000);
  const count=2100+2+2000;
  const window=visibleWindow(text,count,2000);
  assert.ok(window.startsWith("👩‍💻"));
  assert.equal(visibleWindow(text,text.length,2000),"y".repeat(2000));
});

test("virtualized remount shows received text immediately and smooths only new arrivals", () => {
  const c=clock(), reveal=new StreamReveal(false,c.api);
  const received="x".repeat(3000);
  assert.equal(reveal.read(0,received.length),received.length);
  reveal.update(received,true);
  assert.equal(c.pending(),0);
  reveal.update(received+"y".repeat(100),true);
  c.advance(16);
  assert.ok(reveal.read(0,3100)>3000 && reveal.read(0,3100)<3100);
});


test("repeated identical snapshots do not postpone the reveal deadline", () => {
  const c=clock(), reveal=new StreamReveal(true,c.api);
  const text="x".repeat(100);
  reveal.update(text,true);
  for(let i=0;i<15;i++){c.advance(16);reveal.update(text,true);}
  assert.equal(reveal.read(0,100),100);
  assert.equal(c.pending(),0);
});

test("observed OMP bursts avoid emptying the queue too early and bound per-frame jumps", () => {
  const {batches}=JSON.parse(readFileSync(new URL("./fixtures/omp-arrival-cadence.json",import.meta.url),"utf8")) as {batches:[number,number][]};
  const c=clock(), reveal=new StreamReveal(false,c.api);
  let text="",index=0,emptyFrames=0,maxStep=0,previous=0;
  for(let now=0;now<batches[batches.length-1][0]+500;now+=1000/60){
    while(index<batches.length && batches[index][0]<=now){
      text+="x".repeat(batches[index++][1]);reveal.update(text,true);
    }
    c.advance(1000/60);
    const visible=reveal.read(0,text.length);
    if(index>1){
      maxStep=Math.max(maxStep,visible-previous);
      if(visible===text.length && index<batches.length)emptyFrames++;
    }
    previous=visible;
  }
  // Fixed 80ms pacing on this trace had ~303 empty frames and jumps of 8.
  assert.ok(emptyFrames<180, `empty frames: ${emptyFrames}`);
  assert.ok(maxStep<=4, `largest jump: ${maxStep}`);
  assert.equal(reveal.read(0,text.length),text.length);
  assert.equal(c.pending(),0);
});

test("a 200 tok/s burst stream advances every frame instead of landing whole batches", () => {
  // OMP writes ~100 characters every ~144ms at this rate; showing them as they
  // arrive is what made the thinking panel read as flashing text.
  const c=clock(), reveal=new StreamReveal(true,c.api);
  const burst="汉".repeat(100);
  const burstFrames=Math.round(144/(1000/60));
  let text="",maxStep=0,previous=0,maxLag=0,frames=0,dumped=0;
  for(let b=0;b<20;b++){
    text+=burst;reveal.update(text,true);
    for(let f=0;f<burstFrames;f++){
      c.advance(1000/60);
      const visible=reveal.read(0,text.length);
      const step=visible-previous;
      maxStep=Math.max(maxStep,step);if(step>=20)dumped++;
      maxLag=Math.max(maxLag,text.length-visible);
      previous=visible;frames++;
    }
  }
  for(let f=0;f<20;f++)c.advance(1000/60);
  // The old prefix cursor revealed whole 100-character batches in one frame.
  assert.equal(dumped,0,`frames revealing 20+ characters at once: ${dumped}`);
  assert.ok(maxStep<=20,`largest single-frame step: ${maxStep}`);
  // Lag holds back about one burst — never the whole stream, never a dump.
  assert.ok(maxLag>=50,`reveal is not holding anything back: ${maxLag}`);
  assert.ok(maxLag<=200,`largest backlog shown late: ${maxLag}`);
  assert.ok(maxLag<text.length/4,`backlog relative to the stream: ${maxLag}/${text.length}`);
  assert.equal(reveal.read(0,text.length),text.length);
  assert.equal(c.pending(),0);
  assert.equal(REVEAL_MAX_LAG_MS,240);
});
test("markdown reshaping the rendered text does not dump the unrevealed backlog", () => {
  // Closing `**` consumes the opening markers: the rendered text stops being
  // a literal extension, which used to call finish() and reveal everything at
  // once (measured 20-62 character single-frame jumps at 200 tok/s).
  const c=clock(), reveal=new StreamReveal(true,c.api);
  const head="x".repeat(300);
  reveal.update(head,true);
  c.advance(16);
  const before=reveal.read(0,head.length);
  assert.ok(before>0 && before<head.length,`cursor mid-drain: ${before}`);
  // Same length, reshaped in the middle (a construct consumed at character
  // 150 — not at the head, which is a wholesale swap, covered above).
  reveal.update(head.slice(0,150)+"y"+head.slice(151),true);
  const after=reveal.read(0,head.length);
  assert.ok(after>=before,`reshape must not hide text: ${before} -> ${after}`);
  assert.ok(after<head.length,`reshape must not reveal the backlog: ${after}`);
  c.advance(1000);
  assert.equal(reveal.read(0,head.length),head.length);
});
test("thinking window drops whole rows from the revealed cursor, not from the received tail", () => {
  const text="1234567890\n".repeat(300);
  const end=2000,limit=1000;
  const windowed=visibleLineWindow(text,end,limit);
  assert.equal(windowed.truncated,true);
  // Cut lands on the row boundary after the limit, so the window is a pure
  // suffix of what has been revealed and never exceeds the limit.
  assert.equal(windowed.text,text.slice(1001,end));
  assert.ok(windowed.text.length<=limit);
  // A burst still being drained cannot push content out before it was shown.
  const early=visibleLineWindow(text,600,limit);
  assert.deepEqual(early,{text:text.slice(0,600),truncated:false});
  const past=visibleLineWindow(text,text.length,limit);
  assert.ok(past.text.length<=limit);
  assert.ok(past.text.startsWith("1234567890\n"));
});
test("a cancelled drain resumes on the next identical snapshot instead of freezing", () => {
  // Fast Refresh re-running effects (or StrictMode's double effect) cleans up
  // between two commits that carry the same text. The pending tail must not
  // stay hidden until the provider happens to send more.
  const c=clock(), reveal=new StreamReveal(true,c.api);
  reveal.update("x".repeat(200),true);
  c.advance(32);
  const before=reveal.read(0,200);
  assert.ok(before>0 && before<200,`mid-drain: ${before}`);
  reveal.cancel();
  assert.equal(reveal.read(0,200),before,"cancel keeps the cursor for a real unmount");
  reveal.update("x".repeat(200),true);
  // Re-arms without moving the deadline: the burst still lands by 240ms.
  for(let i=0;i<6;i++)c.advance(1000/60);
  const resumed=reveal.read(0,200);
  assert.ok(resumed>before && resumed<200,`resumed: ${before} -> ${resumed}`);
  for(let i=0;i<7;i++)c.advance(1000/60);
  assert.equal(reveal.read(0,200),200,"cleared by the original deadline");
  assert.equal(c.pending(),0);
});
test("reused grapheme reader preserves exact boundaries while the cursor moves both ways", async () => {
  const { createVisibleTextReader } = await import("../src/features/chat/components/stream-reveal.ts");
  const text = "A👩‍💻e\u0301🇨🇳你好".repeat(30);
  const boundaries = [0, ...Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), s => s.index + s.segment.length)];
  const reader = createVisibleTextReader(text);
  for (const count of [...Array.from({ length: text.length + 1 }, (_, i) => i)].reverse()) {
    const end = boundaries.filter(n => n <= count).at(-1)!;
    const start = boundaries.filter(n => n <= Math.max(0, end - 20)).at(-1)!;
    assert.equal(reader.prefix(count), text.slice(0, end));
    assert.equal(reader.window(count, 20), text.slice(start, end));
  }
});
