import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('./v2.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function setup(context) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const { window } = dom;
  const timers = new Map();
  let sequence = 0;
  window.setTimeout = (callback) => {
    sequence += 1;
    timers.set(sequence, callback);
    return sequence;
  };
  window.clearTimeout = (identifier) => timers.delete(identifier);
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.eval(script);
  context.after(() => window.close());
  const element = (name) => window.document.getElementById(name);
  const click = (name) => element(name).click();
  const input = (name, value) => {
    element(name).value = value;
    element(name).dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const select = (name, value) => {
    element(name).value = value;
    element(name).dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const flush = () => {
    const entry = timers.entries().next().value;
    assert.ok(entry, 'A pending simulated operation is expected');
    timers.delete(entry[0]);
    entry[1]();
  };
  return { window, element, click, input, select, flush, timers };
}

test('initial v2 is ready but never starts execution automatically', (context) => {
  const app = setup(context);
  assert.equal(app.element('approve').disabled, false);
  assert.equal(app.element('versionBadge').textContent, '计划 v2');
  assert.equal(app.element('execution').hidden, true);
  assert.equal(app.timers.size, 0);
});

test('multiple feedback rounds create new versions and remain in planning', (context) => {
  const app = setup(context);
  for (const [index, message] of ['增加 emoji 😀 搜索边界', '再补充取消场景'].entries()) {
    app.input('message', message);
    app.click('send');
    assert.equal(app.element('approve').disabled, true);
    app.flush();
    assert.equal(app.element('versionBadge').textContent, `计划 v${index + 3}`);
    assert.equal(app.element('execution').hidden, true);
    assert.equal(app.element('approve').disabled, false);
  }
  app.click('viewPlan');
  assert.match(app.element('planEditor').value, /emoji 😀/);
  assert.match(app.element('planEditor').value, /取消场景/);
});

test('natural-language approval remains feedback rather than authorization', (context) => {
  const app = setup(context);
  app.input('message', '好的，开始执行吧');
  app.click('send');
  app.flush();
  assert.equal(app.element('execution').hidden, true);
  assert.equal(app.timers.size, 0);
  assert.equal(app.element('approve').disabled, false);
});

test('unsent draft blocks confirmation and restores it only when cleared', (context) => {
  const app = setup(context);
  app.input('message', '还有一个约束没说完');
  assert.equal(app.element('approve').disabled, true);
  assert.match(app.element('planHint').textContent, /未发送/);
  app.click('approve');
  assert.equal(app.element('execution').hidden, true);
  app.input('message', '');
  assert.equal(app.element('approve').disabled, false);
});

test('typing next feedback while planner is busy cannot approve stale output', (context) => {
  const app = setup(context);
  app.input('message', '第一条补充');
  app.click('send');
  app.input('message', '第二条还未发送');
  assert.equal(app.element('send').disabled, true);
  app.flush();
  assert.equal(app.element('approve').disabled, true);
  assert.equal(app.element('send').disabled, false);
});

test('failed planning preserves old version but cannot approve it; retry incorporates feedback', (context) => {
  const app = setup(context);
  app.select('scene', 'planFail');
  app.input('message', '必须保留键盘可访问性');
  app.click('send');
  app.flush();
  assert.equal(app.element('versionBadge').textContent, '计划 v2');
  assert.equal(app.element('approve').disabled, true);
  assert.equal(app.element('retryPlanning').hidden, false);
  app.click('retryPlanning');
  app.flush();
  assert.equal(app.element('versionBadge').textContent, '计划 v3');
  assert.equal(app.element('approve').disabled, false);
  assert.equal(app.element('execution').hidden, true);
});

test('historical plan is read-only and manual edits create an unapproved version', (context) => {
  const app = setup(context);
  app.click('history');
  app.select('versionSelect', '1');
  assert.equal(app.element('planEditor').readOnly, true);
  assert.equal(app.element('savePlan').disabled, true);
  app.select('versionSelect', '2');
  app.input('planEditor', '完整新计划\n禁止写入用户配置\n验收：测试通过');
  app.click('savePlan');
  assert.equal(app.element('versionBadge').textContent, '计划 v3');
  assert.equal(app.element('execution').hidden, true);
  app.click('viewPlan');
  assert.match(app.element('planEditor').value, /禁止写入用户配置/);
});

test('empty manual plan cannot be saved', (context) => {
  const app = setup(context);
  app.click('viewPlan');
  app.input('planEditor', ' ');
  app.click('savePlan');
  assert.equal(app.element('editorError').hidden, false);
  assert.equal(app.element('versionBadge').textContent, '计划 v2');
});

test('confirmation freezes latest plan once and includes prior feedback', (context) => {
  const app = setup(context);
  app.input('message', '中文与 emoji 都不能丢失 😀');
  app.click('send');
  app.flush();
  app.click('approve');
  app.click('approve');
  assert.equal(app.timers.size, 1);
  assert.equal(app.element('relayTrigger').disabled, true);
  assert.equal(app.element('message').disabled, true);
  app.click('packet');
  assert.match(app.element('packetText').textContent, /已确认版本：v3/);
  assert.match(app.element('packetText').textContent, /中文与 emoji 都不能丢失 😀/);
  assert.match(app.element('packetText').textContent, /同时匹配名称和描述/);
  app.click('closePacket');
  app.flush();
  app.flush();
  assert.match(app.element('executionBadge').textContent, /已完成/);
});

test('both same-engine and cross-engine configuration update route summary', (context) => {
  const app = setup(context);
  app.click('relayTrigger');
  app.select('planRoute', 'pi-strong');
  app.select('actRoute', 'pi-fast');
  assert.match(app.element('routeKind').textContent, /同引擎/);
  app.click('applyConfig');
  assert.equal(app.element('routeSummary').textContent, '接力：Pi → Pi');
  app.click('relayTrigger');
  app.select('planRoute', 'codex-strong');
  assert.match(app.element('routeKind').textContent, /跨引擎/);
  app.click('applyConfig');
  assert.equal(app.element('routeSummary').textContent, '接力：Codex → Pi');
});

test('closing config discards unapplied selection and Escape restores trigger focus', (context) => {
  const app = setup(context);
  app.click('relayTrigger');
  app.select('planRoute', 'pi-strong');
  app.window.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(app.element('configPanel').hidden, true);
  assert.equal(app.window.document.activeElement, app.element('relayTrigger'));
  app.click('relayTrigger');
  assert.equal(app.element('planRoute').value, 'codex-strong');
});

test('single-agent mode never authorizes handoff and can restore relay mode', (context) => {
  const app = setup(context);
  app.click('relayTrigger');
  app.click('singleMode');
  app.click('applyConfig');
  assert.equal(app.element('approve').disabled, true);
  app.input('message', '普通对话问题');
  app.click('send');
  app.flush();
  assert.equal(app.element('execution').hidden, true);
  app.click('relayTrigger');
  app.click('relayMode');
  app.click('applyConfig');
  assert.equal(app.element('approve').disabled, false);
});

test('execution retry uses original confirmed snapshot without replanning', (context) => {
  const app = setup(context);
  app.select('scene', 'actFail');
  app.click('approve');
  app.flush();
  app.flush();
  assert.equal(app.element('retry').hidden, false);
  app.click('packet');
  const original = app.element('packetText').textContent;
  app.click('closePacket');
  app.click('retry');
  app.flush();
  assert.match(app.element('executionBadge').textContent, /已完成/);
  app.click('packet');
  assert.equal(app.element('packetText').textContent, original);
});

test('cancellation waits for acknowledgement and late handoff cannot start executor', (context) => {
  const app = setup(context);
  app.click('approve');
  const late = [...app.timers.values()][0];
  app.click('stop');
  assert.match(app.element('composerState').textContent, /等待退出确认/);
  late();
  app.flush();
  assert.equal(app.element('executionBadge').textContent, '已停止');
  assert.equal(app.timers.size, 0);
  assert.doesNotMatch(app.element('execWork').textContent, /演示完成/);
});

test('cancellation during execution rejects late completion', (context) => {
  const app = setup(context);
  app.click('approve');
  app.flush();
  const late = [...app.timers.values()][0];
  app.click('stop');
  app.flush();
  late();
  assert.equal(app.element('executionBadge').textContent, '已停止');
});

test('return to planning invalidates approval and requires a revised plan', (context) => {
  const app = setup(context);
  app.click('approve');
  app.flush();
  app.flush();
  app.click('backToPlan');
  app.input('message', '');
  assert.equal(app.element('approve').disabled, true);
  app.input('message', '基于已有改动重新核对，然后减少首版范围');
  app.click('send');
  app.flush();
  assert.equal(app.element('approve').disabled, false);
  assert.equal(app.element('versionBadge').textContent, '计划 v3');
});

test('reset prevents outstanding callbacks from restoring stale state', (context) => {
  const app = setup(context);
  app.input('message', '修改意见');
  app.click('send');
  const late = [...app.timers.values()][0];
  app.click('reset');
  late();
  assert.equal(app.element('versionBadge').textContent, '计划 v2');
  assert.equal(app.element('discussion').children.length, 0);
  assert.equal(app.timers.size, 0);
});

test('Chinese composition and Shift+Enter do not submit, plain Enter does', (context) => {
  const app = setup(context);
  app.input('message', '中文意见');
  app.element('message').dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
  assert.equal(app.timers.size, 0);
  app.element('message').dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(app.timers.size, 0);
  app.element('message').dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(app.timers.size, 1);
});

test('suggestion never overwrites existing draft and user HTML remains plain text', (context) => {
  const app = setup(context);
  const payload = '<img src=x onerror="window.compromised=true">';
  app.input('message', payload);
  app.window.document.querySelector('[data-suggestion]').click();
  assert.equal(app.element('message').value, payload);
  app.click('send');
  app.flush();
  assert.equal(app.element('discussion').querySelectorAll('img').length, 0);
  assert.equal(app.window.compromised, undefined);
  assert.match(app.element('feedbackList').textContent, /<img/);
});

test('all HTML IDs are unique and no network resources are required', (context) => {
  const app = setup(context);
  const ids = [...app.window.document.querySelectorAll('[id]')].map(element => element.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(app.window.document.querySelectorAll('script[src],link[href],iframe,img,video,audio').length, 0);
  assert.doesNotMatch(script, /\bfetch\s*\(|XMLHttpRequest|WebSocket/);
});

test('new feedback after a failed turn retains the earlier unresolved requirement', (context) => {
  const app = setup(context);
  app.select('scene', 'planFail');
  app.input('message', '失败前提出的要求：不得删除历史数据');
  app.click('send');
  app.flush();
  app.input('message', '另外，新增空状态说明');
  app.click('send');
  app.flush();
  app.click('viewPlan');
  assert.match(app.element('planEditor').value, /不得删除历史数据/);
  assert.match(app.element('planEditor').value, /新增空状态说明/);
});

test('manually replaced plan is reflected in the visible plan card', (context) => {
  const app = setup(context);
  app.click('viewPlan');
  app.input('planEditor', '新目标：只做名称搜索，不匹配描述。\n验收：名称筛选正确。');
  app.click('savePlan');
  assert.equal(app.element('planOverview').hidden, true);
  assert.match(app.element('customOverview').textContent, /不匹配描述/);
});
