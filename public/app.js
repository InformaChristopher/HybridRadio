(() => {
  // ---------- Referências DOM ----------
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

  // ---------- Configuração (persistência) ----------
  const STORAGE_KEY = 'hybridRadioConfig.v1';

  function loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function saveConfig(cfg) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  }
  function isConfigComplete(c) {
    return c && typeof c.wsUrl === 'string' && c.wsUrl.length > 0
      && typeof c.stationName === 'string' && c.stationName.length > 0
      && typeof c.stationFreq === 'string' && c.stationFreq.length > 0;
  }

  let config = loadConfig() || {
    wsUrl: '', wsToken: '', stationName: '', stationFreq: '',
    coverPrimary: null,
    covers: [null, null, null],
  };
  // Compat: configs antigas sem coverPrimary
  if (!('coverPrimary' in config)) config.coverPrimary = null;

  // ---------- Setup modal ----------
  function showSetup() {
    inputs.url.value   = config.wsUrl   || '';
    inputs.token.value = config.wsToken || '';
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

  // Redimensiona imagem para no máx 512x512 e converte para JPEG ~q0.82
  // — evita estourar localStorage (~5MB).
  function readImageDownscaled(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const max = 512;
          const ratio = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.round(img.width * ratio);
          const h = Math.round(img.height * ratio);
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
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
    // Só permite cancelar se já houver uma config salva
    if (isConfigComplete(config)) hideSetup();
    else { errorEl.textContent = 'Preencha a configuração antes de continuar.'; errorEl.hidden = false; }
  });
  overlayEl.addEventListener('click', (e) => {
    if (e.target === overlayEl && isConfigComplete(config)) hideSetup();
  });

  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    const wsUrl = inputs.url.value.trim();
    if (!/^wss?:\/\//i.test(wsUrl)) {
      errorEl.textContent = 'URL deve começar com ws:// ou wss://';
      errorEl.hidden = false;
      return;
    }
    const next = {
      wsUrl,
      wsToken: inputs.token.value.trim(),
      stationName: inputs.name.value.trim(),
      stationFreq: inputs.freq.value.trim(),
      coverPrimary: inputs.coverPrimary.dataset.dataUrl || config.coverPrimary || null,
      covers: inputs.covers.map((inp, i) => inp.dataset.dataUrl || config.covers[i] || null),
    };
    try {
      saveConfig(next);
    } catch (err) {
      errorEl.textContent = 'Falha ao salvar (provavelmente imagens grandes demais para o localStorage).';
      errorEl.hidden = false;
      return;
    }
    config = next;
    hideSetup();
    applyStationFromConfig();
    renderCarousel();
    connectWS();
  });

  // ---------- Renderização da UI ----------
  function applyStationFromConfig() {
    stationNameEl.textContent = config.stationName || '—';
    stationFreqEl.textContent = config.stationFreq || '—';
  }

  // imageUrl recebida no último song-changed (null se ausente/vazia).
  // Quando null, o carousel cai na imagem default do setup (config.coverPrimary).
  let liveImageUrl = null;
  let primaryLabel = '';

  function resolvePrimaryCover() {
    if (liveImageUrl) return liveImageUrl;
    if (config.coverPrimary) return config.coverPrimary;
    return null;
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

  // ---------- Mapeamento JSON → UI ----------
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

  function applySongChanged(data) {
    if (!data || typeof data !== 'object') return;
    if (typeof data.title === 'string')  trackTitleEl.textContent  = data.title  || '—';
    if (typeof data.artist === 'string') trackArtistEl.textContent = data.artist || '—';
    if ('duration' in data) trackDurationEl.textContent = formatDuration(parseDurationSeconds(data.duration));
    // A cada faixa: se vier imageUrl válida, usa; senão, cai na default do setup.
    const incoming = (typeof data.imageUrl === 'string') ? data.imageUrl.trim() : '';
    liveImageUrl = incoming || null;
    primaryLabel = data.title || '';
    renderCarousel();
  }

  function handleWsMessage(event) {
    let msg;
    try { msg = JSON.parse(event.data); }
    catch { console.warn('WS: payload não-JSON', event.data); return; }
    if (msg && msg.event === 'song-changed') {
      applySongChanged(msg.data);
    }
  }

  // ---------- Conexão WebSocket ----------
  let ws = null;
  const RECONNECT_MIN = 2000;
  const RECONNECT_MAX = 30000;
  let reconnectDelay = RECONNECT_MIN;
  let reconnectTimer = 0;

  function setStatus(state, text) {
    statusEl.className = `ws-status ws-status--${state}`;
    statusEl.textContent = text;
  }

  // Conecta direto no upstream. O backend aceita o token via querystring
  // (`?token=...`), então não precisamos de proxy: a URL base vem do setup
  // e o token é anexado aqui, preservando query params já existentes.
  function buildWsUrl() {
    const base = config.wsUrl;
    const token = config.wsToken;
    if (!token) return base;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}token=${encodeURIComponent(token)}`;
  }

  function connectWS() {
    if (!isConfigComplete(config)) return;
    clearTimeout(reconnectTimer);
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }
    let url;
    try { url = buildWsUrl(); } catch { return; }
    setStatus('connecting', 'conectando');
    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.error('WebSocket falhou ao instanciar', err);
      setStatus('off', 'offline');
      scheduleReconnect();
      return;
    }
    ws.addEventListener('open', () => {
      setStatus('on', 'online');
      statusEl.title = `Conectado a ${config.wsUrl}`;
      reconnectDelay = RECONNECT_MIN;
    });
    ws.addEventListener('message', handleWsMessage);
    ws.addEventListener('error', () => { /* close virá em seguida */ });
    ws.addEventListener('close', (ev) => {
      setStatus('off', 'offline');
      const reason = ev.reason ? ` — ${ev.reason}` : '';
      statusEl.title = `Desconectado (code=${ev.code})${reason}`;
      console.warn('[WS close]', ev.code, ev.reason || '(sem motivo)');
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (!isConfigComplete(config)) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWS, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
  }

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
    if (isConfigComplete(config)) {
      applyStationFromConfig();
      renderCarousel();
      connectWS();
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
