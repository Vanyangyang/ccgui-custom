import test from 'node:test';
import assert from 'node:assert/strict';
import { FixtureRemoteObserver } from './live-update-smoke-remote.mjs';

class Socket {
  static OPEN = 1;
  static all = [];
  readyState = 1;
  sent = [];
  listeners = new Map();
  constructor() { Socket.all.push(this); }
  addEventListener(name, callback) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]); }
  emit(name, event = {}) { for (const callback of this.listeners.get(name) ?? []) callback(event); }
  message(value) { this.emit('message', { data: JSON.stringify(value) }); }
  hello() { this.message({ type: 'hello', version: 'fixture' }); }
  send(frame) { this.sent.push(JSON.parse(frame)); }
  close() { this.readyState = 3; this.emit('close'); }
  reply(frame, payload) { this.message({ type: 'response', id: frame.id, ok: true, payload }); }
}
const event = (seq, text = `片段${seq}😀`) => ({ stream_id: 'worker-a', seq, name: 'engine://event', payload: [{ kind: 'delta', data: text }] });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(t) {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  Socket.all = [];
  const observer = new FixtureRemoteObserver({ port: 1234, token: 'synthetic-fixture-token', streamId: 'worker-a' });
  t.after(() => { observer.close(); globalThis.WebSocket = original; });
  return observer;
}

test('retains an identical read frame across reconnect and merges ordered live/replay events', async t => {
  const observer = fixture(t);
  const started = observer.start();
  const first = Socket.all[0];
  first.hello(); await started;
  const syncing = observer.sync(); await flush();
  assert.equal(first.sent[0].cmd, 'runtime_worker_sources');
  assert.deepEqual(first.sent[0].args, { streamIds: ['worker-a'] });
  first.reply(first.sent[0], [{ streamId: 'worker-a', head: 3 }]); await flush();
  const original = first.sent[1];
  first.message({ type: 'event', name: 'runtime://worker-event', payload: event(2) });
  assert.equal(observer.summary.cursor, 0);
  first.close();
  await new Promise(resolve => setTimeout(resolve, 120));
  const second = Socket.all[1];
  assert.deepEqual(second.sent, []);
  second.hello();
  assert.deepEqual(second.sent, [original]);
  second.reply(original, { stream_id: 'worker-a', through: 3, events: [event(1), event(2), event(3)] });
  await syncing;
  assert.equal(observer.text, '片段1😀片段2😀片段3😀');
  assert.deepEqual(observer.consumed.map(item => item.seq), [1, 2, 3]);
  assert.equal(observer.summary.helloCount, 2);
  assert.equal(observer.summary.reconnectCount, 1);
  second.message({ type: 'event', name: 'runtime://worker-event', payload: event(2) });
  assert.equal(observer.summary.cursor, 3);
  assert.equal(observer.summary.duplicateIgnoredCount, 2);
  assert.equal(observer.error, null);
  assert.ok(!JSON.stringify(observer.summary).includes('token'));
});

test('fails on a missing replay prefix without consuming later sequence numbers', async t => {
  const observer = fixture(t);
  const started = observer.start(); const socket = Socket.all[0]; socket.hello(); await started;
  const syncing = observer.sync(); await flush();
  socket.reply(socket.sent[0], [{ streamId: 'worker-a', head: 2 }]); await flush();
  socket.reply(socket.sent[1], { stream_id: 'worker-a', through: 2, events: [event(2)] });
  await assert.rejects(syncing, /complete event prefix/);
  assert.equal(observer.summary.cursor, 0);
  assert.ok(observer.error);
  await assert.rejects(observer.ready());
});

test('rejects conflicting consumed duplicates and closes pending waiters cleanly', async t => {
  const observer = fixture(t);
  const started = observer.start(); const socket = Socket.all[0]; socket.hello(); await started;
  socket.message({ type: 'event', name: 'runtime://worker-event', payload: event(1) });
  socket.message({ type: 'event', name: 'runtime://worker-event', payload: event(1, 'conflicting') });
  assert.ok(observer.error);
  assert.equal(observer.text, '片段1😀');
  await assert.rejects(observer.sync());
  const another = new FixtureRemoteObserver({ port: 1234, token: 'fixture-only', streamId: 'worker-b' });
  const waiting = another.start(); another.close();
  await assert.rejects(waiting, /closed/);
  assert.equal(another.error, null);
});

test('periodic reconciliation is non-reentrant and recovers a missing final live frame', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const observer = fixture(t);
  const started = observer.start(); const socket = Socket.all[0]; socket.hello(); await started;
  t.mock.timers.tick(2000); await flush();
  assert.equal(socket.sent.length, 1);
  t.mock.timers.tick(6000); await flush();
  assert.equal(socket.sent.length, 1, 'a stalled sync must not launch another reconcile');
  socket.reply(socket.sent[0], [{ streamId: 'worker-a', head: 1 }]); await flush();
  socket.reply(socket.sent[1], { stream_id: 'worker-a', through: 1, events: [event(1)] }); await flush();
  assert.equal(observer.text, '片段1😀');
  assert.equal(observer.error, null);
});

test('a read rejected before socket closure retries without advancing or replacing its request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const observer = fixture(t);
  const started = observer.start(); const socket = Socket.all[0]; socket.hello(); await started;
  const syncing = observer.sync(); await flush();
  const request = socket.sent[0];
  socket.message({ type: 'response', id: request.id, ok: false, error: 'host is retiring' });
  assert.equal(observer.summary.cursor, 0);
  assert.equal(observer.error, null);
  t.mock.timers.tick(2000); await flush();
  assert.deepEqual(socket.sent[1], request);
  socket.reply(request, [{ streamId: 'worker-a', head: 1 }]); await flush();
  socket.reply(socket.sent[2], { stream_id: 'worker-a', through: 1, events: [event(1)] });
  await syncing;
  assert.equal(observer.text, '片段1😀');
  assert.equal(observer.summary.readRetries, 1);
  assert.equal(observer.summary.cursor, 1);
});
