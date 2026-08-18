(() => {
  'use strict';

  // ===================================================================
  // Hybrid Radio — painel resiliente
  //
  // Premissa: a rede vai cair, engasgar e voltar. O painel NUNCA deve
  // ficar em branco por causa disso. Estrategia em camadas:
  //
  //   1. Estado persistido no navegador -> pinta a ultima faixa conhecida
  //      antes mesmo de tentar conectar.
  //   2. WebSocket com timeout de abertura, watchdog de silencio, backoff
  //      com jitter e reconexao imediata quando a rede/aba volta.
  //   3. O proxy reenvia o ultimo estado assim que a conexao sobe, entao
  //      nao e preciso esperar a proxima troca de musica.
  //   4. Se o WebSocket nao subir de jeito nenhum, cai para polling HTTP.
  //   5. Capas passam pelo cache do servidor, com preload, retry e copia
  //      local — a arte continua na tela mesmo offline.
  // ===================================================================

  const CONTROL = '__hr';

  // ---------- Referencias DOM ----------
  const carousel       = document.getElementById('carousel');
  const stationNameEl  = document.getElementById('station-name');
  const stationFreqEl  = document.getElementById('station-freq');
  const trackTitleEl   = document.getElementById('track-title');
  const trackArtistEl  = document.getElementById('track-artist');
  const trackDurationEl = document.getElementById('track-duration');
  const screenEl       = document.querySelector('.screen');
  const statusEl       = document.getElementById('ws-status');
  const settingsBtn    = document.getElementById('settings-btn');
  const overlayEl      = document.getElementById('setup-overlay');
  const formEl         = document.getElementById('setup-form');
  const cancelBtn      = document.getElementById('setup-cancel');
  const errorEl        = document.getElementById('setup-error');
  const inputs = {
    url:   document.getElementById('cfg-url'),
    token: document.getElementById('cfg-token'),
    backend: document.getElementById('cfg-backend'),
    name:  document.getElementById('cfg-station-name'),
    freq:  document.getElementById('cfg-station-freq'),
    coverPrimary: document.getElementById('cfg-cover-primary'),
    coverPrimaryPreview: document.getElementById('cfg-cover-primary-preview'),
    covers: [
      document.getElementById('cfg-cover-1'),
      document.getElementById('cfg-cover-2'),
      document.getElementById('cfg-cover-3'),
    ],
    coverPreviews: [
      document.getElementById('cfg-cover-1-preview'),
      document.getElementById('cfg-cover-2-preview'),
      document.getElementById('cfg-cover-3-preview'),
    ],
  };

  // ---------- Configuracao (persistencia) ----------
  const STORAGE_KEY = 'hybridRadioConfig.v1';
  const STATE_KEY   = 'hybridRadioState.v1';
  const COVER_KEY   = 'hybridRadioCovers.v1';

  function readJson(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function isConfigComplete(c) {
    return c && typeof c.wsUrl === 'string' && c.wsUrl.length > 0
      && typeof c.stationName === 'string' && c.stationName.length > 0
      && typeof c.stationFreq === 'string' && c.stationFreq.length > 0;
  }

  let config = readJson(STORAGE_KEY) || {
    wsUrl: '', wsToken: '', backendUrl: '', stationName: '', stationFreq: '',
    coverPrimary: null,
    covers: [null, null, null],
  };
  // Compat: configs antigas sem coverPrimary
  if (!('coverPrimary' in config)) config.coverPrimary = null;
  if (!Array.isArray(config.covers)) config.covers = [null, null, null];

  // Pre-configuracao pela URL — util para kiosk/stage, onde nao da para abrir
  // o modal em cada tela:
  //   ?ws=wss://api/...&token=abc&backend=https://proxy&station=SWR3&freq=208.1%20MHz
  // Os valores entram no localStorage e a query string e limpa da barra.
  (function applyQueryConfig() {
    const q = new URLSearchParams(window.location.search);
    const map = {
      ws: 'wsUrl', token: 'wsToken', backend: 'backendUrl',
      station: 'stationName', freq: 'stationFreq',
    };
    let touched = false;
    for (const [param, field] of Object.entries(map)) {
      if (!q.has(param)) continue;
      config[field] = q.get(param).trim();
      touched = true;
    }
    if (!touched) return;
    try { writeJson(STORAGE_KEY, config); } catch {}
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    }
  })();

  // ---------- Setup modal ----------
  function showSetup() {
    inputs.url.value   = config.wsUrl   || '';
    inputs.token.value = config.wsToken || '';
    inputs.backend.value = config.backendUrl || '';
    inputs.name.value  = config.stationName || '';
    inputs.freq.value  = config.stationFreq || '';
    inputs.coverPrimaryPreview.style.backgroundImage =
      config.coverPrimary ? `url("${config.coverPrimary}")` : '';
    inputs.coverPreviews.forEach((el, i) => {
      el.style.backgroundImage = config.covers[i] ? `url("${config.covers[i]}")` : '';
    });
    errorEl.hidden = true;
    overlayEl.hidden = false;
  }
  function hideSetup() { overlayEl.hidden = true; }

  // Redimensiona imagem para no max 512x512 e converte para JPEG ~q0.82
  // — evita estourar localStorage (~5MB).
  function downscale(imgOrCanvasSource, max = 512, quality = 0.82) {
    const w0 = imgOrCanvasSource.naturalWidth || imgOrCanvasSource.width;
    const h0 = imgOrCanvasSource.naturalHeight || imgOrCanvasSource.height;
    const ratio = Math.min(1, max / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * ratio));
    const h = Math.max(1, Math.round(h0 * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(imgOrCanvasSource, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  }

  function readImageDownscaled(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          try { resolve(downscale(img)); } catch (err) { reject(err); }
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  inputs.covers.forEach((input, i) => {
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      try {
        const dataUrl = await readImageDownscaled(f);
        inputs.coverPreviews[i].style.backgroundImage = `url("${dataUrl}")`;
        input.dataset.dataUrl = dataUrl;
      } catch (err) {
        console.error('Falha ao ler imagem', err);
      }
    });
  });
  inputs.coverPrimary.addEventListener('change', async () => {
    const f = inputs.coverPrimary.files && inputs.coverPrimary.files[0];
    if (!f) return;
    try {
      const dataUrl = await readImageDownscaled(f);
      inputs.coverPrimaryPreview.style.backgroundImage = `url("${dataUrl}")`;
      inputs.coverPrimary.dataset.dataUrl = dataUrl;
    } catch (err) {
      console.error('Falha ao ler imagem principal', err);
    }
  });

  settingsBtn.addEventListener('click', showSetup);
  cancelBtn.addEventListener('click', () => {
    // So permite cancelar se ja houver uma config salva
    if (isConfigComplete(config)) hideSetup();
    else { errorEl.textContent = 'Preencha a configuracao antes de continuar.'; errorEl.hidden = false; }
  });
  overlayEl.addEventListener('click', (e) => {
    if (e.target === overlayEl && isConfigComplete(config)) hideSetup();
  });

  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    const wsUrl = inputs.url.value.trim();
    if (!/^wss?:\/\//i.test(wsUrl)) {
      errorEl.textContent = 'URL deve comecar com ws:// ou wss://';
      errorEl.hidden = false;
      return;
    }
    const next = {
      wsUrl,
      wsToken: inputs.token.value.trim(),
      backendUrl: inputs.backend.value.trim().replace(/\/+$/, ''),
      stationName: inputs.name.value.trim(),
      stationFreq: inputs.freq.value.trim(),
      coverPrimary: inputs.coverPrimary.dataset.dataUrl || config.coverPrimary || null,
      covers: inputs.covers.map((inp, i) => inp.dataset.dataUrl || config.covers[i] || null),
    };
    try {
      writeJson(STORAGE_KEY, next);
    } catch {
      errorEl.textContent = 'Falha ao salvar (provavelmente imagens grandes demais para o localStorage).';
      errorEl.hidden = false;
      return;
    }
    const targetChanged = next.wsUrl !== config.wsUrl || next.wsToken !== config.wsToken;
    const backendChanged = next.backendUrl !== config.backendUrl;
    config = next;
    hideSetup();
    applyStationFromConfig();
    renderCarousel();
    if (targetChanged) clearTrackState();
    if (backendChanged) {
      backend.mode = 'unknown';
      detectBackend().then(() => transport.restart());
    } else if (targetChanged || !transport.isConnected()) {
      transport.restart();
    }
  });

  // ---------- Servidor de apoio (proxy) x modo direto ----------
  // O painel roda em dois cenarios:
  //   proxy  — servido pelo server.js deste repo (ou apontado para ele). Tem
  //            reconexao no servidor, replay de estado, cache de capas e
  //            fallback HTTP.
  //   direto — hospedagem estatica (ex.: Azure Static Web Apps), sem backend.
  //            O browser fala direto com a API. Continua valendo toda a
  //            resiliencia do lado do cliente, mas sem cache no servidor e sem
  //            header Authorization (o browser nao consegue envia-lo em WS).
  const backend = { mode: 'unknown' };

  function backendBase() {
    const b = (config.backendUrl || '').trim().replace(/\/+$/, '');
    return b || window.location.origin;
  }

  async function detectBackend() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(`${backendBase()}/api/health`, { signal: ctrl.signal, cache: 'no-store' });
      const body = res.ok ? await res.json() : null;
      backend.mode = (body && body.ok) ? 'proxy' : 'direct';
    } catch {
      backend.mode = 'direct';
    } finally {
      clearTimeout(timer);
    }
    console.log('[backend] modo:', backend.mode, backend.mode === 'proxy' ? backendBase() : '(sem servidor de apoio)');
    refreshStatus();
    return backend.mode;
  }

  // ---------- Estado da faixa (persistido) ----------
  // `at` fica sempre no relogio do CLIENTE: quando o servidor manda um replay,
  // ele informa a idade em ms e nos convertemos. Assim a "idade do dado"
  // continua correta mesmo com relogios dessincronizados.
  let track = { song: null, at: 0, sig: '' };

  const persisted = readJson(STATE_KEY);
  if (persisted && persisted.song && typeof persisted.song === 'object') {
    track = { song: persisted.song, at: Number(persisted.at) || 0, sig: persisted.sig || '' };
  }

  function saveTrackState() {
    try { writeJson(STATE_KEY, track); } catch { /* cota cheia: nao e fatal */ }
  }
  function clearTrackState() {
    track = { song: null, at: 0, sig: '' };
    liveCoverSrc = null;
    try { localStorage.removeItem(STATE_KEY); } catch {}
    trackTitleEl.textContent = '—';
    trackArtistEl.textContent = '—';
    trackDurationEl.textContent = '00:00';
    renderCarousel();
  }

  // ---------- Renderizacao da UI ----------
  function applyStationFromConfig() {
    stationNameEl.textContent = config.stationName || '—';
    stationFreqEl.textContent = config.stationFreq || '—';
  }

  // Origem da capa em uso agora (URL do proxy local ou dataURL de cache).
  let liveCoverSrc = null;
  let primaryLabel = '';

  function resolvePrimaryCover() {
    return liveCoverSrc || config.coverPrimary || null;
  }

  function renderCarousel() {
    carousel.innerHTML = '';
    // Layout: [sec1, PRIMARY, sec2, sec3]
    const slots = [
      { kind: 'cover', img: config.covers[0] },
      { kind: 'primary' },
      { kind: 'cover', img: config.covers[1] },
      { kind: 'cover', img: config.covers[2] },
    ];
    for (const slot of slots) {
      const el = document.createElement('div');
      el.className = 'cover' + (slot.kind === 'primary' ? ' playing' : '');
      if (slot.kind === 'primary') {
        const url = resolvePrimaryCover();
        if (url) {
          el.style.backgroundImage = `url("${url}")`;
        } else {
          el.textContent = (primaryLabel || '♪').slice(0, 2).toUpperCase();
        }
      } else if (slot.img) {
        el.style.backgroundImage = `url("${slot.img}")`;
      }
      carousel.appendChild(el);
    }
  }

  // ---------- Pipeline de capas ----------
  // A imagem remota passa pelo servidor (/img). Vantagens em link ruim:
  // o servidor ja baixou por prefetch, a entrega vem da rede local, o cache
  // e agressivo e, por ser same-origin, da para guardar copia via canvas.
  const COVER_CACHE_MAX = 6;
  let coverCache = readJson(COVER_KEY) || {};
  let coverToken = 0;

  function hashString(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  function proxiedCover(url) {
    if (backend.mode !== 'proxy') return url; // sem servidor de apoio: origem
    return `${backendBase()}/api/img?u=${encodeURIComponent(url)}`;
  }

  function preloadImage(src, timeoutMs) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        img.src = '';
        reject(new Error('timeout'));
      }, timeoutMs);
      img.decoding = 'async';
      img.onload = () => {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(img);
      };
      img.onerror = () => {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(new Error('erro de carga'));
      };
      img.src = src;
    });
  }

  async function preloadWithRetry(src, attempts = 3) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      // Link lento merece paciencia crescente antes de desistir.
      const timeout = 8000 + i * 6000;
      try { return await preloadImage(src, timeout); }
      catch (err) {
        lastErr = err;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 800 * Math.pow(2, i)));
      }
    }
    throw lastErr;
  }

  function rememberCover(key, img) {
    try {
      const dataUrl = downscale(img, 512, 0.8);
      coverCache[key] = { dataUrl, at: Date.now() };
      const keys = Object.keys(coverCache)
        .sort((a, b) => (coverCache[a].at || 0) - (coverCache[b].at || 0));
      while (keys.length > COVER_CACHE_MAX) delete coverCache[keys.shift()];
      writeJson(COVER_KEY, coverCache);
    } catch {
      // Cota estourada ou canvas bloqueado: cache local e um bonus, nao um
      // requisito. Zera para nao ficar tentando de novo com o mesmo erro.
      coverCache = {};
      try { localStorage.removeItem(COVER_KEY); } catch {}
    }
  }

  async function applyCover(url) {
    const my = ++coverToken;

    if (!url) {
      liveCoverSrc = null;
      renderCarousel();
      return;
    }

    const key = hashString(url);
    const cached = coverCache[key];
    if (cached && cached.dataUrl) {
      // Pinta na hora com a copia local; a versao do servidor entra depois.
      liveCoverSrc = cached.dataUrl;
      renderCarousel();
    }

    const src = proxiedCover(url);
    try {
      const img = await preloadWithRetry(src);
      if (my !== coverToken) return; // faixa mudou no meio do caminho
      liveCoverSrc = src;
      renderCarousel();
      rememberCover(key, img);
    } catch (err) {
      if (my !== coverToken) return;
      console.warn('[cover] falhou, mantendo fallback:', err.message);
      // Sem copia local: cai na imagem default do setup em vez de branco.
      if (!cached || !cached.dataUrl) {
        liveCoverSrc = null;
        renderCarousel();
      }
    }
  }

  // ---------- Mapeamento JSON -> UI ----------
  function parseDurationSeconds(value) {
    if (typeof value === 'number' && isFinite(value)) return Math.max(0, Math.floor(value));
    if (typeof value !== 'string') return 0;
    const parts = value.split(':').map(Number);
    if (parts.some(isNaN)) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
  }
  function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  function formatAge(ms) {
    if (!ms || ms < 0) return 'agora';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return `${h}h${String(m % 60).padStart(2, '0')}`;
  }

  function songSignature(data) {
    return [data.title, data.artist, data.duration, data.imageUrl].map((v) => String(v ?? '')).join('');
  }

  function paintTrack(song) {
    trackTitleEl.textContent  = song.title  || '—';
    trackArtistEl.textContent = song.artist || '—';
    trackDurationEl.textContent = formatDuration(parseDurationSeconds(song.duration));
    primaryLabel = song.title || '';
  }

  /**
   * @param {object} data payload do evento song-changed
   * @param {{age?: number}} meta idade do dado em ms (replay do proxy)
   */
  function applySongChanged(data, meta) {
    if (!data || typeof data !== 'object') return;
    const age = Math.max(0, Number(meta && meta.age) || 0);
    const at = Date.now() - age;
    const sig = songSignature(data);

    // Mesma faixa reenviada (replay de reconexao): apenas refresca a idade.
    // Sem isso, cada reconexao redesenharia o carousel e rebaixaria a capa.
    if (sig === track.sig && track.song) {
      if (at > track.at) { track.at = at; saveTrackState(); }
      refreshStatus();
      return;
    }

    const song = {
      title: typeof data.title === 'string' ? data.title : (track.song && track.song.title) || '',
      artist: typeof data.artist === 'string' ? data.artist : (track.song && track.song.artist) || '',
      duration: 'duration' in data ? data.duration : (track.song && track.song.duration) || 0,
      imageUrl: typeof data.imageUrl === 'string' && data.imageUrl.trim() ? data.imageUrl.trim() : null,
    };

    track = { song, at, sig };
    saveTrackState();
    paintTrack(song);
    applyCover(song.imageUrl);
    refreshStatus();
  }

  function routeFrame(msg, meta) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.event === CONTROL) { handleControl(msg); return; }
    if (msg.event === 'song-changed') applySongChanged(msg.data, meta);
  }

  function handleControl(msg) {
    switch (msg.type) {
      case 'hello':
        // O proxy respondeu: o cano ate o servidor esta comprovadamente bom.
        link.wsFailures = 0;
        reconnectDelay = RECONNECT_MIN;
        if (msg.upstream) link.upstream = msg.upstream;
        break;
      case 'snapshot':
        if (msg.frame) routeFrame(msg.frame, { age: msg.age, replay: true });
        break;
      case 'upstream':
        link.upstream = msg;
        link.upstreamSeenAt = Date.now();
        break;
      case 'hb':
      case 'pong':
        break;
      default:
        break;
    }
    refreshStatus();
  }

  // ===================================================================
  // Transporte
  // ===================================================================
  const RECONNECT_MIN   = 1000;
  const RECONNECT_MAX   = 20000;
  const OPEN_TIMEOUT_MS = 20000;  // handshake travado em rede ruim
  const SILENCE_LIMIT   = 45000;  // proxy manda hb a cada 15s
  const WS_FAIL_LIMIT   = 3;      // apos isso, cai para polling HTTP
  const POLL_MIN_MS     = 8000;
  const POLL_MAX_MS     = 30000;
  const WS_PROBE_MS     = 45000;  // com que frequencia tentar voltar ao WS

  const link = {
    mode: 'ws',            // 'ws' | 'poll'
    wsState: 'idle',       // idle | connecting | open | closed
    upstream: { state: 'unknown', attempt: 0, nextRetryMs: 0, error: null },
    upstreamSeenAt: 0,
    lastFrameAt: 0,
    wsFailures: 0,
    seq: 0,
    lastPollOk: 0,
    lastError: null,
  };

  let ws = null;
  let reconnectDelay = RECONNECT_MIN;
  let reconnectTimer = 0;
  let openTimer = 0;
  let pollTimer = 0;
  let pollDelay = POLL_MIN_MS;
  let probeTimer = 0;
  let stopped = false;

  function jitter(ms) { return Math.round(ms * (0.75 + Math.random() * 0.5)); }

  // Conecta ao proxy local em /ws-proxy. O proxy abre/mantem o WS upstream com
  // `Authorization: Bearer <token>`, contornando a limitacao do browser de nao
  // permitir headers em WebSocket.
  function buildWsUrl() {
    // Modo direto: fala com a API sem intermediario. O browser nao envia
    // headers em WebSocket, entao o token vai na querystring — que e como a
    // API aceita. Query params ja existentes na URL sao preservados.
    if (backend.mode !== 'proxy') {
      const base = config.wsUrl;
      if (!config.wsToken) return base;
      const sep = base.includes('?') ? '&' : '?';
      return `${base}${sep}token=${encodeURIComponent(config.wsToken)}`;
    }
    const proxy = new URL('/ws-proxy', backendBase());
    proxy.protocol = (proxy.protocol === 'https:') ? 'wss:' : 'ws:';
    proxy.searchParams.set('target', config.wsUrl);
    if (config.wsToken) proxy.searchParams.set('token', config.wsToken);
    return proxy.toString();
  }

  function closeSocket() {
    if (!ws) return;
    const dying = ws;
    ws = null;
    dying.onopen = dying.onmessage = dying.onerror = dying.onclose = null;
    try { dying.close(); } catch {}
  }

  function connectWS() {
    if (stopped || !isConfigComplete(config)) return;
    clearTimeout(reconnectTimer);
    clearTimeout(openTimer);
    closeSocket();

    let url;
    try { url = buildWsUrl(); } catch { return; }

    link.wsState = 'connecting';
    refreshStatus();

    let socket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      link.lastError = err.message;
      onWsDown('instanciacao falhou');
      return;
    }
    ws = socket;

    // Um socket preso em CONNECTING nunca dispara close sozinho em algumas
    // redes moveis. Sem este corte, o painel ficaria "conectando" para sempre.
    openTimer = setTimeout(() => {
      if (ws === socket && socket.readyState === WebSocket.CONNECTING) {
        console.warn('[ws] timeout de abertura');
        try { socket.close(); } catch {}
        onWsDown('timeout de abertura');
      }
    }, OPEN_TIMEOUT_MS);

    socket.onopen = () => {
      if (ws !== socket) return;
      clearTimeout(openTimer);
      link.wsState = 'open';
      link.lastFrameAt = Date.now();
      link.lastError = null;
      refreshStatus();
    };

    socket.onmessage = (event) => {
      if (ws !== socket) return;
      link.lastFrameAt = Date.now();
      if (typeof event.data !== 'string') return; // binario nao e usado aqui
      let msg;
      try { msg = JSON.parse(event.data); }
      catch { console.warn('[ws] payload nao-JSON', event.data); return; }
      if (msg && typeof msg.seq === 'number') link.seq = msg.seq;
      routeFrame(msg, { age: 0 });
    };

    socket.onerror = () => { /* close vem logo em seguida */ };

    socket.onclose = (ev) => {
      if (ws !== socket) return;
      const reason = ev.reason ? ` — ${ev.reason}` : '';
      onWsDown(`code=${ev.code}${reason}`);
    };
  }

  function onWsDown(why) {
    clearTimeout(openTimer);
    closeSocket();
    link.wsState = 'closed';
    link.lastError = why;
    link.wsFailures += 1;
    console.warn('[ws] queda:', why, `(falhas=${link.wsFailures})`);

    if (link.wsFailures >= WS_FAIL_LIMIT && link.mode === 'ws' && backend.mode === 'proxy') {
      // WebSocket nao esta passando (proxy corporativo, rede hostil).
      // Degrada para HTTP: mais lento, porem entrega a informacao.
      switchToPolling();
      return;
    }
    scheduleReconnect();
    refreshStatus();
  }

  function scheduleReconnect(delay) {
    if (stopped || !isConfigComplete(config)) return;
    clearTimeout(reconnectTimer);
    const wait = delay != null ? delay : jitter(reconnectDelay);
    reconnectTimer = setTimeout(connectWS, wait);
    link.nextAttemptAt = Date.now() + wait;
    reconnectDelay = Math.min(reconnectDelay * 1.7, RECONNECT_MAX);
  }

  /** Watchdog: conexao "aberta" mas muda ha tempo demais = conexao morta. */
  function checkSilence() {
    if (link.mode !== 'ws' || link.wsState !== 'open') return;
    const quiet = Date.now() - link.lastFrameAt;
    if (quiet > SILENCE_LIMIT) {
      console.warn(`[ws] silencio de ${Math.round(quiet / 1000)}s — reconectando`);
      reconnectDelay = RECONNECT_MIN;
      onWsDown('silencio');
    }
  }

  // ---------- Fallback HTTP ----------
  function snapshotUrl() {
    const u = new URL('/api/snapshot', backendBase());
    u.searchParams.set('target', config.wsUrl);
    if (config.wsToken) u.searchParams.set('token', config.wsToken);
    if (link.seq) u.searchParams.set('since', String(link.seq));
    return u.toString();
  }

  async function pollOnce() {
    if (stopped || !isConfigComplete(config)) return;
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(snapshotUrl(), { signal: controller.signal, cache: 'no-store' });
      if (res.status === 204) {
        pollDelay = POLL_MIN_MS;
        link.lastPollOk = Date.now();
        link.lastFrameAt = Date.now();
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      link.seq = data.seq || link.seq;
      if (data.upstream) link.upstream = data.upstream;
      link.lastPollOk = Date.now();
      link.lastFrameAt = Date.now();
      link.lastError = null;
      pollDelay = POLL_MIN_MS;
      for (const ev of data.events || []) {
        routeFrame(ev.frame, { age: ev.age, replay: true });
      }
    } catch (err) {
      link.lastError = err.name === 'AbortError' ? 'timeout' : err.message;
      pollDelay = Math.min(Math.round(pollDelay * 1.6), POLL_MAX_MS);
      console.warn('[poll] falhou:', link.lastError, `proximo em ${pollDelay}ms`);
    } finally {
      clearTimeout(abort);
      refreshStatus();
      if (link.mode === 'poll' && !stopped) {
        clearTimeout(pollTimer);
        pollTimer = setTimeout(pollOnce, jitter(pollDelay));
      }
    }
  }

  function switchToPolling() {
    if (link.mode === 'poll') return;
    console.warn('[transport] WebSocket indisponivel — modo HTTP polling');
    link.mode = 'poll';
    link.wsState = 'closed';
    clearTimeout(reconnectTimer);
    closeSocket();
    pollDelay = POLL_MIN_MS;
    clearTimeout(pollTimer);
    pollOnce();
    // Segue tentando voltar para o WebSocket em segundo plano.
    clearInterval(probeTimer);
    probeTimer = setInterval(probeWebSocket, WS_PROBE_MS);
    refreshStatus();
  }

  function switchToWebSocket() {
    if (link.mode === 'ws') return;
    console.log('[transport] WebSocket voltou — saindo do modo HTTP');
    link.mode = 'ws';
    clearInterval(probeTimer); probeTimer = 0;
    clearTimeout(pollTimer); pollTimer = 0;
    refreshStatus();
  }

  /** Tenta um WS "de teste"; se abrir e falar, assume o transporte. */
  function probeWebSocket() {
    if (stopped || link.mode !== 'poll' || !isConfigComplete(config)) return;
    let probe;
    try { probe = new WebSocket(buildWsUrl()); } catch { return; }
    const kill = setTimeout(() => { try { probe.close(); } catch {} }, OPEN_TIMEOUT_MS);
    probe.onopen = () => {
      clearTimeout(kill);
      try { probe.close(); } catch {}
      link.wsFailures = 0;
      reconnectDelay = RECONNECT_MIN;
      switchToWebSocket();
      connectWS();
    };
    probe.onerror = () => { clearTimeout(kill); };
    probe.onclose = () => { clearTimeout(kill); };
  }

  const transport = {
    start() {
      stopped = false;
      if (!isConfigComplete(config)) return;
      if (link.mode === 'poll') pollOnce();
      else connectWS();
    },
    restart() {
      stopped = false;
      link.wsFailures = 0;
      link.seq = 0;
      reconnectDelay = RECONNECT_MIN;
      link.mode = 'ws';
      clearInterval(probeTimer); probeTimer = 0;
      clearTimeout(pollTimer); pollTimer = 0;
      connectWS();
    },
    isConnected() {
      return (link.mode === 'ws' && link.wsState === 'open')
        || (link.mode === 'poll' && Date.now() - link.lastPollOk < POLL_MAX_MS * 2);
    },
    /** Reage a "a rede voltou" / "a aba voltou": tenta ja, sem esperar backoff. */
    wakeUp(reason) {
      if (stopped || !isConfigComplete(config)) return;
      console.log('[transport] wake-up:', reason);
      reconnectDelay = RECONNECT_MIN;
      pollDelay = POLL_MIN_MS;
      if (link.mode === 'poll') {
        clearTimeout(pollTimer);
        pollOnce();
        probeWebSocket();
        return;
      }
      if (link.wsState === 'open') {
        // Conexao pode estar "meio-aberta": pede o estado de novo e deixa o
        // watchdog resolver caso nao venha resposta.
        try { ws && ws.send(JSON.stringify({ event: CONTROL, type: 'resync' })); } catch {}
      } else {
        connectWS();
      }
    },
  };

  // ---------- Gatilhos de rede / visibilidade ----------
  window.addEventListener('online', () => transport.wakeUp('online'));
  window.addEventListener('offline', () => { link.lastError = 'sem rede'; refreshStatus(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') transport.wakeUp('aba visivel');
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted) transport.wakeUp('bfcache'); });
  window.addEventListener('focus', () => {
    if (!transport.isConnected()) transport.wakeUp('foco');
  });

  setInterval(checkSilence, 5000);

  // ---------- Indicador de status ----------
  function statusView() {
    const hasData = !!track.song;
    const age = hasData ? Date.now() - track.at : 0;
    const ageTxt = hasData ? formatAge(age) : 'sem dados';
    const up = link.upstream || {};

    const detail = [
      `alvo: ${config.wsUrl || '—'}`,
      `transporte: ${link.mode === 'poll' ? 'HTTP polling' : `WebSocket (${link.wsState})`}`,
      `modo: ${backend.mode === 'proxy' ? `servidor de apoio (${backendBase()})` : 'direto, sem servidor de apoio'}`,
      `upstream: ${up.state || 'desconhecido'}${up.attempt ? ` (tentativa ${up.attempt})` : ''}`,
      up.error ? `erro upstream: ${up.error}` : null,
      link.lastError ? `ultimo erro local: ${link.lastError}` : null,
      hasData ? `ultima faixa recebida ha ${ageTxt}` : 'nenhuma faixa recebida ainda',
    ].filter(Boolean).join('\n');

    if (!isConfigComplete(config)) {
      return { state: 'off', label: 'sem config', detail: 'Configure a conexao no botao de engrenagem.' };
    }
    if (link.mode === 'poll') {
      const ok = Date.now() - link.lastPollOk < pollDelay * 3;
      return {
        state: ok ? 'poll' : 'off',
        label: ok ? `http · ${ageTxt}` : `offline · ${ageTxt}`,
        detail,
      };
    }
    if (link.wsState === 'connecting') {
      return { state: 'connecting', label: 'conectando', detail };
    }
    if (link.wsState === 'open') {
      if (up.state === 'open') return { state: 'on', label: 'online', detail };
      if (up.state === 'connecting') return { state: 'connecting', label: `religando · ${ageTxt}`, detail };
      return { state: 'stale', label: `sem sinal · ${ageTxt}`, detail };
    }
    const wait = link.nextAttemptAt ? Math.max(0, Math.round((link.nextAttemptAt - Date.now()) / 1000)) : null;
    return {
      state: 'off',
      label: wait != null ? `offline · ${ageTxt} · ${wait}s` : `offline · ${ageTxt}`,
      detail,
    };
  }

  function refreshStatus() {
    const view = statusView();
    statusEl.className = `ws-status ws-status--${view.state}`;
    statusEl.textContent = view.label;
    statusEl.title = view.detail;
    // Permite ao CSS marcar o painel quando o dado esta muito velho.
    const stale = track.song && (Date.now() - track.at) > 15 * 60 * 1000;
    document.body.dataset.dataStale = stale ? '1' : '0';
  }
  setInterval(refreshStatus, 1000);

  // ---------- Perspectiva 3D da tela (mantida) ----------
  function readCssNumber(el, name) {
    return parseFloat(getComputedStyle(el).getPropertyValue(name));
  }
  function solveHomography(src, dst) {
    const A = [], B = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i];
      const [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -x*u, -y*u]); B.push(u);
      A.push([0, 0, 0, x, y, 1, -x*v, -y*v]); B.push(v);
    }
    const n = 8;
    for (let i = 0; i < n; i++) {
      let piv = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
      [A[i], A[piv]] = [A[piv], A[i]];
      [B[i], B[piv]] = [B[piv], B[i]];
      const div = A[i][i];
      for (let c = 0; c < n; c++) A[i][c] /= div;
      B[i] /= div;
      for (let r = 0; r < n; r++) if (r !== i) {
        const k = A[r][i];
        for (let c = 0; c < n; c++) A[r][c] -= k * A[i][c];
        B[r] -= k * B[i];
      }
    }
    return B;
  }
  function applyScreenPerspective() {
    if (!screenEl) return;
    const rect = screenEl.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    if (W < 1 || H < 1) return;
    const q = [
      [readCssNumber(screenEl, '--quad-tl-x'), readCssNumber(screenEl, '--quad-tl-y')],
      [readCssNumber(screenEl, '--quad-tr-x'), readCssNumber(screenEl, '--quad-tr-y')],
      [readCssNumber(screenEl, '--quad-br-x'), readCssNumber(screenEl, '--quad-br-y')],
      [readCssNumber(screenEl, '--quad-bl-x'), readCssNumber(screenEl, '--quad-bl-y')],
    ];
    const src = [[0, 0], [W, 0], [W, H], [0, H]];
    const dst = q.map(([rx, ry]) => [rx * W, ry * H]);
    const [h11, h12, h13, h21, h22, h23, h31, h32] = solveHomography(src, dst);
    screenEl.style.transform =
      `matrix3d(${h11},${h21},0,${h31}, ${h12},${h22},0,${h32}, 0,0,1,0, ${h13},${h23},0,1)`;
  }
  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(applyScreenPerspective);
  });
  window.addEventListener('load', applyScreenPerspective);

  // ---------- Bootstrap ----------
  function init() {
    applyScreenPerspective();
    applyStationFromConfig();

    // Pinta o ultimo estado conhecido ANTES de qualquer I/O de rede: em link
    // lento, o painel ja nasce preenchido em vez de mostrar tracos.
    if (track.song) {
      paintTrack(track.song);
      applyCover(track.song.imageUrl);
    } else {
      renderCarousel();
    }
    refreshStatus();

    if (isConfigComplete(config)) {
      detectBackend().then(() => transport.start());
    } else {
      showSetup();
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
