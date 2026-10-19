import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jsonLines, rpcClient, validateCommand, validateServer, within } from './live-update-smoke-mcp.mjs';

test('MCP lines preserve split Chinese and emoji bytes', () => {
  const stream = new PassThrough();
  const values = [];
  const stop = jsonLines(stream, (value) => values.push(value), assert.fail);
  const bytes = Buffer.from(`${JSON.stringify({ value: '中文🙂' })}\n`);
  for (const byte of bytes) stream.write(Buffer.from([byte]));
  assert.deepEqual(values, [{ value: '中文🙂' }]);
  stop();
});

test('MCP parser bounds unfinished lines and rejects malformed JSON without raw content', () => {
  for (const [input, expected] of [['x'.repeat(17), 'FIXTURE_PROTOCOL_LINE_LIMIT'], ['secret-token\n', 'FIXTURE_PROTOCOL_JSON_INVALID']]) {
    const stream = new PassThrough();
    let error;
    jsonLines(stream, assert.fail, (value) => { error = value; }, 16, 32);
    stream.write(input);
    assert.equal(error.code, expected);
    assert.equal(error.message, expected);
  }
});

test('RPC preserves full result, sanitizes errors and limits pending calls', async () => {
  const server = { stdin: new PassThrough(), stdout: new PassThrough() };
  const sent = [];
  jsonLines(server.stdin, (message) => sent.push(message), assert.fail);
  const rpc = rpcClient(server, assert.fail);
  const result = { content: [{ type: 'text', text: '中文🙂' }], isError: false };
  const first = rpc.call('tools/call', {});
  server.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: sent[0].id, result })}\n`);
  assert.deepEqual(await first, result);
  const second = rpc.call('tools/call', {});
  server.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: sent[1].id, error: { message: 'token-secret' } })}\n`);
  await assert.rejects(second, { message: 'FIXTURE_MCP_RPC_ERROR' });
  const pending = Array.from({ length: 4 }, () => rpc.call('tools/call', {}).catch((error) => error.code));
  await assert.rejects(rpc.call('tools/call', {}), { message: 'FIXTURE_RPC_PENDING_LIMIT' });
  rpc.close();
  assert.deepEqual(await Promise.all(pending), Array(4).fill('FIXTURE_HELPER_STOPPED'));
});

test('RPC timeout is a single send without automatic retry', async () => {
  const server = { stdin: new PassThrough(), stdout: new PassThrough() };
  let calls = 0;
  jsonLines(server.stdin, () => { calls += 1; }, assert.fail);
  const rpc = rpcClient(server, assert.fail);
  await assert.rejects(rpc.call('tools/call', {}, 5), { message: 'FIXTURE_RPC_TIMEOUT' });
  assert.equal(calls, 1);
  rpc.close();
});

test('fixture validation confines directories and validates executable, IDs and hashes', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ccgui-helper-test-')));
  try {
    const executable = path.join(root, 'ccgui-next.exe');
    await fs.writeFile(executable, 'fixture placeholder; never launched');
    const server = { command: executable, args: ['--host-chat-mcp', '--dev-profile', root], env: { FIXTURE: 'yes' } };
    assert.equal(await validateServer({ mcpServers: { ccgui: server } }, root), server);
    const command = { id: 'prepare_1', packageDir: root, manifestSha256: 'a'.repeat(64) };
    assert.equal(await validateCommand(command, root), command);
    await assert.rejects(validateCommand({ ...command, packageDir: path.dirname(root) }, root), { code: 'FIXTURE_DIRECTORY_OUTSIDE_ROOT' });
    await assert.rejects(validateCommand({ ...command, id: '../escape' }, root), { code: 'FIXTURE_COMMAND_INVALID' });
    await assert.rejects(validateCommand({ ...command, manifestSha256: 'A'.repeat(64) }, root), { code: 'FIXTURE_COMMAND_INVALID' });
    await assert.rejects(validateServer({ mcpServers: { ccgui: { ...server, args: [] } } }, root), { code: 'FIXTURE_SERVER_CONFIG_INVALID' });
    await validateCommand({ action: 'status', id: 'status-1', manifestSha256: command.manifestSha256 }, root);
    assert.equal(within(root, `${root}-other`), false);
  } finally {
    // The resolved temporary path is the exact directory created by this test.
    assert.match(path.basename(root), /^ccgui-helper-test-/);
    await fs.rm(root, { recursive: true, force: true });
  }
});
