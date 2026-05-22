const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);

// Proxy WebSocket. O browser não permite enviar headers customizados em
// WebSocket; este endpoint recebe conexões locais e abre o WS upstream
// com `Authorization: Bearer <token>` (ou o esquema já presente no token).
//
//   ws(s)://<host>/ws-proxy?target=<url-real>&token=<token>
//
// Faz pipe bidirecional cliente <-> upstream.
const wssProxy = new WebSocketServer({ noServer: true });

const CLOSE_RESERVED = new Set([1004, 1005, 1006, 1015]);
function safeCloseCode(code) {
  return (typeof code === 'number' && code >= 1000 && code <= 4999 && !CLOSE_RESERVED.has(code)) ? code : 1011;
}

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
    const token  = reqUrl.searchParams.get('token');

    if (!target || !/^wss?:\/\//i.test(target)) {
      clientWs.close(1008, 'target ausente ou invalido');
      return;
    }

    const headers = {};
    if (token) {
      const authValue = /^(Bearer|Basic|Token|JWT)\s/i.test(token) ? token : `Bearer ${token}`;
      headers['Authorization'] = authValue;
    }

    // Em redes corporativas o TLS pode ser interceptado e o cert apresentado
    // não constar no bundle do Node. `--use-system-ca` (flag do node) resolve
    // a maior parte; para certificados self-signed/ambientes de homologação,
    // basta iniciar o servidor com WS_PROXY_INSECURE=1.
    const insecure = process.env.WS_PROXY_INSECURE === '1';

    let upstream;
    try {
      upstream = new WebSocket(target, { headers, rejectUnauthorized: !insecure });
    } catch (err) {
      clientWs.close(1011, `upstream init: ${String(err.message).slice(0, 80)}`);
      return;
    }

    console.log(`[ws-proxy] → ${target} (auth=${token ? 'sim' : 'não'}, insecure=${insecure})`);

    upstream.on('open', () => console.log('[ws-proxy] upstream open'));

    upstream.on('unexpected-response', (_clientReq, res) => {
      const status = res.statusCode;
      console.error(`[ws-proxy] upstream HTTP ${status}`);
      let body = '';
      res.on('data', (c) => { if (body.length < 500) body += c.toString(); });
      res.on('end', () => {
        if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
          clientWs.close(1011, `upstream HTTP ${status}`.slice(0, 120));
        }
        if (body) console.error(`[ws-proxy] body: ${body.slice(0, 500)}`);
      });
    });

    upstream.on('message', (data, isBinary) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data, { binary: isBinary });
      }
    });

    upstream.on('close', (code, reason) => {
      console.log(`[ws-proxy] upstream close ${code} ${reason && reason.toString()}`);
      if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
        clientWs.close(safeCloseCode(code), reason ? reason.toString().slice(0, 120) : '');
      }
    });

    upstream.on('error', (err) => {
      console.error(`[ws-proxy] upstream error: ${err.message}`);
      if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
        clientWs.close(1011, String(err.message).slice(0, 120));
      }
    });

    clientWs.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      }
    });
    clientWs.on('close', () => {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        try { upstream.close(); } catch {}
      }
    });
    clientWs.on('error', () => {
      try { upstream.close(); } catch {}
    });
  });
});

server.listen(PORT, () => {
  console.log(`Hybrid Radio rodando em http://localhost:${PORT}`);
});
