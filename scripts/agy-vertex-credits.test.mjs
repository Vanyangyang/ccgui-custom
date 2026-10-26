import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src-tauri/src/agy_vertex_credits.rs", import.meta.url), "utf8");
const script = source.match(/const SCRAPE_SCRIPT: &str = r#"([\s\S]*?)"#;/)?.[1];
assert.ok(script, "exercise the actual injected production script");
const account = "ABCDEF-123456-789ABC";
const otherAccount = "111111-222222-333333";

function page(url, { rows = [], text = "", loading = false } = {}) {
  let currentUrl = new URL(url);
  let now = 1000;
  const timers = new Map();
  const intervals = new Map();
  const events = new Map();
  let nextId = 1;
  const location = {
    get protocol() { return currentUrl.protocol; },
    get hostname() { return currentUrl.hostname; },
    get pathname() { return currentUrl.pathname; },
    get href() { return currentUrl.href; },
    get origin() { return currentUrl.origin; },
    replace(value) { currentUrl = new URL(value); },
  };
  const document = {
    title: "Google Cloud",
    body: { innerText: text },
    querySelector: () => loading ? {} : null,
    querySelectorAll: (selector) => selector === "*" ? [] : rows.map((text) => ({
      innerText: text, querySelector: () => null,
    })),
  };
  const window = { addEventListener: (name, handler) => events.set(name, handler) };
  window.top = window;
  const context = {
    window, document, location, URL,
    Date: { now: () => now },
    setInterval: (handler) => { const id = nextId++; intervals.set(id, handler); return id; },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (handler, delay) => { const id = nextId++; timers.set(id, { handler, due: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  vm.runInNewContext(script, context);
  return {
    document, location,
    navigate(value) { currentUrl = new URL(value); },
    rows(value) { rows = value; },
    advance(ms) {
      now += ms;
      for (const callback of intervals.values()) callback();
      for (const [id, timer] of [...timers]) {
        if (timer.due <= now) { timers.delete(id); timer.handler(); }
      }
    },
    payload() {
      const prefix = "__CCGUI_VERTEX_CREDITS__:";
      return document.title.startsWith(prefix) ? JSON.parse(document.title.slice(prefix.length)) : null;
    },
    close() { events.get("pagehide")?.(); },
    pendingIntervals: () => intervals.size,
  };
}

test("starts at the account chooser without a preselected account or balance", () => {
  const p = page("https://console.cloud.google.com/billing", { rows: ["Free Trial $100.00 $200.00 50%"] });
  p.advance(5000);
  assert.equal(p.payload(), null);
  assert.equal(p.location.href, "https://console.cloud.google.com/billing");
});

test("navigates the user's selected account and preserves their authuser selection", () => {
  const p = page(`https://console.cloud.google.com/billing/${account}/overview?authuser=3`);
  assert.equal(p.location.href, `https://console.cloud.google.com/billing/${account}/credits/all?authuser=3`);
  assert.equal(p.payload(), null);
});

test("only reports credits from the official HTTPS console and retains actual currency", () => {
  const p = page(`https://console.cloud.google.com/billing/${account}/credits/all`, {
    rows: ["Free Trial SG$100.00 SG$200.00 50%", "Google Developer Program EUR 20.00 80%"],
  });
  p.advance(1100);
  p.advance(800);
  assert.deepEqual(p.payload(), {
    status: "ok", billingAccountId: account, freeTrialCredit: "SG$100.00",
    freeTrialOriginalCredit: "SG$200.00", freeTrialRemainingPercent: 50,
    gdpMonthlyCredit: "EUR 20.00", gdpMonthlyRemainingPercent: 80,
  });
  for (const origin of ["https://example.com", "https://console.cloud.google.com.example.com", "http://console.cloud.google.com"]) {
    const wrong = page(`${origin}/billing/${account}/credits/all`, { rows: ["Free Trial $100.00 $200.00"] });
    wrong.advance(5000);
    assert.equal(wrong.payload(), null);
  }
});

test("account change during settlement cannot reuse the previous account's rows", () => {
  const p = page(`https://console.cloud.google.com/billing/${account}/credits/all`, { rows: ["Free Trial $100.00 $200.00"] });
  p.advance(1100);
  p.navigate(`https://console.cloud.google.com/billing/${otherAccount}/credits/all`);
  p.rows(["Google Developer Program $10.00"]);
  p.advance(800);
  assert.equal(p.payload(), null);
  p.advance(1100);
  p.advance(800);
  assert.deepEqual(p.payload(), { status: "ok", billingAccountId: otherAccount, gdpMonthlyCredit: "$10.00" });
});

test("login, permission denial and empty credits never fabricate a balance", () => {
  const login = page("https://accounts.google.com/signin");
  assert.deepEqual(login.payload(), { status: "login_required" });
  const denied = page(`https://console.cloud.google.com/billing/${account}/credits/all`, { text: "你需要额外访问权限 billing.accounts.get（缺少）" });
  assert.deepEqual(denied.payload(), { status: "permission_denied", billingAccountId: account });
  const empty = page(`https://console.cloud.google.com/billing/${account}/credits/all`, { text: "No promotional credits available" });
  empty.advance(1100);
  assert.deepEqual(empty.payload(), { status: "no_credits", billingAccountId: account });
});

test("loading rows are not published and timers clean up when the page closes", () => {
  const p = page(`https://console.cloud.google.com/billing/${account}/credits/all`, { rows: ["Free Trial $100.00"], loading: true });
  p.advance(5000);
  assert.equal(p.payload(), null);
  assert.equal(p.pendingIntervals(), 1);
  p.close();
  assert.equal(p.pendingIntervals(), 0);
});
