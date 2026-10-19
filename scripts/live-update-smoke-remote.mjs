/** Fixture-only loopback observer. Never log the credential, socket URL or events. */
const REQUEST_TIMEOUT = 180_000;
const BUFFER_LIMIT = 4096;
const EVENT_LIMIT = 10_000;

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export class FixtureRemoteObserver {
  constructor({ port, token, streamId }) {
    if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== 'string' || !token
      || typeof streamId !== 'string' || !streamId) throw new Error('Invalid remote observer configuration');
    this._port = port;
    this._token = token;
    this._streamId = streamId;
    this._socket = null;
    this._helloSocket = null;
    this._started = false;
    this._closed = false;
    this._error = null;
    this._nextId = 1;
    this._pending = new Map();
    this._waiters = new Set();
    this._buffer = new Map();
    this._events = [];
    this._fingerprints = [];
    this._cursor = 0;
    this._helloCount = 0;
    this._reconnectCount = 0;
    this._duplicates = 0;
    this._readRetries = 0;
    this._retryTimer = null;
    this._reconcileTimer = null;
    this._syncTail = Promise.resolve();
    this._syncCount = 0;
  }

  get error() { return this._error; }
  get consumed() { return this._events.slice(); }
  get summary() {
    return { port: this._port, helloCount: this._helloCount, cursor: this._cursor,
      eventCount: this._events.length, reconnectCount: this._reconnectCount, duplicateIgnoredCount: this._duplicates,
      readRetries: this._readRetries };
  }
  get text() {
    return this._events.filter(event => event.name === 'engine://event')
      .flatMap(event => Array.isArray(event.payload) ? event.payload : [])
      .filter(event => event?.kind === 'delta' && typeof event.data === 'string')
      .map(event => event.data).join('');
  }

  start() {
    if (!this._started && !this._closed && !this._error) {
      this._started = true;
      this._connect();
      this._reconcileTimer = setInterval(() => {
        if (!this._closed && !this._error && this._syncCount === 0) this.sync().catch(() => {});
      }, 2000);
    }
    return this.ready();
  }

  ready() {
    const unavailable = this._unavailable();
    if (unavailable) return this._observed(Promise.reject(unavailable));
    if (this._helloSocket && this._helloSocket === this._socket) return Promise.resolve();
    const promise = new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => this._fail('Remote observer handshake timed out'), REQUEST_TIMEOUT);
      this._waiters.add(waiter);
    });
    return this._observed(promise);
  }

  sync() {
    this._syncCount++;
    const result = this._syncTail.then(() => this._synchronize()).finally(() => { this._syncCount--; });
    this._syncTail = result.catch(() => {});
    return this._observed(result);
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._shutdown(new Error('Remote observer closed'));
  }

  _observed(promise) {
    // A caller may attach its assertion later. Preserve rejection for awaiters
    // while preventing process-level unhandled rejection noise in the fixture.
    promise.catch(() => {});
    return promise;
  }

  _unavailable() { return this._error ?? (this._closed ? new Error('Remote observer closed') : null); }

  _fail(message) {
    if (this._error || this._closed) return;
    this._error = new Error(message);
    this._shutdown(this._error);
  }

  _shutdown(error) {
    clearTimeout(this._retryTimer);
    clearInterval(this._reconcileTimer);
    this._retryTimer = this._reconcileTimer = null;
    for (const pending of this._pending.values()) { clearTimeout(pending.timer); clearTimeout(pending.retryTimer); pending.reject(error); }
    this._pending.clear();
    for (const waiter of this._waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
    this._waiters.clear();
    const socket = this._socket;
    this._socket = this._helloSocket = null;
    try { socket?.close(); } catch { /* Already closed. */ }
  }

  _connect() {
    if (this._unavailable()) return;
    let socket;
    try { socket = new WebSocket(`ws://127.0.0.1:${this._port}/ws?token=${encodeURIComponent(this._token)}`); }
    catch { this._fail('Remote observer could not create a loopback connection'); return; }
    this._socket = socket;
    socket.addEventListener('message', event => {
      if (this._socket !== socket || this._unavailable()) return;
      try {
        if (typeof event.data !== 'string') throw new Error();
        const message = JSON.parse(event.data);
        if (message.type === 'hello') {
          if (this._helloSocket === socket) return;
          this._helloSocket = socket;
          this._helloCount++;
          for (const waiter of this._waiters) { clearTimeout(waiter.timer); waiter.resolve(); }
          this._waiters.clear();
          this._sendPending();
        } else if (message.type === 'response') {
          const pending = this._pending.get(message.id);
          if (!pending) return;
          if (message.ok === true) {
            this._pending.delete(message.id);
            clearTimeout(pending.timer); clearTimeout(pending.retryTimer);
            pending.resolve(message.payload);
          }
          else {
            const detail = typeof message.error === 'string'
              ? message.error.replaceAll(this._token, '<redacted>').replace(/(?:https?|wss?):\/\/\S+/g, '<url>').slice(0, 240)
              : 'unspecified server error';
            // The retiring host can reject a read before its socket closes.
            // Like the production adapter's periodic reconciliation, retry only
            // these read-only requests; retain the original deadline and cursor.
            pending.lastError = detail;
            if (!pending.retryTimer) {
              this._readRetries++;
              pending.retryTimer = setTimeout(() => {
                pending.retryTimer = null;
                if (this._pending.get(message.id) !== pending) return;
                pending.sentOn = null; this._sendPending();
              }, 2000);
            }
          }
        } else if (message.type === 'event' && message.name === 'runtime://worker-event') {
          if (message.payload?.stream_id === this._streamId) this._accept(message.payload);
        }
      } catch { this._fail('Remote observer received invalid or conflicting event data'); }
    });
    socket.addEventListener('close', () => {
      if (this._socket !== socket || this._unavailable()) return;
      this._socket = this._helloSocket = null;
      this._reconnectCount++;
      if (!this._retryTimer) this._retryTimer = setTimeout(() => { this._retryTimer = null; this._connect(); }, 100);
    });
    // Node WebSocket follows connection errors with close; it is the single
    // owner of reconnect scheduling. Never disclose an error's token-bearing URL.
    socket.addEventListener('error', () => {});
  }

  _sendPending() {
    const socket = this._socket;
    if (!socket || socket !== this._helloSocket || socket.readyState !== WebSocket.OPEN) return;
    for (const pending of this._pending.values()) {
      if (pending.sentOn === socket) continue;
      try { socket.send(pending.frame); pending.sentOn = socket; }
      catch { try { socket.close(); } catch { this._fail('Remote observer socket failed'); } return; }
    }
  }

  _invoke(command, args) {
    const unavailable = this._unavailable();
    if (unavailable) return this._observed(Promise.reject(unavailable));
    const id = this._nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this._fail(`Remote observer read request timed out: ${command}: ${this._pending.get(id)?.lastError ?? 'no response'}`), REQUEST_TIMEOUT);
      this._pending.set(id, { command, frame: JSON.stringify({ type: 'invoke', id, cmd: command, args }), sentOn: null, timer, retryTimer: null, resolve, reject });
    });
    this._sendPending();
    return this._observed(promise);
  }

  _accept(event) {
    if (!event || event.stream_id !== this._streamId || !Number.isSafeInteger(event.seq) || event.seq < 1
      || typeof event.name !== 'string' || !event.name || !Object.hasOwn(event, 'payload')) throw new Error('Invalid event');
    const fingerprint = canonical(event);
    const previous = event.seq <= this._cursor ? this._fingerprints[event.seq - 1] : this._buffer.get(event.seq)?.fingerprint;
    if (previous !== undefined) {
      if (previous !== fingerprint) throw new Error('Conflicting event sequence');
      this._duplicates++;
      return;
    }
    if (this._buffer.size >= BUFFER_LIMIT) {
      this._fail('Remote observer event buffer exceeded 4096 frames');
      throw this._error;
    }
    this._buffer.set(event.seq, { event, fingerprint });
    while (this._buffer.has(this._cursor + 1)) {
      if (this._events.length >= EVENT_LIMIT) {
        this._fail('Remote observer consumed event limit exceeded 10000 frames');
        throw this._error;
      }
      const entry = this._buffer.get(this._cursor + 1);
      this._buffer.delete(this._cursor + 1);
      this._events.push(entry.event);
      this._fingerprints.push(entry.fingerprint);
      this._cursor++;
    }
  }

  async _synchronize() {
    try {
      await this.ready();
      const sources = await this._invoke('runtime_worker_sources', { streamIds: [this._streamId] });
      if (!Array.isArray(sources)) throw new Error();
      const source = sources.find(item => item?.streamId === this._streamId);
      if (!source || !Number.isSafeInteger(source.head) || source.head < 0) throw new Error();
      const target = source.head;
      // Real-time traffic may have advanced past the head captured by discovery.
      let pages = 0;
      while (this._cursor < target) {
        if (++pages > EVENT_LIMIT) throw new Error();
        const before = this._cursor;
        const batch = await this._invoke('runtime_worker_events', { streamId: this._streamId, after: before, limit: 128 });
        if (!batch || batch.stream_id !== this._streamId || !Number.isSafeInteger(batch.through)
          || batch.through < before || !Array.isArray(batch.events) || batch.events.length > 128) throw new Error();
        // Validate the complete replay prefix before consuming any of this page.
        let expected = before;
        for (const event of batch.events) {
          if (event.stream_id !== this._streamId || event.seq !== ++expected) throw new Error();
          const previous = event.seq <= this._cursor ? this._fingerprints[event.seq - 1] : this._buffer.get(event.seq)?.fingerprint;
          if (previous !== undefined && previous !== canonical(event)) throw new Error();
        }
        if (expected !== batch.through) throw new Error();
        for (const event of batch.events) this._accept(event);
        if (this._cursor <= before) throw new Error();
      }
      const unavailable = this._unavailable();
      if (unavailable) throw unavailable;
      return this.summary;
    } catch (error) {
      if (!this._unavailable()) this._fail('Remote observer could not reconcile a complete event prefix');
      throw this._unavailable() ?? error;
    }
  }
}
