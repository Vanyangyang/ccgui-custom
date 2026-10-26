import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src-tauri/src/agy_vertex_credits.rs", import.meta.url), "utf8");
const script = source.match(/const SCRAPE_SCRIPT: &str = r#"([\s\S]*?)"#;/)?.[1];
assert.ok(script, "exercise the actual injected production script");
const account = "ABCDEF-123456-789ABC";
const otherAccount = "111111-222222-333333";

function page(url, { rows = [], text = "", loading = false, storage = new Map(), project = null, language = "zh-CN" } = {}) {
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
  const elements = new Map();
  const document = {
    title: "Google Cloud",
    body: { innerText: text, appendChild: (node) => elements.set(node.id, node) },
    createElement: () => ({ style: {}, setAttribute() {}, textContent: "" }),
    getElementById: (id) => elements.get(id) ?? null,
    querySelector: () => loading ? {} : null,
    querySelectorAll: (selector) => selector === "*" ? [] : rows.map((text) => ({
      innerText: text, querySelector: () => null,
    })),
  };
  const window = { addEventListener: (name, handler) => events.set(name, handler) };
  window.top = window;
  // One Map per tab: sessionStorage survives reloads within the same window.
  const sessionStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  };
  const context = {
    window, document, location, URL, sessionStorage, navigator: { language },
    Date: { now: () => now },
    setInterval: (handler) => { const id = nextId++; intervals.set(id, handler); return id; },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (handler, delay) => { const id = nextId++; timers.set(id, { handler, due: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  vm.runInNewContext(script.replace("__CCGUI_VERTEX_PROJECT__", JSON.stringify(project)), context);
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
    hint: () => elements.get("ccgui-vertex-hint")?.textContent ?? null,
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

test("leaves Google's setup, creation and payment flows with the user instead of looping", () => {
  // Real loop seen 2026-10-26: credits/all -> setupbillingprofile -> credits/all ... once a second.
  for (const path of [
    `/billing/${account}/setupbillingprofile?country=SG&organizationId=42`,
    `/billing/${account}/setupbillingprofile`,
    `/billing/${account}/payment`,
    "/billing/create?organizationId=42",
    "/billing/projects?organizationId=42",
  ]) {
    const p = page(`https://console.cloud.google.com${path}`);
    p.advance(5000);
    assert.equal(p.location.href, `https://console.cloud.google.com${path}`, path);
    assert.equal(p.payload(), null, path);
  }
});

test("finds the key-file project's billing account under My projects without a manual choice", () => {
  const project = "proj-a1";
  const rows = [
    `My First Project proj-a1-old My billing account ${otherAccount}`,
    `My First Project ${project} My billing account ${account}`,
  ];
  const p = page("https://console.cloud.google.com/billing/projects?organizationId=42", { rows, project });
  p.advance(300);
  // Exact project token only: "proj-a1-old" must not match "proj-a1".
  assert.equal(p.location.href, `https://console.cloud.google.com/billing/${account}/credits/all?organizationId=42`);
});

test("guides the user when the project is not listed or has no billing account", () => {
  const missing = page("https://console.cloud.google.com/billing/projects", { rows: [], project: "proj-a1" });
  missing.advance(300);
  assert.equal(missing.location.href, "https://console.cloud.google.com/billing/projects");
  assert.match(missing.hint(), /proj-a1/);
  assert.match(missing.hint(), /选择一个组织/);
  assert.match(missing.hint(), /无组织/);
  assert.match(missing.hint(), /不要点「创建账号」/);

  const unlinked = page("https://console.cloud.google.com/billing/projects", { rows: ["My First Project proj-a1 Billing is disabled"], project: "proj-a1" });
  unlinked.advance(300);
  assert.match(unlinked.hint(), /还没有关联结算账号/);

  const noProject = page("https://console.cloud.google.com/billing/projects", { rows: [`P x-1 ${account}`] });
  noProject.advance(300);
  assert.equal(noProject.location.href, "https://console.cloud.google.com/billing/projects");
  assert.match(noProject.hint(), /点击该行的「结算账号」链接/);

  const setup = page(`https://console.cloud.google.com/billing/${account}/setupbillingprofile`, { language: "en-US" });
  setup.advance(300);
  assert.match(setup.hint(), /complete-billing-profile/);

  const login = page("https://accounts.google.com/signin");
  assert.match(login.hint(), /登录开通 Vertex 的 Google 账号/);
});

test("redirects an account's landing page to its credits at most once per window", () => {
  const storage = new Map();
  const first = page(`https://console.cloud.google.com/billing/${account}?organizationId=42`, { storage });
  assert.equal(first.location.href, `https://console.cloud.google.com/billing/${account}/credits/all?organizationId=42`);
  // Google sends the user back (e.g. the account still needs setup): do not fight it.
  const bounced = page(`https://console.cloud.google.com/billing/${account}/overview?organizationId=42`, { storage });
  bounced.advance(5000);
  assert.equal(bounced.location.href, `https://console.cloud.google.com/billing/${account}/overview?organizationId=42`);
  // A different account chosen later in the same window still gets its one redirect.
  const other = page(`https://console.cloud.google.com/billing/${otherAccount}/overview`, { storage });
  assert.equal(other.location.href, `https://console.cloud.google.com/billing/${otherAccount}/credits/all`);
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
