// Exercises a freshly built MCP executable against an isolated capability endpoint.
// No user tokens, conversations, model requests, or running GUI are accessed.
// The retained filename checks trusted task capability, not a user-controlled
// Leader mode. Retired leader_* tools must reject without forwarding; there
// are no aliases. This does not establish real relay authorization or recovery.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import path from 'node:path';

const executable = process.argv[2];
if (!executable || !path.isAbsolute(executable)) throw new Error('Pass an absolute path to a trusted, freshly built CC GUI executable');

async function checkCapabilities(capabilityResponse) {
  const taskCapability = typeof capabilityResponse === 'object' && capabilityResponse !== null ? Boolean(capabilityResponse.taskTools) : false;
  const selfUpdate = typeof capabilityResponse === 'object' && capabilityResponse !== null ? Boolean(capabilityResponse.selfUpdate) : false;
  const token = randomUUID();
  const requests = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const body = JSON.parse(text); requests.push(body.method);
    if (taskCapability && body.method === 'task_list') {
      assert.deepEqual(body.arguments, {});
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ result: { branches: [], modelPolicy: { agy: { allowedModels: null, defaultModel: 'gemini-4-argon' } } } }));
      return;
    }
    if (taskCapability && body.method === 'task_spawn') {
      assert.equal(body.arguments.engine, 'agy');
      assert.equal(body.arguments.model, 'gemini-4-argon');
      assert.equal(body.arguments.effort, 'high');
      assert.equal(body.arguments.request_id, 'task-contract-smoke');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ result: { requestId: 'task-contract-smoke', requestState: 'accepted', branch: { id: 'fixture-child', state: 'starting' } } }));
      return;
    }
    assert.equal(body.method, 'get_host_capabilities', 'only current public task names may reach the relay');
    assert.deepEqual(body.arguments, {});
    response.writeHead(capabilityResponse === null ? 400 : capabilityResponse === 'denied' ? 401 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(capabilityResponse === null ? { error: 'Unsupported host chat method' }
      : capabilityResponse === 'denied' ? { error: 'Host chat token is missing or expired' } : { result: capabilityResponse }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(executable, ['--host-chat-mcp'], { windowsHide: true,
    env: { ...process.env, CCGUI_HOST_CHAT_URL: `http://127.0.0.1:${server.address().port}/host-chat`, CCGUI_HOST_CHAT_TOKEN: token },
    stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let id = 0; let stderr = '';
  const lines = createInterface({ input: child.stdout });
  lines.on('line', text => {
    const message = JSON.parse(text);
    const waiter = pending.get(message.id);
    if (waiter) { clearTimeout(waiter.timer); pending.delete(message.id); waiter.resolve(message); }
  });
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  const finished = new Promise(resolve => child.once('exit', resolve));
  child.once('error', error => { for (const waiter of pending.values()) waiter.reject(error); });
  child.once('exit', () => { for (const waiter of pending.values()) waiter.reject(new Error(`MCP exited: ${stderr}`)); });
  function call(method, params) {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`MCP ${method} timed out`)); }, 10_000);
      pending.set(requestId, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
    });
  }
  try {
    if (capabilityResponse === 'denied' || capabilityResponse === null || typeof capabilityResponse.taskTools !== 'boolean') {
      await assert.rejects(call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ccgui-capability-fixture', version: '1' } }), /MCP exited/);
      assert.deepEqual(requests, ['get_host_capabilities']);
      return { rejectedCapability: true, passed: true };
    }
    const initialized = await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ccgui-capability-fixture', version: '1' } });
    assert.ok(initialized.result, JSON.stringify(initialized.error));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const listed = await call('tools/list', {});
    const tools = listed.result.tools;
    const taskTools = ['task_spawn', 'task_list', 'task_wait', 'task_send', 'task_renew', 'task_stop'];
    assert.deepEqual(tools.filter(tool => tool.name.startsWith('task_')).map(tool => tool.name).sort(), taskCapability ? [...taskTools].sort() : []);
    assert.equal(tools.filter(tool => tool.name.startsWith('leader_')).length, 0, 'retired names are not public MCP tools');
    assert.equal(tools.filter(tool => ['coordinate_self_update', 'prepare_self_update', 'get_self_update_status'].includes(tool.name)).length, selfUpdate ? 3 : 0);
    assert.equal(tools.length, 3 + (selfUpdate ? 3 : 0) + (taskCapability ? 6 : 0));
    assert.equal(tools.some(tool => tool.name === 'coordinate_self_update'), selfUpdate);
    assert.ok(!tools.some(tool => tool.name === 'get_host_capabilities'));
    for (const tool of tools) assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(initialized.result.instructions.includes('task_spawn'), taskCapability);
    assert.equal(initialized.result.instructions.includes('ccgui-self-update'), selfUpdate);
    for (const name of ['leader_spawn', 'leader_list', 'leader_wait', 'leader_send', 'leader_renew', 'leader_stop', 'leader_reclaim']) {
      const retired = await call('tools/call', { name, arguments: {} });
      assert.ok(retired.error || retired.result?.isError, `${name} must reject without forwarding`);
    }
    if (!taskCapability) {
      const hidden = await call('tools/call', { name: 'task_list', arguments: {} });
      assert.ok(hidden.error || hidden.result?.isError, 'hidden tool must not dispatch');
    } else {
      const list = await call('tools/call', { name: 'task_list', arguments: {} });
      assert.equal(list.result?.isError, false);
      assert.equal(JSON.parse(list.result.content[0].text).modelPolicy.agy.defaultModel, 'gemini-4-argon');
      const created = await call('tools/call', { name: 'task_spawn', arguments: {
        engine: 'agy', model: 'gemini-4-argon', effort: 'high', request_id: 'task-contract-smoke',
        title: 'Contract fixture', task: 'Fixture only; no real model or conversation is started.',
      } });
      assert.equal(created.result?.isError, false);
      assert.equal(JSON.parse(created.result.content[0].text).branch.id, 'fixture-child');
    }
    if (!selfUpdate) {
      const hidden = await call('tools/call', { name: 'get_self_update_status', arguments: {} });
      assert.ok(hidden.error || hidden.result?.isError, 'hidden self-update tool must not dispatch');
    }
    assert.deepEqual(requests, taskCapability ? ['get_host_capabilities', 'task_list', 'task_spawn'] : ['get_host_capabilities']);
    return { taskCapability, selfUpdate, capabilityUnavailable: capabilityResponse === null, tools: tools.map(tool => tool.name), instructionsCharacters: initialized.result.instructions.length, passed: true };
  } finally {
    for (const waiter of pending.values()) clearTimeout(waiter.timer);
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 2000);
    await finished; clearTimeout(timer); lines.close();
    await new Promise(resolve => server.close(resolve));
  }
}

console.log(JSON.stringify({
  checks: [
    await checkCapabilities({ taskTools: false, selfUpdate: false }),
    await checkCapabilities({ taskTools: false, selfUpdate: true }),
    await checkCapabilities({ taskTools: true, selfUpdate: false }),
    await checkCapabilities({ taskTools: true, selfUpdate: true }),
    await checkCapabilities({ leaderMode: true, selfUpdate: false }), // Retired field cannot grant task capability.
    await checkCapabilities(null),
    await checkCapabilities('denied'),
  ],
}, null, 2));
