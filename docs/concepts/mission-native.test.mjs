import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';

const html = readFileSync(new URL('./mission-native.html', import.meta.url), 'utf8');

function scenario(name, action) {
  test(name, () => {
    const errors = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', error => errors.push(error.message));
    const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole });
    const { document, Event, MouseEvent } = dom.window;
    const get = id => document.getElementById(id);
    const click = selector => {
      const target = document.querySelector(selector);
      assert.ok(target, `Missing ${selector}`);
      target.click();
    };
    const actionNamed = (container, label) => {
      const target = [...document.querySelectorAll(`${container} button`)].find(item => item.textContent === label);
      assert.ok(target, `Missing ${label} in ${container}`);
      target.click();
      return target;
    };
    const count = selector => document.querySelectorAll(selector).length;
    const states = () => [...document.querySelectorAll('.pr-node')].reduce((result, card) => {
      result[card.dataset.state]++;
      return result;
    }, { done: 0, running: 0, queued: 0, waiting: 0, failed: 0, excluded: 0 });
    const send = text => {
      get('chat-input').value = text;
      get('chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    };
    const openSeed = id => {
      click('[data-view="inbox"]');
      click(`[data-notice="${id}"]`);
    };
    const visible = id => !get(id).classList.contains('hidden');
    try {
      action({ dom, document, Event, MouseEvent, get, click, actionNamed, count, states, send, openSeed, visible });
      assert.deepEqual(errors, []);
    } finally {
      dom.window.close();
    }
  });
}

test('Native concept script parses', () => new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]));

scenario('Native entry replaces automation rather than adding a plugin', ({ document, get, count }) => {
  assert.equal(get('host-browser').nextElementSibling.id, 'workbench-entry');
  assert.doesNotMatch(document.querySelector('.host-nav').textContent, /自动化/);
  assert.match(document.querySelector('.product-name').textContent, /原生/);
  assert.doesNotMatch(document.querySelector('.product-name').textContent, /插件/);
  assert.equal(count('[data-view]'), 3);
});

scenario('Thirty independent tasks have consistent initial states', ({ count, states, get }) => {
  assert.equal(count('.pr-node'), 30);
  assert.deepEqual(states(), { done: 8, running: 5, queued: 13, waiting: 3, failed: 1, excluded: 0 });
  assert.match(get('runtime-summary').textContent, /并发上限 5/);
  assert.equal(count('.notice'), 5);
});

scenario('Definition represents conditions, retry cycles and a join', ({ click, count, get }) => {
  click('#show-draft');
  for (const id of ['review', 'check', 'route', 'approval', 'retry', 'join', 'output']) assert.equal(count(`[data-node="${id}"]`), 1);
  assert.equal(count('.pr-node'), 0);
  assert.equal(count('#connections > path[stroke-dasharray]'), 3);
  assert.match(get('graph-nodes').textContent, /FOR EACH/);
  assert.match(get('node-count').textContent, /禁止手工改图/);
});

scenario('Human pointer drag cannot move a node', ({ document, MouseEvent, get }) => {
  const card = document.querySelector('.pr-node');
  const original = card.getAttribute('style');
  card.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 100 }));
  get('stage').dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 200, clientY: 200 }));
  get('stage').dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
  assert.equal(card.getAttribute('style'), original);
});

scenario('Conversation revises draft policy without changing live concurrency', ({ send, click, get, states }) => {
  send('并发上限改为 3');
  assert.match(get('canvas-version').textContent, /草稿 v2/);
  assert.match(get('graph-nodes').textContent, /并发上限 3/);
  click('#show-run');
  assert.match(get('canvas-version').textContent, /快照 v1/);
  assert.match(get('runtime-summary').textContent, /并发上限 5/);
  assert.equal(states().running, 5);
});

scenario('All-approval and retry policy updates remain draft-only', ({ send, get, click }) => {
  send('所有 PR 都人工确认，失败自动重试 2 次');
  assert.match(get('graph-nodes').textContent, /所有项都需要确认/);
  assert.match(get('graph-nodes').textContent, /自动重试 2 次/);
  click('#show-run');
  assert.match(get('graph-nodes').textContent, /自动重试 1 次/);
});

scenario('Invalid policy update is atomic and leaves version unchanged', ({ send, get }) => {
  send('并发上限改为 99，失败自动重试 2 次');
  assert.match(get('canvas-version').textContent, /草稿 v1/);
  assert.match(get('conversation').textContent, /未修改规则/);
  assert.match(get('graph-nodes').textContent, /自动重试 1 次/);
});

scenario('Unknown or malicious prompt is stored as text without invented execution', ({ send, get, count }) => {
  send('<img src=x onerror=alert(1)> 把任务改成全自动付款');
  assert.equal(count('#conversation img'), 0);
  assert.match(get('conversation').textContent, /没有改变流程/);
  assert.match(get('canvas-version').textContent, /草稿 v1/);
});

scenario('Three execution phases release slots only after terminal or waiting state', ({ click, states, document }) => {
  click('#advance');
  assert.equal(document.querySelector('[data-task="item-13"]').dataset.stage, 'check');
  assert.equal(states().queued, 13);
  click('#advance');
  assert.equal(document.querySelector('[data-task="item-13"]').dataset.stage, 'route');
  click('#advance');
  assert.equal(states().running, 5);
  assert.equal(states().queued, 8);
  assert.equal(states().done, 12);
  assert.equal(states().waiting, 4);
});

scenario('Waiting and failure do not consume slots or block unrelated tasks', ({ click, states, get }) => {
  for (let step = 0; step < 18; step++) {
    click('#advance');
    assert.ok(states().running <= 5);
  }
  assert.equal(states().queued, 0);
  assert.equal(states().running, 0);
  assert.ok(states().waiting >= 3);
  assert.equal(states().failed, 1);
  assert.match(get('context-state').textContent, /待处理/);
  assert.doesNotMatch(get('context-state').textContent, /已终结/);
});

scenario('Auto retry is bounded, then failure escalates while queue progresses', ({ click, document, states, get }) => {
  click('#simulate-error');
  assert.equal(states().running, 5);
  assert.equal(states().failed, 1);
  click('[data-task="item-13"]');
  assert.match(get('inspector').textContent, /第 2 次尝试/);
  click('#simulate-error');
  assert.equal(document.querySelector('[data-task="item-13"]').dataset.state, 'failed');
  assert.equal(states().failed, 2);
  assert.equal(states().running, 5);
  click('[data-view="inbox"]');
  assert.match(get('notice-list').textContent, /重试超限/);
});

scenario('Manual retry resumes only failed stage and respects full pool', ({ openSeed, actionNamed, click, document, states }) => {
  openSeed('seed-item-12');
  const retry = actionNamed('#notice-detail', '重试当前阶段');
  retry.click();
  click('[data-view="studio"]');
  assert.equal(document.querySelector('[data-task="item-12"]').dataset.state, 'queued');
  assert.equal(document.querySelector('[data-task="item-12"]').dataset.stage, 'check');
  assert.equal(states().running, 5);
  assert.equal(states().failed, 0);
  assert.equal(states().queued, 14);
});

scenario('Approval changes only its task and is idempotent', ({ openSeed, actionNamed, click, states, document }) => {
  openSeed('seed-item-9');
  const approve = actionNamed('#notice-detail', '确认审查意见');
  approve.click();
  click('[data-view="studio"]');
  assert.equal(document.querySelector('[data-task="item-9"]').dataset.state, 'done');
  assert.equal(states().done, 9);
  assert.equal(states().waiting, 2);
  assert.equal(states().running, 5);
});

scenario('Feedback requeues one branch and requires a fresh decision', ({ openSeed, actionNamed, get, Event, click, states, document }) => {
  openSeed('seed-item-9');
  actionNamed('#notice-detail', '补充要求');
  get('notice-feedback').value = '补充权限测试证据，再找我确认。';
  get('notice-feedback-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  click('[data-view="studio"]');
  assert.equal(document.querySelector('[data-task="item-9"]').dataset.state, 'queued');
  assert.equal(states().running, 5);
  for (let step = 0; step < 6; step++) click('#advance');
  assert.equal(document.querySelector('[data-task="item-9"]').dataset.state, 'waiting');
  click('[data-view="inbox"]');
  assert.match(get('notice-list').textContent, /反馈后需要再次确认/);
});

scenario('Empty feedback does not authorize or resolve the waiting task', ({ openSeed, actionNamed, get, Event, click, states }) => {
  openSeed('seed-item-9');
  actionNamed('#notice-detail', '补充要求');
  get('notice-feedback').value = '   ';
  get('notice-feedback-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  assert.match(get('notice-feedback-error').textContent, /请填写/);
  click('[data-view="studio"]');
  assert.equal(states().waiting, 3);
});

scenario('Explicit exclusion terminates branch without pretending success', ({ openSeed, actionNamed, click, states }) => {
  openSeed('seed-item-12');
  actionNamed('#notice-detail', '排除此项');
  click('[data-view="studio"]');
  assert.equal(states().excluded, 1);
  assert.equal(states().done, 8);
  assert.equal(states().failed, 0);
});

scenario('Read status never approves tasks', ({ click, get, states }) => {
  click('[data-view="inbox"]');
  click('#read-all');
  assert.equal(get('unread-count').textContent, '0');
  click('[data-view="studio"]');
  assert.equal(states().waiting, 3);
  assert.equal(states().failed, 1);
});

scenario('Mixed running flow is discoverable in both running and attention lists', ({ click, document, count }) => {
  click('[data-view="flows"]');
  click('[data-flow-filter="running"]');
  assert.equal(count('.flow-row'), 2);
  assert.ok(document.querySelector('[data-flow="flow-pr"]'));
  click('[data-flow-filter="attention"]');
  assert.equal(count('.flow-row'), 1);
  assert.ok(document.querySelector('[data-flow="flow-pr"]'));
});

scenario('Retry and approval messages locate exact run and PR instance', ({ openSeed, actionNamed, get, document }) => {
  openSeed('seed-item-12');
  actionNamed('#notice-detail', '在画布定位 ↗');
  assert.equal(document.querySelector('.pr-node.selected').dataset.task, 'item-12');
  assert.match(get('canvas-version').textContent, /run-pr-01/);
  assert.match(get('inspector').textContent, /CI \/ 依据核查/);
});

scenario('New run expands configured input count with bounded concurrency', ({ click, send, states, get }) => {
  click('#new-flow');
  send('审查全部 PR 并整理风险');
  send('并发上限改为 3，所有 PR 都人工确认');
  click('#start-run');
  assert.equal(Object.values(states()).reduce((sum, count) => sum + count, 0), 30);
  assert.equal(states().running, 3);
  assert.equal(states().queued, 27);
  for (let step = 0; step < 3; step++) click('#advance');
  assert.equal(states().waiting, 3);
  assert.equal(states().done, 0);
  assert.equal(states().running, 3);
  assert.match(get('canvas-version').textContent, /v2/);
});

scenario('Current run button cannot accidentally create duplicate active run', ({ click, get, states }) => {
  click('#start-run');
  click('#start-run');
  assert.match(get('canvas-version').textContent, /run-pr-01/);
  assert.equal(states().running, 5);
});

scenario('Join stays blocked until every branch is completed or explicitly excluded', ({ click, document, actionNamed, states, get }) => {
  for (let iteration = 0; iteration < 80; iteration++) {
    const active = states();
    if (active.running) { click('#advance'); continue; }
    const pending = document.querySelector('.pr-node.waiting,.pr-node.failed');
    if (!pending) break;
    pending.click();
    actionNamed('#inspector', '打开关联消息 →');
    actionNamed('#notice-detail', '排除此项');
    click('[data-view="studio"]');
  }
  assert.equal(states().running + states().queued + states().waiting + states().failed, 0);
  assert.equal(states().done + states().excluded, 30);
  assert.ok(states().excluded > 0);
  assert.match(get('context-state').textContent, /已终结/);
  click('[data-view="inbox"]');
  assert.match(get('notice-list').textContent, /全部分支已收敛/);
});

scenario('Old run message keeps its original snapshot after starting a new run', ({ openSeed, actionNamed, click, get }) => {
  openSeed('seed-report');
  actionNamed('#notice-detail', '在画布定位 ↗');
  assert.match(get('canvas-version').textContent, /run-report-01/);
  click('#start-run');
  assert.doesNotMatch(get('canvas-version').textContent, /run-report-01/);
  openSeed('seed-report');
  actionNamed('#notice-detail', '在画布定位 ↗');
  assert.match(get('canvas-version').textContent, /run-report-01/);
});

scenario('Cross-page message link clears incompatible inbox filters', ({ openSeed, actionNamed, click, get, Event }) => {
  openSeed('seed-item-12');
  actionNamed('#notice-detail', '在画布定位 ↗');
  click('[data-view="inbox"]');
  click('[data-inbox-filter="done"]');
  get('inbox-search').value = '资料';
  get('inbox-search').dispatchEvent(new Event('input'));
  click('[data-view="studio"]');
  actionNamed('#inspector', '打开关联消息 →');
  assert.equal(get('inbox-search').value, '');
  assert.match(get('notice-detail').textContent, /核查失败/);
});

scenario('Offline asset boundary and unique DOM IDs', ({ document, count }) => {
  const ids = [...document.querySelectorAll('[id]')].map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(count('script[src],link[rel="stylesheet"],iframe'), 0);
});
