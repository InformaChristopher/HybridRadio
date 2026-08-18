# Hybrid Radio

Simulador interativo do painel multimidia exibindo a interface de uma radio em
execucao. A foto `img/PainelCarro.png` e usada como moldura, com overlay
HTML/CSS sobre a tela central.

Os dados da faixa chegam por **WebSocket** de uma API externa. O projeto foi
construido assumindo que essa conexao **vai** cair, engasgar e voltar — o painel
nunca deve ficar em branco por causa disso.

- Frontend: HTML + CSS + JS puro (sem build)
- Backend opcional: Node.js + Express + `ws` (proxy resiliente)

---

## Como a resiliencia funciona

Cinco camadas independentes. Cada uma sozinha ja melhora o resultado; juntas,
cobrem praticamente todo cenario de rede ruim.

### 1. Estado persistido no navegador

A ultima faixa conhecida fica em `localStorage` e e pintada na tela **antes de
qualquer I/O de rede**. Abrir o painel sem internet mostra a ultima informacao
capturada, com a idade do dado no indicador de status — em vez de tracos.

### 2. Cache de estado no servidor (replay)

O proxy guarda o **ultimo frame de cada tipo de evento**. Quem conecta recebe
esse estado imediatamente, junto com a idade em ms.

Sem isso, recarregar a pagina significava esperar a proxima troca de musica
(ate ~4 minutos de painel vazio). Com isso, o painel pinta em menos de 100 ms.
O cache tambem vai para disco (`.cache/state.json`, gravado na borda de subida),
entao sobrevive a restart do servidor.

### 3. Conexao upstream compartilhada e auto-reparavel

- **Uma** conexao por `(target, token)`, com fan-out para todos os navegadores.
  Dez telas abertas = uma conexao na API, nao dez.
- Reconexao com backoff exponencial + jitter, **independente de haver cliente**.
  Recarregar a pagina nao derruba o upstream (ele fica vivo por 120 s ociosos).
- `ping`/`pong` + watchdog de silencio: derruba e refaz a conexao que ficou
  "meio-aberta" — o caso classico de 4G/NAT/wi-fi instavel, em que o TCP nao
  percebe que o outro lado sumiu.
- Timeout de handshake, para TLS travado nao pendurar a conexao para sempre.
- Se o cliente esta afogado (`bufferedAmount` alto), o servidor para de
  enfileirar frames para ele — o painel recebe o estado consolidado na proxima
  reconexao em vez de uma fila gigante de dados velhos.

### 4. Transporte do lado do cliente

- Timeout de abertura de 20 s (socket preso em `CONNECTING` nunca dispara
  `close` sozinho em algumas redes moveis).
- Watchdog: o proxy manda um batimento a cada 15 s; sem nada por 45 s, o painel
  reconecta por conta propria.
- Reconexao **imediata** (sem esperar backoff) quando a rede volta
  (`online`), quando a aba volta a ficar visivel, no `focus` e no `bfcache`.
- **Fallback HTTP**: se o WebSocket falhar 3 vezes seguidas (proxy corporativo,
  rede hostil), o painel passa a fazer polling em `/api/snapshot` — mais lento,
  porem entrega a informacao. Continua tentando voltar para WebSocket a cada
  45 s em segundo plano.
- Deduplicacao por assinatura da faixa: replay da mesma musica nao redesenha o
  carousel nem rebaixa a capa.

### 5. Pipeline de capas

- O servidor faz **prefetch** da capa assim que o evento chega — antes de
  qualquer navegador pedir.
- Cache em memoria + disco, servido de `/api/img` com `ETag` e `Cache-Control`
  longo. Se a origem cair, serve a copia antiga (*stale-if-error*).
- No navegador: preload fora da tela com timeout crescente (8 s / 14 s / 20 s) e
  3 tentativas. A imagem so entra na tela depois de carregada — sem piscar.
- Falhou? Mantem a capa atual ou cai na imagem default do setup. Nunca branco.
- Copia local (dataURL 512 px) em `localStorage` das ultimas 6 capas, entao a
  arte aparece mesmo com o servidor inacessivel.

### Indicador de status

O selo no canto superior direito mostra o estado combinado. Passar o mouse
mostra o diagnostico completo (alvo, transporte, estado do upstream, ultimo
erro, idade do dado).

| Selo | Significado |
|---|---|
| `online` | WebSocket ate o proxy **e** proxy ate a API, ambos abertos |
| `conectando` | Handshake em andamento |
| `religando · 2 min` | Proxy ok, API caiu, reconectando. Mostrando dado de 2 min atras |
| `sem sinal · 5 min` | Proxy ok, API sem resposta |
| `http · 30s` | Modo degradado por polling HTTP |
| `offline · 12 min · 8s` | Sem conexao. Dado de 12 min atras, nova tentativa em 8 s |

---

## Estrutura

```
HybridRadio/
├── public/                      ← isto e o que vai para hospedagem estatica
│   ├── index.html
│   ├── styles.css
│   ├── app.js                   ← transporte resiliente + UI
│   ├── stations.json
│   ├── staticwebapp.config.json ← config do Azure Static Web Apps
│   └── img/
├── lib/
│   ├── upstream-pool.js         ← conexoes compartilhadas, replay, persistencia
│   └── image-cache.js           ← prefetch e cache de capas
├── scripts/
│   └── mock-upstream.js         ← API falsa para testar quedas e lentidao
├── server.js
└── package.json
```

---

## Execucao local

```powershell
npm install
npm start
```

Sobe em `http://localhost:3000`. Abra e configure pela engrenagem:

| Campo | Descricao |
|---|---|
| URL do WebSocket | endpoint da API (`wss://...`) |
| Token | vira `Authorization: Bearer <token>` no upstream |
| Servidor de apoio | endereco do `server.js`. Vazio = mesma origem |
| Nome / Frequencia | textos exibidos no painel |
| Imagens | capa default + 3 secundarias (ficam no `localStorage`) |

Da tambem para pre-configurar pela URL (util em kiosk e no ambiente de stage):

```
http://localhost:3000/?ws=wss://api/radio&token=abc&station=SWR3&freq=208.1%20MHz
```

Os valores vao para o `localStorage` e a query string e limpa da barra.

### Testando conexao ruim

```powershell
npm run mock -- --port 4001 --interval 12 --drop 0.3 --latency 800
```

Depois aponte o painel para `ws://localhost:4001`.

| Flag | Efeito |
|---|---|
| `--interval` | segundos entre trocas de musica |
| `--drop` | probabilidade de derrubar a conexao a cada ciclo |
| `--latency` | atraso artificial em cada frame |
| `--halfopen` | congela a conexao sem fecha-la (NAT/wi-fi ruim) |
| `--token` | exige `Authorization` com esse valor |

---

## Modos de operacao

O mesmo `public/` roda em dois cenarios, detectados automaticamente no boot
(o painel testa `GET /api/health` no servidor de apoio):

| | **Modo proxy** | **Modo direto** |
|---|---|---|
| Quando | servido pelo `server.js`, ou com "Servidor de apoio" preenchido | hospedagem estatica sem backend |
| Header `Authorization` | sim | **nao** (limitacao do browser em WS) |
| Replay de estado ao conectar | sim | nao |
| Reconexao no servidor | sim | so no cliente |
| Cache/prefetch de capas | sim | nao |
| Fallback HTTP | sim | nao |
| Estado persistido no browser | sim | sim |
| Backoff, watchdog, wake-up | sim | sim |

No modo direto o token vai na querystring (`?token=...`), que e como a API
aceita — query params ja existentes na URL sao preservados.

---

## API do servidor

| Rota | Descricao |
|---|---|
| `GET /api/health` | diagnostico: uptime, links, estado de cada upstream |
| `GET /api/snapshot?target=&token=&since=` | estado atual em JSON (fallback HTTP). `204` se nada mudou desde `since` |
| `GET /api/img?u=<url>` | capa via cache do servidor |
| `WS /ws-proxy?target=&token=&hello=` | proxy WebSocket |

`hello` (opcional): frame enviado ao upstream a cada conexao — para APIs que
exigem uma mensagem de subscribe.

### Mensagens de controle (proxy -> painel)

Chegam junto com os frames da API, no namespace `__hr`. Consumidores antigos que
so olham `event === 'song-changed'` continuam funcionando.

```json
{ "event": "__hr", "type": "hello",    "serverTime": 0, "upstream": { } }
{ "event": "__hr", "type": "snapshot", "name": "song-changed", "age": 45231, "replay": true, "frame": { } }
{ "event": "__hr", "type": "upstream", "state": "open|connecting|closed", "attempt": 3, "nextRetryMs": 8000 }
{ "event": "__hr", "type": "hb",       "t": 0 }
```

O painel pode pedir o estado de novo a qualquer momento:
`{ "event": "__hr", "type": "resync" }`.

### Variaveis de ambiente

| Variavel | Default | Descricao |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | bind do servidor |
| `HR_CACHE_DIR` | `./.cache` | estado + capas em disco |
| `WS_PROXY_INSECURE` | — | `1` desliga verificacao TLS do upstream |
| `HR_RETRY_BASE_MS` / `HR_RETRY_MAX_MS` | `1000` / `20000` | backoff do upstream |
| `HR_HANDSHAKE_MS` | `15000` | timeout de handshake |
| `HR_PING_MS` / `HR_SILENCE_MS` | `20000` / `55000` | keepalive e watchdog |
| `HR_IDLE_TTL_MS` | `120000` | quanto o upstream sobrevive sem clientes |

Em rede corporativa com TLS interceptado, suba com
`NODE_OPTIONS=--use-system-ca` (ou `WS_PROXY_INSECURE=1` em homologacao).

---

## Publicacao — Azure Static Web Apps

> **Importante:** Static Web Apps serve arquivos estaticos e Azure Functions
> **HTTP**. Ele **nao** executa o `server.js` nem mantem WebSocket. Publicar so
> a pasta `public/` funciona, mas o painel roda em **modo direto** — sem replay,
> sem cache de capas, sem fallback HTTP e sem header `Authorization`.
>
> Para manter a resiliencia completa, o `server.js` precisa de um host com
> WebSocket (Azure App Service Linux/Node ou Container Apps) e o campo
> "Servidor de apoio" apontando para ele.

### Recurso alvo

| | |
|---|---|
| Nome | `HybridRadio` |
| Resource group | `HybridRadio_group` |
| Hostname | `lemon-sand-014f6a210.7.azurestaticapps.net` |
| Repo vinculado | `github.com/InformaChristopher/HybridRadio` (branch `main`) |
| Autenticacao | `DeploymentToken` |
| Ambientes de stage | habilitados |

### Opcao A — SWA CLI (mais direto, nao depende do GitHub)

```powershell
# 1. Autenticar
az login

# 2. Pegar o deployment token
az staticwebapp secrets list `
  --name HybridRadio `
  --resource-group HybridRadio_group `
  --query "properties.apiKey" -o tsv

# 3. Publicar no ambiente de stage
$env:SWA_CLI_DEPLOYMENT_TOKEN = "<token-do-passo-2>"
npm run deploy:stage
```

O comando imprime a URL do ambiente (algo como
`https://lemon-sand-014f6a210-stage.centralus.7.azurestaticapps.net`).
Para producao: `npm run deploy:prod`.

### Opcao B — GitHub Actions (o caminho em uso)

O repositorio `InformaChristopher/HybridRadio` ja tem o workflow gerado pelo
Azure (`.github/workflows/azure-static-web-apps-lemon-sand-014f6a210.yml`,
`app_location: ./public`).

- **push em `main`** → publica em producao;
- **pull request contra `main`** → cria o ambiente de stage e comenta a URL no PR;
- **fechar o PR** → derruba o ambiente.

> O `origin` local e `InformaWendel/HybridRadio`; o recurso do Azure escuta
> `InformaChristopher/HybridRadio` (remote `christopher` neste clone).

### Depois de publicar

O painel guarda a configuracao por navegador. Na primeira abertura, use a
engrenagem ou passe tudo pela URL:

```
https://<host-do-stage>/?ws=wss://api/radio&station=SWR3&freq=208.1%20MHz
```

Exigencias do modo direto:

- a API precisa ser `wss://` (pagina em HTTPS bloqueia `ws://` por mixed content);
- precisa estar acessivel pela internet;
- precisa aceitar o token na propria URL, ou nao exigir token.

Se algum item nao valer, publique tambem o `server.js`:

```powershell
az webapp up --name hybridradio-proxy --resource-group HybridRadio_group `
  --runtime "NODE:20-lts" --sku B1
az webapp config set --name hybridradio-proxy `
  --resource-group HybridRadio_group --web-sockets-enabled true
```

E preencha "Servidor de apoio" com
`https://hybridradio-proxy.azurewebsites.net`.
