'use strict';

const http = require('http');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const { UpstreamPool, CONTROL } = require('./lib/upstream-pool');
const { createImageCache } = require('./lib/image-cache');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const CACHE_DIR = process.env.HR_CACHE_DIR || path.join(__dirname, '.cache');

// Em redes corporativas o TLS pode ser interceptado e o certificado apresentado
// nao constar no bundle do Node. `--use-system-ca` (flag do node) resolve a
// maior parte; para self-signed/homologacao, suba com WS_PROXY_INSECURE=1.
const INSECURE = process.env.WS_PROXY_INSECURE === '1';

const CLIENT_PING_MS   = 30000; // ping proxy -> browser
const CLIENT_SILENCE_MS = 75000; // sem pong nesse tempo => socket zumbi
const HEARTBEAT_MS     = 15000; // batimento aplicativo proxy -> browser

const app = express();

// ---- gzip para assets de texto (ajuda muito em link lento) ---------------
app.use((req, res, next) => {
  if (!/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return next();
  const send = res.send.bind(res);
  res.send = (body) => {
    const type = String(res.get('Content-Type') || '');
    const compressible = /json|text|javascript|css|html|svg/i.test(type);
    if (!compressible || res.get('Content-Encoding')) return send(body);
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    if (buf.length < 1024) return send(body);
    const gz = zlib.gzipSync(buf);
    res.set('Content-Encoding', 'gzip');
    res.set('Vary', 'Accept-Encoding');
    res.removeHeader('Content-Length');
    return res.end(gz);
  };
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: '5m',
}));

// ---- infraestrutura ------------------------------------------------------
const pool = new UpstreamPool({
  persistPath: path.join(CACHE_DIR, 'state.json'),
  insecure: INSECURE,
});

const images = createImageCache({
  dir: path.join(CACHE_DIR, 'img'),
  insecure: INSECURE,
});

/** Extrai uma URL de capa de um frame do upstream, para prefetch. */
function coverUrlOf(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return null; }
  if (!msg || typeof msg !== 'object') return null;
  const candidates = [msg.imageUrl, msg.data && msg.data.imageUrl, msg.data && msg.data.cover];
  for (const c of candidates) {
    if (typeof c === 'string' && /^https?:\/\//i.test(c.trim())) return c.trim();
  }
  return null;
}

// Assim que um evento chega do upstream, a capa ja e baixada pelo servidor.
// Quando o browser pedir, ela vem da rede local.
pool.on('link', (link) => {
  link.on('frame', (text) => {
    const url = coverUrlOf(text);
    if (url) images.prefetch(url);
  });
});

// ---- API -----------------------------------------------------------------
// O painel pode estar hospedado em OUTRA origem (ex.: Static Web Apps) e
// apontar para este servidor pelo campo "Servidor de apoio". Sem CORS o browser
// bloquearia a deteccao (/api/health) e o fallback (/api/snapshot), e o painel
// cairia em modo direto silenciosamente — o WebSocket ate funcionaria, mas o
// replay, o cache de capas e o polling ficariam inacessiveis.
app.use('/api', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Max-Age', '86400');
    res.status(204).end();
    return;
  }
  next();
});

app.get('/api/img', (req, res) => { images.handle(req, res); });

/**
 * Fallback HTTP. Quando o WebSocket nao sobe (proxy corporativo, rede muito
 * instavel), o painel passa a fazer polling aqui e continua atualizando —
 * mais devagar, porem funcionando.
 *
 *   GET /api/snapshot?target=<ws-url>&token=<tok>&since=<seq>
 *   -> 200 { id, serverTime, upstream, seq, events: [...] }
 *   -> 204 se nada mudou desde `since`
 */
app.get('/api/snapshot', (req, res) => {
  const target = req.query.target;
  const token = req.query.token || '';
  const hello = req.query.hello || '';
  if (typeof target !== 'string' || !/^wss?:\/\//i.test(target)) {
    res.status(400).json({ ok: false, error: 'target ausente ou invalido' });
    return;
  }
  const link = pool.ensure({ target, token, hello });
  const since = Number(req.query.since);
  if (Number.isFinite(since) && since > 0 && link.seq === since) {
    res.set('Cache-Control', 'no-store').status(204).end();
    return;
  }
  res.set('Cache-Control', 'no-store').json(link.snapshot());
});

app.get('/api/health', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({
    ok: true,
    uptime: Math.round(process.uptime()),
    links: pool.stats(),
    images: images.stats(),
  });
});

const server = http.createServer(app);
// Conexoes ociosas em rede ruim nao devem prender recursos indefinidamente.
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

// ---- WebSocket proxy -----------------------------------------------------
//
//   ws(s)://<host>/ws-proxy?target=<url-real>&token=<token>[&hello=<frame>]
//
// O browser nao consegue enviar headers customizados em WebSocket; este
// endpoint recebe a conexao local e o pool abre/mantem o WS upstream com
// `Authorization`. Varios browsers compartilham o MESMO upstream.
const wssProxy = new WebSocketServer({ noServer: true, perMessageDeflate: true });

server.on('upgrade', (req, socket, head) => {
  let reqUrl;
  try { reqUrl = new URL(req.url, `http://${req.headers.host}`); }
  catch { socket.destroy(); return; }

  if (reqUrl.pathname !== '/ws-proxy') {
    socket.destroy();
    return;
  }

  wssProxy.handleUpgrade(req, socket, head, (clientWs) => {
    const target = reqUrl.searchParams.get('target');
    const token = reqUrl.searchParams.get('token') || '';
    const hello = reqUrl.searchParams.get('hello') || '';

    if (!target || !/^wss?:\/\//i.test(target)) {
      clientWs.close(1008, 'target ausente ou invalido');
      return;
    }

    const link = pool.ensure({ target, token, hello });
    link.addClient(clientWs);

    clientWs.isAlive = true;
    clientWs.lastSeen = Date.now();
    clientWs.on('pong', () => { clientWs.isAlive = true; clientWs.lastSeen = Date.now(); });

    // Batimento de aplicacao: o browser nao enxerga ping/pong do protocolo,
    // entao ele usa este frame para saber que o cano continua vivo.
    const hb = setInterval(() => {
      if (clientWs.readyState !== WebSocket.OPEN) return;
      if (clientWs.bufferedAmount > (1 << 20)) return;
      try {
        clientWs.send(JSON.stringify({ event: CONTROL, type: 'hb', t: Date.now(), seq: link.seq }));
      } catch {}
    }, HEARTBEAT_MS);
    if (hb.unref) hb.unref();

    clientWs.on('message', (data, isBinary) => {
      clientWs.lastSeen = Date.now();
      // Frames de controle do proprio painel nao vao para o upstream.
      if (!isBinary) {
        const text = data.toString();
        if (text.includes(CONTROL)) {
          try {
            const msg = JSON.parse(text);
            if (msg && msg.event === CONTROL) {
              if (msg.type === 'ping') {
                clientWs.send(JSON.stringify({ event: CONTROL, type: 'pong', t: Date.now(), echo: msg.t || null }));
              } else if (msg.type === 'resync') {
                link.greet(clientWs);
              }
              return;
            }
          } catch { /* segue como frame normal */ }
        }
      }
      link.sendUpstream(data, isBinary);
    });

    const detach = () => {
      clearInterval(hb);
      link.removeClient(clientWs);
    };
    clientWs.on('close', detach);
    clientWs.on('error', detach);
  });
});

// Limpa sockets de browser zumbis (celular que dormiu, wi-fi que sumiu).
const clientSweeper = setInterval(() => {
  for (const client of wssProxy.clients) {
    if (Date.now() - (client.lastSeen || 0) > CLIENT_SILENCE_MS) {
      try { client.terminate(); } catch {}
      continue;
    }
    try { client.ping(); } catch {}
  }
}, CLIENT_PING_MS);
if (clientSweeper.unref) clientSweeper.unref();

// ---- shutdown ------------------------------------------------------------
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n[server] ${signal} — encerrando (salvando estado)`);
  clearInterval(clientSweeper);
  pool.shutdown();
  for (const client of wssProxy.clients) {
    try { client.close(1001, 'servidor reiniciando'); } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
  console.log(`Hybrid Radio rodando em http://localhost:${PORT}`);
  console.log(`[server] cache em ${CACHE_DIR}${INSECURE ? ' | TLS upstream sem verificacao' : ''}`);
});
