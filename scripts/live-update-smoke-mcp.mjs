import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const CONFIG_LIMIT = 64 * 1024;
const LINE_LIMIT = 1024 * 1024;
const BUFFER_LIMIT = 2 * LINE_LIMIT;
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const fail = (code) => Object.assign(new Error(code), { code });
const errorCode = (error) => /^FIXTURE_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'FIXTURE_INTERNAL_ERROR';

export function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function ordinary(file, directory = false) {
  const stat = await fs.lstat(file).catch(() => { throw fail('FIXTURE_PATH_UNAVAILABLE'); });
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) throw fail('FIXTURE_PATH_INVALID');
}

async function containedDirectory(root, candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) throw fail('FIXTURE_DIRECTORY_INVALID');
  await ordinary(candidate, true);
  const real = await fs.realpath(candidate);
  if (!within(root, real)) throw fail('FIXTURE_DIRECTORY_OUTSIDE_ROOT');
  return real;
}

export async function validateServer(config, root) {
  const server = config?.mcpServers?.ccgui;
  if (!server || typeof server.command !== 'string' || !path.isAbsolute(server.command)
      || path.basename(server.command).toLowerCase() !== 'ccgui-next.exe'
      || !Array.isArray(server.args) || !server.args.every((arg) => typeof arg === 'string')
      || !server.args.includes('--host-chat-mcp')) throw fail('FIXTURE_SERVER_CONFIG_INVALID');
  await ordinary(server.command);
  const profileIndex = server.args.indexOf('--dev-profile');
  const profile = profileIndex >= 0 ? server.args[profileIndex + 1]
    : server.args.find((arg) => arg.startsWith('--dev-profile='))?.slice('--dev-profile='.length);
  await containedDirectory(root, profile);
  if (server.env !== undefined && (!server.env || typeof server.env !== 'object' || Array.isArray(server.env)
      || !Object.entries(server.env).every(([key, value]) => key && !key.includes('=') && !key.includes('\0') && typeof value === 'string' && !value.includes('\0')))) {
    throw fail('FIXTURE_SERVER_ENV_INVALID');
  }
  return server;
}

export async function validateCommand(command, root) {
  if (!command || typeof command.id !== 'string' || !SAFE_ID.test(command.id)
      || typeof command.manifestSha256 !== 'string' || !SHA256.test(command.manifestSha256)
      || !['prepare', 'status'].includes(command.action ?? 'prepare')) throw fail('FIXTURE_COMMAND_INVALID');
  if ((command.action ?? 'prepare') === 'prepare') await containedDirectory(root, command.packageDir);
  return command;
}

export function jsonLines(stream, onMessage, onError, lineLimit = LINE_LIMIT, bufferLimit = BUFFER_LIMIT) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let stopped = false;
  const stop = () => { stopped = true; stream.off('data', data); stream.off('end', end); };
  const report = (code) => { stop(); onError(fail(code)); };
  const consume = (text) => {
    buffer += text;
    if (Buffer.byteLength(buffer) > bufferLimit) return report('FIXTURE_PROTOCOL_BUFFER_LIMIT');
    let newline;
    while (!stopped && (newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > lineLimit) return report('FIXTURE_PROTOCOL_LINE_LIMIT');
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { return report('FIXTURE_PROTOCOL_JSON_INVALID'); }
      onMessage(message);
    }
    if (!stopped && Buffer.byteLength(buffer) > lineLimit) report('FIXTURE_PROTOCOL_LINE_LIMIT');
  };
  const data = (chunk) => consume(decoder.write(chunk));
  const end = () => {
    consume(decoder.end());
    if (!stopped && buffer.trim()) report('FIXTURE_PROTOCOL_TRUNCATED_LINE');
  };
  stream.on('data', data);
  stream.on('end', end);
  return stop;
}

function readConfig(stream, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(fail('FIXTURE_CONFIG_TIMEOUT')), 30_000);
    let stop;
    let finished = false;
    const end = () => { if (!finished) finish(fail('FIXTURE_CONFIG_MISSING')); };
    const abort = () => finish(fail('FIXTURE_HELPER_STOPPED'));
    const finish = (error, config) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stop?.();
      stream.off('end', end);
      signal.removeEventListener('abort', abort);
      // The parent may close stdin immediately after sending configuration.
      stream.resume();
      error ? reject(error) : resolve(config);
    };
    stop = jsonLines(stream, (config) => finish(null, config), finish, CONFIG_LIMIT, CONFIG_LIMIT + 1);
    stream.on('end', end);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function rpcClient(server, onFatal) {
  const pending = new Map();
  let nextId = 0;
  const write = (message) => {
    if (server.stdin.destroyed || !server.stdin.writable) throw fail('FIXTURE_SERVER_STDIN_CLOSED');
    server.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const stopLines = jsonLines(server.stdout, (message) => {
    if (message?.jsonrpc !== '2.0') return onFatal(fail('FIXTURE_PROTOCOL_MESSAGE_INVALID'));
    if (message.id === undefined) return;
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(fail('FIXTURE_MCP_RPC_ERROR'));
    else if (Object.hasOwn(message, 'result')) item.resolve(message.result);
    else item.reject(fail('FIXTURE_MCP_RESULT_MISSING'));
  }, onFatal);
  return {
    notify(method, params) { write({ jsonrpc: '2.0', method, params }); },
    call(method, params, timeout = 240_000) {
      if (pending.size >= 4) return Promise.reject(fail('FIXTURE_RPC_PENDING_LIMIT'));
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(fail('FIXTURE_RPC_TIMEOUT')); }, timeout);
        pending.set(id, { resolve, reject, timer });
        try { write({ jsonrpc: '2.0', id, method, params }); } catch (error) {
          clearTimeout(timer); pending.delete(id); reject(error);
        }
      });
    },
    close() {
      stopLines();
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(fail('FIXTURE_HELPER_STOPPED')); }
      pending.clear();
    },
  };
}

async function writeJson(workspace, name, data) {
  const temp = path.join(workspace, `.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, JSON.stringify(data), { flag: 'wx' });
    await fs.rename(temp, path.join(workspace, name));
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}

export async function main(argv = process.argv.slice(2)) {
  let workspace;
  let server;
  let rpc;
  let interval;
  let lifetime;
  let keepWatcher;
  const abortController = new AbortController();
  let stopping = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const cleanup = async (error) => {
    if (stopping) return;
    stopping = true;
    clearInterval(interval);
    clearInterval(keepWatcher);
    clearTimeout(lifetime);
    abortController.abort();
    process.off('SIGINT', signal);
    process.off('SIGTERM', signal);
    rpc?.close();
    if (error) {
      process.exitCode = 1;
      if (workspace) await writeJson(workspace, 'self-update-mcp-error.json', { error: errorCode(error) }).catch(() => {});
    }
    if (server && server.exitCode === null && server.signalCode === null) {
      server.stdin.end();
      await new Promise((resolve) => {
        const timer = setTimeout(() => { server.kill(); resolve(); }, 1000);
        server.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    process.stdin.pause();
    resolveDone();
  };
  const signal = () => { void cleanup(); };
  try {
    if (argv.length !== 1 || !path.isAbsolute(argv[0])) throw fail('FIXTURE_WORKSPACE_INVALID');
    await ordinary(argv[0], true);
    workspace = await fs.realpath(argv[0]);
    const root = await fs.realpath(path.dirname(workspace));
    await ordinary(path.join(workspace, 'keep-running'));
    process.on('SIGINT', signal);
    process.on('SIGTERM', signal);
    lifetime = setTimeout(() => { void cleanup(); }, 8 * 60_000);
    let checkingKeep = false;
    keepWatcher = setInterval(async () => {
      if (checkingKeep || stopping) return;
      checkingKeep = true;
      try { await ordinary(path.join(workspace, 'keep-running')); }
      catch { await cleanup(); }
      finally { checkingKeep = false; }
    }, 150);
    const config = await readConfig(process.stdin, abortController.signal);
    if (stopping) return done;
    const definition = await validateServer(config, root);
    if (stopping) return done;
    server = spawn(definition.command, definition.args, {
      cwd: workspace, env: { ...process.env, ...definition.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    server.on('error', () => { void cleanup(fail('FIXTURE_SERVER_SPAWN_FAILED')); });
    server.on('exit', () => { if (!stopping) void cleanup(fail('FIXTURE_SERVER_EXITED')); });
    server.stdin.on('error', () => { if (!stopping) void cleanup(fail('FIXTURE_SERVER_STDIN_FAILED')); });
    rpc = rpcClient(server, (error) => { void cleanup(error); });
    await rpc.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } }, 30_000);
    rpc.notify('notifications/initialized', {});
    const listing = await rpc.call('tools/list', {}, 30_000);
    if (!['prepare_self_update', 'get_self_update_status'].every((name) => listing?.tools?.some((tool) => tool.name === name))) throw fail('FIXTURE_REQUIRED_TOOLS_MISSING');
    await writeJson(workspace, 'self-update-mcp-ready.json', { pid: process.pid, serverPid: server.pid });
    const seen = new Set();
    let reading = false;
    interval = setInterval(async () => {
      if (stopping || reading) return;
      reading = true;
      try {
        const keep = path.join(workspace, 'keep-running');
        try { await ordinary(keep); } catch { await cleanup(); return; }
        const file = path.join(workspace, 'self-update-command.json');
        const stat = await fs.lstat(file).catch((error) => { if (error.code === 'ENOENT') return null; throw fail('FIXTURE_COMMAND_READ_FAILED'); });
        if (!stat) return;
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > CONFIG_LIMIT) throw fail('FIXTURE_COMMAND_INVALID');
        let command;
        try { command = JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw fail('FIXTURE_COMMAND_JSON_INVALID'); }
        if (typeof command?.id !== 'string' || !SAFE_ID.test(command.id)) throw fail('FIXTURE_COMMAND_INVALID');
        if (seen.has(command.id)) return;
        seen.add(command.id);
        // Dispatch once. Polling continues while the server reconnects after GUI replacement.
        void (async () => {
          let result;
          try {
            await validateCommand(command, root);
            const status = command.action === 'status';
            result = await rpc.call('tools/call', { name: status ? 'get_self_update_status' : 'prepare_self_update', arguments: status
              ? { manifestSha256: command.manifestSha256 }
              : { packageDir: command.packageDir, manifestSha256: command.manifestSha256 } });
          } catch (error) { result = { error: errorCode(error) }; }
          if (!stopping) await writeJson(workspace, `self-update-receipt-${command.id}.json`, result);
        })().catch(() => { void cleanup(fail('FIXTURE_RECEIPT_WRITE_FAILED')); });
      } catch (error) { await cleanup(error); }
      finally { reading = false; }
    }, 150);
    await done;
  } catch (error) { await cleanup(error); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
