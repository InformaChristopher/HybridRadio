'use strict';

/**
 * Upstream falso para testar a resiliencia do painel sem depender da API real.
 *
 *   node scripts/mock-upstream.js --port 4001 --interval 12 --drop 0.25 --latency 600
 *
 *   --port      porta (default 4001)
 *   --interval  segundos entre trocas de musica (default 12)
 *   --drop      probabilidade [0..1] de derrubar a conexao a cada ciclo (default 0)
 *   --latency   atraso artificial em ms antes de enviar cada frame (default 0)
 *   --halfopen  se >0, a cada N segundos o servidor "congela" (para de enviar e
 *               de responder pong) sem fechar o socket — simula NAT/wi-fi ruim
 *   --token     se definido, exige Authorization contendo esse valor
 *
 * Depois aponte o painel para ws://localhost:4001
 */

const { WebSocketServer } = require('ws');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) return def;
  return process.argv[i + 1];
}

const PORT     = Number(arg('port', 4001));
const INTERVAL = Number(arg('interval', 12)) * 1000;
const DROP     = Number(arg('drop', 0));
const LATENCY  = Number(arg('latency', 0));
const HALFOPEN = Number(arg('halfopen', 0)) * 1000;
const TOKEN    = arg('token', '');

const TRACKS = [
  { artist: 'Pascal Letoublon feat. Leony', title: 'Friendships (Lost my love)', duration: 210,
    imageUrl: 'https://picsum.photos/seed/friendships/600' },
  { artist: 'Fred again..', title: 'Delilah (pull me out of this)', duration: 234,
    imageUrl: 'https://picsum.photos/seed/delilah/600' },
  { artist: 'Kraftwerk', title: 'Das Model', duration: 218,
    imageUrl: 'https://picsum.photos/seed/model/600' },
  { artist: 'Tame Impala', title: 'The Less I Know The Better', duration: 216, imageUrl: '' },
  { artist: 'Nina Chuba', title: 'Wildberry Lillet', duration: 168,
    imageUrl: 'https://picsum.photos/seed/wildberry/600' },
];

const wss = new WebSocketServer({ port: PORT, verifyClient: (info, done) => {
  if (!TOKEN) return done(true);
  const auth = info.req.headers['authorization'] || '';
  if (auth.includes(TOKEN)) return done(true);
  console.log('[mock] recusado: Authorization ausente/errado ->', auth || '(vazio)');
  done(false, 401, 'Unauthorized');
} });

let index = 0;

wss.on('connection', (ws, req) => {
  const id = Math.random().toString(36).slice(2, 8);
  console.log(`[mock ${id}] conectado (auth=${req.headers['authorization'] ? 'sim' : 'nao'})`);

  let frozen = false;

  const send = (obj) => {
    if (frozen || ws.readyState !== ws.OPEN) return;
    const payload = JSON.stringify(obj);
    setTimeout(() => {
      if (frozen || ws.readyState !== ws.OPEN) return;
      ws.send(payload);
    }, LATENCY);
  };

  // Estado imediato ao conectar (a API real costuma fazer o mesmo).
  send({ event: 'song-changed', data: TRACKS[index % TRACKS.length] });

  const tick = setInterval(() => {
    index += 1;
    const track = TRACKS[index % TRACKS.length];
    console.log(`[mock ${id}] -> ${track.artist} / ${track.title}`);
    send({ event: 'song-changed', data: track });

    if (DROP > 0 && Math.random() < DROP) {
      console.log(`[mock ${id}] derrubando conexao de proposito`);
      setTimeout(() => { try { ws.terminate(); } catch {} }, LATENCY + 50);
    }
  }, INTERVAL);

  let freezeTimer = null;
  if (HALFOPEN > 0) {
    freezeTimer = setInterval(() => {
      frozen = !frozen;
      console.log(`[mock ${id}] ${frozen ? 'CONGELADO (meio-aberto)' : 'descongelado'}`);
      if (frozen) ws.pause?.();
      else ws.resume?.();
    }, HALFOPEN);
  }

  ws.on('close', () => {
    clearInterval(tick);
    if (freezeTimer) clearInterval(freezeTimer);
    console.log(`[mock ${id}] desconectado`);
  });
  ws.on('error', () => {});
});

console.log(`[mock] upstream falso em ws://localhost:${PORT}`);
console.log(`[mock] interval=${INTERVAL}ms drop=${DROP} latency=${LATENCY}ms halfopen=${HALFOPEN}ms token=${TOKEN ? 'sim' : 'nao'}`);
