# Hybrid Radio

Simulador interativo do painel multimidia exibindo a interface de uma radio em execucao. A foto `img/PainelCarro.webp` e usada como moldura, com overlay HTML/CSS sobre a tela central.

- Frontend: HTML + CSS + JS puro
- Backend: Node.js + Express + WebSocket (`ws`)
- Atualizacao da faixa atual: POST + broadcast WebSocket em tempo real
- Lista de radios: `public/stations.json` (editavel pelo desenvolvedor)

## Estrutura

```
HybridRadio/
├── public/
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   ├── stations.json
│   └── img/
│       ├── PainelCarro.webp
│       └── covers/        ← capas .png/.jpg/.svg referenciadas no JSON
├── server.js
├── package.json
└── README.md
```

## Pre-requisitos

- Node.js 18+ instalado.

## Instalacao

```powershell
npm install
```

## Execucao

```powershell
npm start
```

Servidor sobe em `http://localhost:3000`. Variavel `PORT` sobrescreve a porta.

Abra `http://localhost:3000` no navegador.

## Personalizando as radios

Edite `public/stations.json`:

```json
{
  "stations": [
    {
      "id": "swr3",
      "name": "SWR3",
      "band": "DAB",
      "frequency": "208.1 MHz",
      "cover": "img/covers/swr3.png",
      "playing": true
    }
  ]
}
```

- Coloque as imagens das capas em `public/img/covers/`.
- Apenas **uma** estacao deve ter `playing: true` (a que aparece em destaque). Se nenhuma, a primeira da lista vira a default.
- Apos editar, recarregue a pagina.

## Atualizando a faixa em execucao (tempo real)

Envie POST com a faixa atual; todos os clientes conectados recebem via WebSocket sem reload.

### PowerShell (Windows)

```powershell
Invoke-RestMethod -Uri http://localhost:3000/api/now-playing `
  -Method Post `
  -ContentType 'application/json' `
  -Body '{"artist":"Pascal Letoublon feat. Leony","title":"Friendships (Lost my love)","duration":210}'
```

### curl

```bash
curl -X POST http://localhost:3000/api/now-playing \
  -H "Content-Type: application/json" \
  -d '{"artist":"Pascal Letoublon feat. Leony","title":"Friendships (Lost my love)","duration":210}'
```

### Contrato

`POST /api/now-playing`

| campo    | tipo   | descricao                                |
|----------|--------|------------------------------------------|
| artist   | string | Artista da faixa                         |
| title    | string | Titulo da faixa                          |
| duration | number | Duracao total em segundos (ex: 210 = 3:30) |

Resposta: `200 { "ok": true }` ou `400 { "ok": false, "error": "..." }`.

`GET /api/now-playing` retorna o estado atual em JSON (util para diagnostico).

### WebSocket

Endpoint: `ws://localhost:3000` (mesmo host/porta do HTTP).

Mensagem servidor -> cliente:

```json
{ "type": "now-playing", "data": { "artist": "...", "title": "...", "duration": 210 } }
```

Enviada (a) ao conectar (estado vigente) e (b) sempre que um POST for recebido.
# HybridRadio
