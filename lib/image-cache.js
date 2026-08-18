'use strict';

/**
 * Cache de capas servido pelo proprio servidor.
 *
 * Motivo: em link lento/instavel, cada cliente baixando a capa direto do CDN
 * remoto e um ponto de falha e de latencia. Aqui o servidor baixa UMA vez
 * (inclusive por prefetch, assim que o evento chega do upstream), guarda em
 * memoria + disco e serve a partir da rede local com cache agressivo.
 *
 * Bonus: como a imagem passa a ser same-origin, o browser consegue guardar uma
 * copia em canvas/localStorage sem esbarrar em CORS/tainting.
 *
 * Se o download falhar mas existir copia em disco, serve a copia velha
 * (stale-if-error) em vez de devolver erro.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const FETCH_TIMEOUT_MS = 20000;
const MAX_BYTES        = 8 * 1024 * 1024;
const MAX_REDIRECTS    = 4;
const MEM_MAX_ENTRIES  = 64;
const MEM_MAX_BYTES    = 48 * 1024 * 1024;
const NEG_TTL_MS       = 60000; // nao martelar uma URL que acabou de falhar

function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

/** GET com timeout, limite de tamanho e redirects manuais. */
function download(rawUrl, { insecure, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(rawUrl); } catch { reject(new Error('URL invalida')); return; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      reject(new Error('protocolo nao suportado'));
      return;
    }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(url, {
      rejectUnauthorized: !insecure,
      headers: {
        'User-Agent': 'HybridRadio/2 (+cache)',
        'Accept': 'image/*,*/*;q=0.8',
      },
    }, (res) => {
      const status = res.statusCode || 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) { reject(new Error('redirects demais')); return; }
        const next = new URL(res.headers.location, url).toString();
        resolve(download(next, { insecure, redirects: redirects + 1 }));
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }

      const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (type && !type.startsWith('image/')) {
        res.resume();
        reject(new Error(`content-type ${type}`));
        return;
      }

      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) {
          req.destroy(new Error('imagem grande demais'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), type: type || 'image/jpeg' }));
      res.on('error', reject);
    });

    req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function createImageCache({ dir, insecure } = {}) {
  fs.mkdirSync(dir, { recursive: true });

  const mem = new Map();       // key -> { buf, type, at }
  const inflight = new Map();  // key -> Promise
  const negative = new Map();  // key -> ts do ultimo erro
  let memBytes = 0;

  function memPut(key, entry) {
    if (mem.has(key)) memBytes -= mem.get(key).buf.length;
    mem.set(key, entry);
    memBytes += entry.buf.length;
    while (mem.size > MEM_MAX_ENTRIES || memBytes > MEM_MAX_BYTES) {
      const oldest = mem.keys().next().value;
      if (oldest === undefined) break;
      memBytes -= mem.get(oldest).buf.length;
      mem.delete(oldest);
    }
  }
  function memTouch(key) {
    const e = mem.get(key);
    if (!e) return null;
    mem.delete(key); mem.set(key, e); // LRU
    return e;
  }

  const binPath = (key) => path.join(dir, `${key}.bin`);
  const metaPath = (key) => path.join(dir, `${key}.json`);

  async function fromDisk(key) {
    try {
      const [buf, metaRaw] = await Promise.all([
        fsp.readFile(binPath(key)),
        fsp.readFile(metaPath(key), 'utf8').catch(() => '{}'),
      ]);
      const meta = JSON.parse(metaRaw || '{}');
      return { buf, type: meta.type || 'image/jpeg', at: meta.at || 0 };
    } catch {
      return null;
    }
  }

  async function toDisk(key, entry, url) {
    try {
      await fsp.writeFile(binPath(key), entry.buf);
      await fsp.writeFile(metaPath(key), JSON.stringify({ type: entry.type, at: entry.at, url }));
    } catch { /* cache em disco e best-effort */ }
  }

  /**
   * Devolve { buf, type, source } — 'mem' | 'disk' | 'net' | 'stale'.
   * Nunca rejeita se houver alguma copia local disponivel.
   */
  async function get(url) {
    const key = sha1(url);

    const hot = memTouch(key);
    if (hot) return { ...hot, source: 'mem' };

    const onDisk = await fromDisk(key);
    if (onDisk) { memPut(key, onDisk); return { ...onDisk, source: 'disk' }; }

    const failedAt = negative.get(key);
    if (failedAt && Date.now() - failedAt < NEG_TTL_MS) {
      throw new Error('falha recente no download');
    }

    if (inflight.has(key)) return inflight.get(key);

    const p = (async () => {
      try {
        const { buf, type } = await download(url, { insecure });
        const entry = { buf, type, at: Date.now() };
        memPut(key, entry);
        toDisk(key, entry, url);
        negative.delete(key);
        return { ...entry, source: 'net' };
      } catch (err) {
        const stale = await fromDisk(key);
        if (stale) return { ...stale, source: 'stale' };
        negative.set(key, Date.now());
        throw err;
      } finally {
        inflight.delete(key);
      }
    })();

    inflight.set(key, p);
    return p;
  }

  /** Baixa antecipadamente (chamado quando o evento chega do upstream). */
  function prefetch(url) {
    if (!url || typeof url !== 'string') return;
    if (!/^https?:\/\//i.test(url)) return;
    get(url).catch(() => { /* prefetch e best-effort */ });
  }

  /** Handler Express para GET /api/img?u=<url> */
  async function handle(req, res) {
    const raw = req.query.u || req.query.url;
    if (!raw || typeof raw !== 'string' || !/^https?:\/\//i.test(raw)) {
      res.status(400).type('text/plain').send('parametro u ausente ou invalido');
      return;
    }
    const etag = `"${sha1(raw)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    try {
      const entry = await get(raw);
      res.set({
        'Content-Type': entry.type,
        'Cache-Control': 'public, max-age=604800, stale-while-revalidate=86400',
        'ETag': etag,
        'X-Cache': entry.source,
        'Access-Control-Allow-Origin': '*',
      });
      res.end(entry.buf);
    } catch (err) {
      res.status(502).type('text/plain').send(`falha ao obter imagem: ${err.message}`);
    }
  }

  function stats() {
    return { entries: mem.size, bytes: memBytes, inflight: inflight.size };
  }

  return { get, prefetch, handle, stats };
}

module.exports = { createImageCache };
