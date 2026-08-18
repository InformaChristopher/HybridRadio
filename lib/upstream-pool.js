'use strict';

/**
 * Pool de conexoes upstream com resiliencia.
 *
 * Responsabilidades:
 *  - Manter UMA conexao WebSocket por (target, token), compartilhada por todos
 *    os navegadores conectados (fan-out). Recarregar a pagina nao derruba o
 *    upstream nem exige novo handshake.
 *  - Reconectar sozinho, com backoff exponencial + jitter, independentemente de
 *    haver ou nao clientes conectados.
 *  - Detectar conexoes "meio-abertas" (tipicas de 3G/4G/NAT/wi-fi instavel) via
 *    ping/pong e watchdog de silencio — TCP sozinho nao percebe.
 *  - Guardar o ULTIMO frame de cada tipo de evento (cache de estado) e reenviar
 *    a quem conectar depois. E isso que permite "projetar mesmo com atraso":
 *    o painel mostra a ultima faixa conhecida no instante em que abre, sem
 *    esperar a proxima troca de musica.
 *  - Persistir esse cache em disco para sobreviver a restart do servidor.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { WebSocket } = require('ws');

// ---- Parametros de resiliencia (ajustaveis por env) ----------------------
const num = (name, def) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
};

const RETRY_BASE_MS     = num('HR_RETRY_BASE_MS', 1000);
const RETRY_FACTOR      = 1.8;
const RETRY_MAX_MS      = num('HR_RETRY_MAX_MS', 20000);
const HANDSHAKE_TIMEOUT = num('HR_HANDSHAKE_MS', 15000);
const PING_INTERVAL     = num('HR_PING_MS', 20000);
const SILENCE_LIMIT     = num('HR_SILENCE_MS', 55000);
const IDLE_TTL_MS       = num('HR_IDLE_TTL_MS', 120000);
const SWEEP_INTERVAL    = 30000;
const PERSIST_DEBOUNCE  = 2000;
const CACHE_MAX_EVENTS  = 24;
const CLIENT_BUFFER_MAX = 1 << 20; // 1 MB: acima disso o cliente esta afogado

const CONTROL = '__hr'; // namespace das mensagens de controle proxy -> browser

function jitter(ms) {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}
function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}
function unrefTimer(t) {
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

/** Nome logico do frame, usado como chave do cache de estado. */
function frameName(text) {
  try {
    const msg = JSON.parse(text);
    if (msg && typeof msg === 'object') {
      if (typeof msg.event === 'string' && msg.event) return msg.event;
      if (typeof msg.type === 'string' && msg.type) return msg.type;
    }
  } catch { /* nao-JSON */ }
  return '__raw';
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// =========================================================================
// UpstreamLink — uma conexao upstream compartilhada
// =========================================================================
class UpstreamLink extends EventEmitter {
  constructor(pool, key, { target, token, hello, insecure }) {
    super();
    this.pool = pool;
    this.key = key;
    this.id = sha1(key).slice(0, 12);
    this.target = target;
    this.token = token || '';
    this.hello = hello || '';
    this.insecure = !!insecure;

    this.state = 'idle'; // idle | connecting | open | closed
    this.attempt = 0;
    this.lastError = null;
    this.nextRetryAt = 0;
    this.openedAt = 0;
    this.lastFrameAt = 0;
    this.lastPongAt = 0;
    this.seq = 0;
    this.totalFrames = 0;

    this.cache = new Map(); // name -> { raw, at, seq }
    this.clients = new Set();
    this.lastTouch = Date.now();

    this.ws = null;
    this.retryTimer = null;
    this.handshakeTimer = null;
    this.keepaliveTimer = null;
    this.destroyed = false;
  }

  // ---- ciclo de vida da conexao upstream --------------------------------
  connect() {
    if (this.destroyed) return;
    if (this.state === 'connecting' || this.state === 'open') return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.setState('connecting');

    const headers = {};
    if (this.token) {
      headers['Authorization'] = /^(Bearer|Basic|Token|JWT)\s/i.test(this.token)
        ? this.token
        : `Bearer ${this.token}`;
    }

    let ws;
    try {
      ws = new WebSocket(this.target, {
        headers,
        rejectUnauthorized: !this.insecure,
        handshakeTimeout: HANDSHAKE_TIMEOUT,
        perMessageDeflate: true,
      });
    } catch (err) {
      this.fail(`init: ${err.message}`);
      return;
    }
    this.ws = ws;

    // Cinto e suspensorio: handshakeTimeout do ws cobre o upgrade, mas um TLS
    // travado em rede ruim pode ficar pendurado antes disso.
    this.handshakeTimer = unrefTimer(setTimeout(() => {
      if (this.ws === ws && this.state === 'connecting') {
        try { ws.terminate(); } catch {}
        this.fail('handshake timeout');
      }
    }, HANDSHAKE_TIMEOUT + 5000));

    ws.on('open', () => {
      if (this.ws !== ws) { try { ws.terminate(); } catch {} return; }
      clearTimeout(this.handshakeTimer);
      this.attempt = 0;
      this.lastError = null;
      this.openedAt = Date.now();
      this.lastFrameAt = Date.now();
      this.lastPongAt = Date.now();
      this.setState('open');
      if (this.hello) {
        try { ws.send(this.hello); } catch {}
      }
      this.startKeepalive();
      console.log(`[upstream ${this.id}] aberto -> ${this.target}`);
    });

    ws.on('message', (data, isBinary) => {
      if (this.ws !== ws) return;
      this.lastFrameAt = Date.now();
      this.handleFrame(data, isBinary);
    });

    ws.on('pong', () => { this.lastPongAt = Date.now(); });

    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c) => { if (body.length < 400) body += c.toString(); });
      res.on('end', () => {
        console.error(`[upstream ${this.id}] HTTP ${res.statusCode} ${body.slice(0, 200)}`);
      });
      if (this.ws === ws) this.fail(`HTTP ${res.statusCode}`);
    });

    ws.on('error', (err) => {
      if (this.ws !== ws) return;
      this.fail(err.message);
    });

    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      const why = reason && reason.length ? reason.toString() : `code ${code}`;
      this.fail(why, code);
    });
  }

  startKeepalive() {
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = unrefTimer(setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const quietFor = Date.now() - Math.max(this.lastFrameAt, this.lastPongAt);
      if (quietFor > SILENCE_LIMIT) {
        console.warn(`[upstream ${this.id}] silencio de ${Math.round(quietFor / 1000)}s — derrubando`);
        try { ws.terminate(); } catch {}
        return;
      }
      try { ws.ping(); } catch {}
    }, PING_INTERVAL));
  }

  fail(message, code) {
    clearTimeout(this.handshakeTimer);
    clearInterval(this.keepaliveTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.terminate(); } catch {} }
    if (this.destroyed) return;
    this.lastError = String(message || 'erro').slice(0, 160);
    if (code) this.lastError += ` (${code})`;
    this.setState('closed');
    this.scheduleRetry();
  }

  scheduleRetry() {
    if (this.destroyed) return;
    clearTimeout(this.retryTimer);
    this.attempt += 1;
    const raw = Math.min(RETRY_BASE_MS * Math.pow(RETRY_FACTOR, this.attempt - 1), RETRY_MAX_MS);
    const delay = jitter(raw);
    this.nextRetryAt = Date.now() + delay;
    console.warn(`[upstream ${this.id}] ${this.lastError} — retry #${this.attempt} em ${delay}ms`);
    this.retryTimer = unrefTimer(setTimeout(() => this.connect(), delay));
    this.broadcastControl(this.statusFrame());
  }

  // ---- dados ------------------------------------------------------------
  handleFrame(data, isBinary) {
    this.seq += 1;
    this.totalFrames += 1;

    if (isBinary) {
      this.fanout(data, true);
      return;
    }
    const text = data.toString();
    const name = frameName(text);
    this.cache.set(name, { raw: text, at: Date.now(), seq: this.seq });
    while (this.cache.size > CACHE_MAX_EVENTS) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this.pool.schedulePersist();
    this.emit('frame', text, name);
    this.fanout(text, false);
  }

  fanout(payload, binary) {
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      // Cliente afogado (link lento): nao enfileira mais nada. Ele recebe o
      // estado consolidado no proximo snapshot/reconexao.
      if (client.bufferedAmount > CLIENT_BUFFER_MAX) continue;
      try { client.send(payload, { binary }); } catch {}
    }
  }

  // ---- estado / controle ------------------------------------------------
  setState(state) {
    if (this.state === state) return;
    this.state = state;
    if (state !== 'closed') this.broadcastControl(this.statusFrame());
    this.emit('state', state);
  }

  statusFrame() {
    return {
      event: CONTROL,
      type: 'upstream',
      state: this.state,
      attempt: this.attempt,
      nextRetryMs: this.nextRetryAt ? Math.max(0, this.nextRetryAt - Date.now()) : 0,
      error: this.lastError,
      since: this.openedAt || null,
      seq: this.seq,
      clients: this.clients.size,
    };
  }

  broadcastControl(obj) {
    const text = JSON.stringify(obj);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(text); } catch {}
      }
    }
  }

  /** Cache ordenado do mais antigo para o mais recente. */
  cachedEntries() {
    return [...this.cache.entries()]
      .map(([name, e]) => ({ name, raw: e.raw, at: e.at, seq: e.seq }))
      .sort((a, b) => a.seq - b.seq);
  }

  /** Snapshot em JSON — usado pelo fallback HTTP. */
  snapshot() {
    const now = Date.now();
    return {
      id: this.id,
      serverTime: now,
      upstream: this.statusFrame(),
      seq: this.seq,
      events: this.cachedEntries().map((e) => ({
        name: e.name,
        at: e.at,
        age: now - e.at,
        frame: safeParse(e.raw) ?? e.raw,
      })),
    };
  }

  // ---- clientes ---------------------------------------------------------
  addClient(client) {
    this.clients.add(client);
    this.lastTouch = Date.now();
    this.greet(client);
    if (this.state === 'idle' || (this.state === 'closed' && !this.retryTimer)) this.connect();
  }

  removeClient(client) {
    this.clients.delete(client);
    this.lastTouch = Date.now();
  }

  touch() { this.lastTouch = Date.now(); }

  /**
   * Reenvia o estado conhecido para um cliente recem-conectado. E o coracao do
   * "projetar mesmo com atraso": o painel pinta na hora, com a idade do dado.
   */
  greet(client) {
    if (client.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    const send = (obj) => { try { client.send(JSON.stringify(obj)); } catch {} };

    send({
      event: CONTROL,
      type: 'hello',
      serverTime: now,
      target: this.target,
      cached: this.cache.size,
      upstream: this.statusFrame(),
    });

    for (const e of this.cachedEntries()) {
      send({
        event: CONTROL,
        type: 'snapshot',
        name: e.name,
        at: e.at,
        age: now - e.at,
        replay: true,
        frame: safeParse(e.raw) ?? e.raw,
      });
    }
  }

  /** Mensagem browser -> upstream (APIs que exigem subscribe). */
  sendUpstream(payload, binary) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(payload, { binary }); return true; } catch {}
    }
    return false;
  }

  seedCache(entries) {
    for (const e of entries || []) {
      if (!e || typeof e.raw !== 'string') continue;
      this.seq += 1;
      this.cache.set(e.name || '__raw', { raw: e.raw, at: e.at || Date.now(), seq: this.seq });
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.handshakeTimer);
    clearInterval(this.keepaliveTimer);
    if (this.ws) { try { this.ws.terminate(); } catch {} this.ws = null; }
    this.clients.clear();
    console.log(`[upstream ${this.id}] encerrado (ocioso)`);
  }
}

// =========================================================================
// UpstreamPool
// =========================================================================
class UpstreamPool extends EventEmitter {
  constructor({ persistPath, insecure } = {}) {
    super();
    this.links = new Map();
    this.insecure = !!insecure;
    this.persistPath = persistPath || null;
    this.persistTimer = null;
    this.lastPersistAt = 0;
    this.restored = new Map(); // key -> entries[]
    this.loadPersisted();
    this.sweeper = unrefTimer(setInterval(() => this.sweep(), SWEEP_INTERVAL));
  }

  static keyFor(target, token, hello) {
    return sha1(`${target}|${token || ''}|${hello || ''}`);
  }

  /** Garante que exista um link para (target, token) e o mantem vivo. */
  ensure({ target, token, hello }) {
    const key = UpstreamPool.keyFor(target, token, hello);
    let link = this.links.get(key);
    if (!link) {
      link = new UpstreamLink(this, key, { target, token, hello, insecure: this.insecure });
      const seed = this.restored.get(key);
      if (seed) { link.seedCache(seed); this.restored.delete(key); }
      this.links.set(key, link);
      this.emit('link', link);
      link.connect();
    }
    link.touch();
    return link;
  }

  sweep() {
    const now = Date.now();
    for (const [key, link] of this.links) {
      if (link.clients.size === 0 && now - link.lastTouch > IDLE_TTL_MS) {
        link.destroy();
        this.links.delete(key);
      }
    }
  }

  stats() {
    return [...this.links.values()].map((l) => ({
      id: l.id,
      target: l.target,
      state: l.state,
      attempt: l.attempt,
      clients: l.clients.size,
      frames: l.totalFrames,
      cached: l.cache.size,
      lastFrameAgo: l.lastFrameAt ? Date.now() - l.lastFrameAt : null,
      error: l.lastError,
    }));
  }

  // ---- persistencia -----------------------------------------------------
  /**
   * Grava na BORDA DE SUBIDA: a primeira mudanca depois de um periodo de calma
   * vai para o disco na hora. Se o servidor morrer de forma abrupta logo em
   * seguida (kill -9, queda de energia, restart do Windows), o estado ja esta
   * salvo. O debounce so existe para o caso raro de rajada de eventos.
   */
  schedulePersist() {
    if (!this.persistPath) return;
    const elapsed = Date.now() - this.lastPersistAt;
    if (elapsed >= PERSIST_DEBOUNCE) { this.persistNow(); return; }
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, PERSIST_DEBOUNCE - elapsed);
  }

  persistNow() {
    if (!this.persistPath) return;
    this.lastPersistAt = Date.now();
    const out = { version: 1, savedAt: Date.now(), links: {} };
    for (const [key, link] of this.links) {
      out.links[key] = {
        target: link.target,
        events: link.cachedEntries().map((e) => ({ name: e.name, raw: e.raw, at: e.at })),
      };
    }
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out));
      fs.renameSync(tmp, this.persistPath);
    } catch (err) {
      console.warn('[pool] falha ao persistir estado:', err.message);
    }
  }

  loadPersisted() {
    if (!this.persistPath) return;
    try {
      const raw = fs.readFileSync(this.persistPath, 'utf8');
      const data = JSON.parse(raw);
      for (const [key, entry] of Object.entries(data.links || {})) {
        this.restored.set(key, entry.events || []);
      }
      if (this.restored.size) {
        console.log(`[pool] estado restaurado de disco (${this.restored.size} conexao(oes))`);
      }
    } catch { /* sem cache anterior */ }
  }

  shutdown() {
    clearInterval(this.sweeper);
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.lastPersistAt = 0;
    this.persistNow();
    for (const link of this.links.values()) link.destroy();
    this.links.clear();
  }
}

module.exports = { UpstreamPool, UpstreamLink, CONTROL };
