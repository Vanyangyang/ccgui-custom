import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';

const html = readFileSync(new URL('./mission-studio.html', import.meta.url), 'utf8');

function scenario(name, action) {
  test(name, () => {
    const errors = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', error => errors.push(error.message));
    const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole });
    const { document, Event } = dom.window;
    const get = id => document.getElementById(id);
    const click = selector => {
      const element = document.querySelector(selector);
      assert.ok(element, `Missing ${selector}`);
      element.click();
    };
    const detailAction = label => {
      const element = [...document.querySelectorAll('#notice-detail button')].find(item => item.textContent === label);
      assert.ok(element, `Missing action ${label}`);
      element.click();
      return element;
    };
    const count = selector => document.querySelectorAll(selector).length;
    const send = prompt => {
      get('chat-input').value = prompt;
      get('chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    };
    const visible = id => !get(id).classList.contains('hidden');
    try {
      action({ dom, document, Event, get, click, detailAction, count, send, visible });
      assert.deepEqual(errors, []);
    } finally {
      dom.window.close();
    }
  });
}

test('Inline script parses', () => new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]));

scenario('Canvas, three navigation surfaces and exact plugin placement', ({ get, count }) => {
  assert.equal(count('[data-view]'), 3);
  assert.equal(count('.node'), 7);
  assert.equal(get('host-browser').nextElementSibling.id, 'plugin-entry');
  assert.equal(get('flows-count').textContent, '4');
  assert.equal(get('unread-count').textContent, '3');
});

scenario('Conversation adds a connected verification node and change summary', ({ send, get, count }) => {
  send('增加一个验证步骤');
  assert.equal(count('[data-node="verify"]'), 1);
  assert.match(get('canvas-version').textContent, /v2/);
  assert.match(get('conversation').textContent, /增加“验证结果与依据”/);
  assert.equal(count('.node.changed'), 1);
  assert.equal(count('#connections > path'), 9);
});

scenario('Parallel and sequential edits update same workflow', ({ send, count, get }) => {
  send('改为串行');
  assert.equal(count('[data-node^="branch-"]'), 0);
  assert.equal(count('.node'), 4);
  assert.equal(get('flows-count').textContent, '4');
  send('改成并行');
  assert.equal(count('[data-node^="branch-"]'), 3);
});

scenario('Mixed additions and removals are scoped to their own step', ({ send, count }) => {
  send('增加验证步骤，去掉人工确认');
  assert.equal(count('[data-node="verify"]'), 1);
  assert.equal(count('[data-node="approval"]'), 0);
  send('去掉验证步骤，增加人工确认');
  assert.equal(count('[data-node="verify"]'), 0);
  assert.equal(count('[data-node="approval"]'), 1);
});

scenario('Idempotent or unsupported prompts do not bump revision', ({ send, get }) => {
  send('改成并行');
  assert.match(get('canvas-version').textContent, /v1/);
  send('换成红色并连接另一个数据库');
  assert.match(get('conversation').textContent, /本次未修改流程/);
  assert.match(get('canvas-version').textContent, /v1/);
});

scenario('New goal creates a separate workflow with honest generic mapping', ({ click, send, get, count }) => {
  click('#new-flow');
  assert.equal(count('.node'), 0);
  send('为我准备团队学习计划');
  assert.equal(count('.node'), 4);
  assert.equal(get('flows-count').textContent, '5');
  assert.match(get('conversation').textContent, /通用示例/);
});

scenario('Prompt content remains text, not HTML', ({ send, get, count }) => {
  send('<img src=x onerror=alert(1)>');
  assert.equal(count('#conversation img'), 0);
  assert.match(get('conversation').textContent, /<img/);
});

scenario('Running snapshot stays unchanged while draft is edited', ({ click, send, get, count }) => {
  click('#start-run');
  send('去掉人工确认');
  assert.match(get('canvas-version').textContent, /草稿 v2/);
  assert.equal(count('[data-node="approval"]'), 0);
  click('#show-run');
  assert.match(get('canvas-version').textContent, /运行快照 v1/);
  assert.equal(count('[data-node="approval"]'), 1);
  assert.match(get('context-text').textContent, /不会影响本次运行/);
});

scenario('All branch completions reach inbox; human gate blocks advancement', ({ click, get, count, visible }) => {
  click('#start-run');
  click('#advance');
  click('#advance');
  assert.match(get('context-state').textContent, /待你确认/);
  assert.equal(visible('advance'), false);
  const unread = get('unread-count').textContent;
  click('#advance');
  assert.equal(get('unread-count').textContent, unread);
  click('[data-view="inbox"]');
  assert.equal(count('.notice'), 9);
  assert.match(get('notice-list').textContent, /代码逻辑已完成/);
  assert.match(get('notice-list').textContent, /测试覆盖已完成/);
  assert.match(get('notice-list').textContent, /权限风险已完成/);
});

scenario('Read-all never resolves approvals', ({ click, get, count }) => {
  click('[data-view="inbox"]');
  click('#read-all');
  assert.equal(get('unread-count').textContent, '0');
  assert.equal(count('.notice.read'), 3);
  assert.match(get('notice-detail').textContent, /接受建议并继续/);
  click('[data-view="flows"]');
  assert.match(get('flow-list').textContent, /待你确认/);
});

scenario('Retry resolves failure once and preserves run identity', ({ click, detailAction, document, get }) => {
  click('[data-view="inbox"]');
  click('[data-notice="notice-failed"]');
  const action = detailAction('重试此节点');
  action.click();
  assert.match(get('notice-detail').textContent, /已处理/);
  click('[data-view="flows"]');
  assert.match(document.querySelector('[data-flow="flow-feedback"]').textContent, /run-11/);
  assert.match(document.querySelector('[data-flow="flow-feedback"]').textContent, /运行中/);
});

scenario('Feedback reprocesses and produces a new actionable approval', ({ click, detailAction, get, Event, count }) => {
  click('[data-view="inbox"]');
  click('[data-notice="notice-attention"]');
  detailAction('提出修改');
  get('notice-feedback').value = '先补齐来源，不要采用旧结论。';
  get('notice-feedback-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  assert.match(get('notice-detail').textContent, /已反馈/);
  detailAction('在画布定位 ↗');
  click('#advance');
  assert.match(get('context-state').textContent, /待你确认/);
  click('[data-view="inbox"]');
  assert.equal(count('.notice.attention'), 2);
});

scenario('Empty feedback is rejected without resolving the task', ({ click, detailAction, get, Event }) => {
  click('[data-view="inbox"]');
  click('[data-notice="notice-attention"]');
  detailAction('提出修改');
  get('notice-feedback').value = '   ';
  get('notice-feedback-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  assert.match(get('notice-feedback-error').textContent, /请填写/);
  click('[data-view="flows"]');
  assert.match(get('flow-list').textContent, /待你确认/);
});

scenario('Approval progresses to output and sends a completion message', ({ click, detailAction, get }) => {
  click('[data-view="inbox"]');
  click('[data-notice="notice-attention"]');
  const action = detailAction('接受建议并继续');
  action.click();
  detailAction('在画布定位 ↗');
  click('#advance');
  assert.match(get('context-state').textContent, /已完成/);
  click('[data-view="inbox"]');
  assert.match(get('notice-list').textContent, /交付结果草案已完成/);
});

scenario('Inbox locates the correct workflow, snapshot and node', ({ click, detailAction, document, get, visible }) => {
  click('[data-view="inbox"]');
  click('[data-notice="notice-failed"]');
  detailAction('在画布定位 ↗');
  assert.equal(visible('studio-view'), true);
  assert.match(get('canvas-title').textContent, /客户反馈/);
  assert.equal(document.querySelector('.node.selected').dataset.node, 'source');
  assert.match(get('inspector').textContent, /执行失败/);
});

scenario('Filters combine with flow search', ({ click, get, count, Event }) => {
  click('[data-view="flows"]');
  click('[data-flow-filter="attention"]');
  assert.equal(count('.flow-row'), 2);
  get('flow-search').value = '客户反馈';
  get('flow-search').dispatchEvent(new Event('input'));
  assert.equal(count('.flow-row'), 1);
  click('[data-flow-filter="done"]');
  assert.equal(count('.flow-row'), 0);
});

scenario('Failure simulation produces an actionable message', ({ click, get, count }) => {
  click('#start-run');
  click('#simulate-error');
  assert.match(get('context-state').textContent, /执行失败/);
  click('[data-view="inbox"]');
  click('[data-inbox-filter="failed"]');
  assert.equal(count('.notice'), 2);
});

scenario('Canvas opens associated message even after incompatible inbox filter', ({ click, detailAction, document, get, Event, visible }) => {
  click('[data-view="inbox"]');
  click('[data-notice="notice-failed"]');
  detailAction('在画布定位 ↗');
  click('[data-view="inbox"]');
  click('[data-inbox-filter="done"]');
  get('inbox-search').value = '资料报告';
  get('inbox-search').dispatchEvent(new Event('input'));
  click('[data-view="studio"]');
  const action = [...document.querySelectorAll('#inspector button')].find(item => item.textContent === '打开关联消息 →');
  assert.ok(action);
  action.click();
  assert.equal(visible('inbox-view'), true);
  assert.equal(get('inbox-search').value, '');
  assert.match(get('notice-detail').textContent, /读取反馈失败/);
  assert.match(get('notice-detail').textContent, /重试此节点/);
});

scenario('Unique DOM IDs and no external assets', ({ document, count }) => {
  const ids = [...document.querySelectorAll('[id]')].map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(count('script[src],link[rel="stylesheet"],iframe'), 0);
});
