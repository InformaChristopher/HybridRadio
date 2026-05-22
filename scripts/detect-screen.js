// Detecta os 4 cantos da tela da multimídia em img/PainelCarro.png.
// Estratégia:
//   1) Identifica pixels que SÓ aparecem dentro da tela:
//        a) pixels muito coloridos (saturação alta) → ícones do CarPlay;
//        b) pixels de preto puro (luma < 22) → metade direita da tela.
//      A união desses pixels dá uma "semente" garantidamente dentro da tela.
//   2) Para cada y na faixa vertical da semente, varre horizontalmente
//      saindo do interior até encontrar pixel claro (luma > 130) → borda
//      esquerda/direita.
//   3) Para cada x na faixa horizontal da semente, varre verticalmente →
//      borda superior/inferior.
//   4) Fita reta em cada borda por mínimos quadrados, intersecciona →
//      4 cantos do quadrilátero da tela.

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const IMG = path.resolve(__dirname, '..', 'public', 'img', 'PainelCarro.png');
const png = PNG.sync.read(fs.readFileSync(IMG));
const { width: W, height: H, data } = png;

// Janela ampla onde a tela vive.
const WX0 = Math.floor(W * 0.28), WX1 = Math.floor(W * 0.80);
const WY0 = Math.floor(H * 0.28), WY1 = Math.floor(H * 0.75);

function pixel(x, y) {
  const i = (y * W + x) * 4;
  return [data[i], data[i + 1], data[i + 2]];
}
function luma(x, y) {
  const [r, g, b] = pixel(x, y);
  return (r + g + b) / 3;
}
function sat(x, y) {
  const [r, g, b] = pixel(x, y);
  return Math.max(r, g, b) - Math.min(r, g, b);
}

// Semente: pixels coloridos (ícones CarPlay) OU preto puro (luma < 22).
const seed = new Uint8Array(W * H);
let seedCount = 0;
for (let y = WY0; y < WY1; y++) {
  for (let x = WX0; x < WX1; x++) {
    const L = luma(x, y);
    const S = sat(x, y);
    const colored = S > 55 && L > 70 && L < 230;
    const pureBlack = L < 22;
    if (colored || pureBlack) {
      seed[y * W + x] = 1;
      seedCount++;
    }
  }
}
if (seedCount < 50) throw new Error('Poucos pixels-semente encontrados.');

// Bbox da semente (estimativa interna conservadora da tela).
let sMinX = W, sMaxX = 0, sMinY = H, sMaxY = 0;
for (let y = WY0; y < WY1; y++) {
  for (let x = WX0; x < WX1; x++) {
    if (seed[y * W + x]) {
      if (x < sMinX) sMinX = x; if (x > sMaxX) sMaxX = x;
      if (y < sMinY) sMinY = y; if (y > sMaxY) sMaxY = y;
    }
  }
}

// Borda "tela"/"moldura" definida por gradiente de luma:
//   moldura é prata clara (luma > 120);
//   tela é majoritariamente escura, com ícones coloridos.
function isOutside(x, y) {
  return luma(x, y) > 120;
}

// Para cada linha y dentro da faixa vertical da semente, acha:
//   leftEdgeX(y) = caminhando do centro da semente para a esquerda, o
//                  primeiro x para o qual isOutside(x,y) durante 8 pixels
//                  consecutivos. Esse é o ponto da borda esquerda na linha y.
//   rightEdgeX(y) = idem para a direita.
const sCx = Math.floor((sMinX + sMaxX) / 2);
const sCy = Math.floor((sMinY + sMaxY) / 2);
// Detecta a transição abrupta tela-escura → moldura-prata. Como começamos
// de dentro da tela (semente confiável) e caminhamos para fora, a PRIMEIRA
// transição encontrada é a borda real — botões pretos ficam ALÉM da
// moldura, fora do nosso scan.
const DARK_MAX = 85;     // pixel "dentro da tela"
const LIGHT_MIN = 130;   // pixel "moldura"
const STEP = 4;

function refineLeft(y, xRough) {
  for (let xx = xRough; xx >= xRough - STEP; xx--) {
    if (luma(xx, y) >= 100) return xx + 1;
  }
  return xRough;
}
function refineRight(y, xRough) {
  for (let xx = xRough; xx <= xRough + STEP; xx++) {
    if (luma(xx, y) >= 100) return xx - 1;
  }
  return xRough;
}
function refineUp(x, yRough) {
  for (let yy = yRough; yy >= yRough - STEP; yy--) {
    if (luma(x, yy) >= 100) return yy + 1;
  }
  return yRough;
}
function refineDown(x, yRough) {
  for (let yy = yRough; yy <= yRough + STEP; yy++) {
    if (luma(x, yy) >= 100) return yy - 1;
  }
  return yRough;
}

function scanLeft(y) {
  for (let x = sCx; x >= STEP; x--) {
    if (luma(x, y) < DARK_MAX && luma(x - STEP, y) > LIGHT_MIN) {
      return refineLeft(y, x);
    }
  }
  return -1;
}
function scanRight(y) {
  for (let x = sCx; x < W - STEP; x++) {
    if (luma(x, y) < DARK_MAX && luma(x + STEP, y) > LIGHT_MIN) {
      return refineRight(y, x);
    }
  }
  return -1;
}
function scanUp(x) {
  for (let y = sCy; y >= STEP; y--) {
    if (luma(x, y) < DARK_MAX && luma(x, y - STEP) > LIGHT_MIN) {
      return refineUp(x, y);
    }
  }
  return -1;
}
function scanDown(x) {
  for (let y = sCy; y < H - STEP; y++) {
    if (luma(x, y) < DARK_MAX && luma(x, y + STEP) > LIGHT_MIN) {
      return refineDown(x, y);
    }
  }
  return -1;
}

const leftPts = [], rightPts = [];
for (let y = sMinY + 10; y <= sMaxY - 10; y += 2) {
  const lx = scanLeft(y); if (lx > 0) leftPts.push([lx, y]);
  const rx = scanRight(y); if (rx > 0) rightPts.push([rx, y]);
}
const topPts = [], botPts = [];
for (let x = sMinX + 10; x <= sMaxX - 10; x += 2) {
  const ty = scanUp(x);   if (ty > 0) topPts.push([x, ty]);
  const by = scanDown(x); if (by > 0) botPts.push([x, by]);
}

// Filtro de outliers: descarta pontos a > 2σ da mediana.
function filterOutliers(pts, axis) {
  const vals = pts.map(p => p[axis]).slice().sort((a,b)=>a-b);
  const med = vals[Math.floor(vals.length / 2)];
  const mad = vals.map(v => Math.abs(v - med)).sort((a,b)=>a-b)[Math.floor(vals.length / 2)] || 1;
  return pts.filter(p => Math.abs(p[axis] - med) < 5 * mad);
}
const leftPtsF  = filterOutliers(leftPts,  0); // axis x
const rightPtsF = filterOutliers(rightPts, 0);
const topPtsF   = filterOutliers(topPts,   1); // axis y
const botPtsF   = filterOutliers(botPts,   1);

// Ajustes lineares.
function fitLineByX(pts) { // y = a*x + b
  const n = pts.length;
  let sx=0,sy=0,sxx=0,sxy=0;
  for (const [x,y] of pts) { sx+=x; sy+=y; sxx+=x*x; sxy+=x*y; }
  const a = (n*sxy - sx*sy) / (n*sxx - sx*sx);
  const b = (sy - a*sx) / n;
  return { a, b };
}
function fitLineByY(pts) { // x = c*y + d
  const n = pts.length;
  let sx=0,sy=0,syy=0,sxy=0;
  for (const [x,y] of pts) { sx+=x; sy+=y; syy+=y*y; sxy+=x*y; }
  const c = (n*sxy - sx*sy) / (n*syy - sy*sy);
  const d = (sx - c*sy) / n;
  return { c, d };
}

const top    = fitLineByX(topPtsF);
const bottom = fitLineByX(botPtsF);
const left   = fitLineByY(leftPtsF);
const right  = fitLineByY(rightPtsF);

function intersect(tb, lr) {
  const { a, b } = tb;
  const { c, d } = lr;
  const y = (a*d + b) / (1 - a*c);
  const x = c*y + d;
  return [x, y];
}
const TL = intersect(top, left);
const TR = intersect(top, right);
const BL = intersect(bottom, left);
const BR = intersect(bottom, right);

const fmt = (p) => `(${p[0].toFixed(1)}, ${p[1].toFixed(1)})  [${(100*p[0]/W).toFixed(3)}%, ${(100*p[1]/H).toFixed(3)}%]`;
console.log(`Image: ${W}x${H}`);
console.log(`Seed bbox px: [${sMinX}..${sMaxX}] × [${sMinY}..${sMaxY}]`);
console.log(`Edge sample counts:  L=${leftPtsF.length}/${leftPts.length}  R=${rightPtsF.length}/${rightPts.length}  T=${topPtsF.length}/${topPts.length}  B=${botPtsF.length}/${botPts.length}`);
console.log('--- Corners ---');
console.log(`TL  ${fmt(TL)}`);
console.log(`TR  ${fmt(TR)}`);
console.log(`BL  ${fmt(BL)}`);
console.log(`BR  ${fmt(BR)}`);

// AABB.
const aabb = {
  left:   Math.min(TL[0], BL[0]),
  right:  Math.max(TR[0], BR[0]),
  top:    Math.min(TL[1], TR[1]),
  bottom: Math.max(BL[1], BR[1]),
};
aabb.width  = aabb.right - aabb.left;
aabb.height = aabb.bottom - aabb.top;
console.log('--- AABB ---');
console.log(`top=${(100*aabb.top/H).toFixed(3)}%  left=${(100*aabb.left/W).toFixed(3)}%  width=${(100*aabb.width/W).toFixed(3)}%  height=${(100*aabb.height/H).toFixed(3)}%`);

function rel(p) {
  return [(p[0] - aabb.left) / aabb.width, (p[1] - aabb.top) / aabb.height];
}
const rTL = rel(TL), rTR = rel(TR), rBL = rel(BL), rBR = rel(BR);
console.log('--- Cantos relativos ao AABB (0..1) ---');
console.log(`rTL ${rTL.map(v=>v.toFixed(5)).join(', ')}`);
console.log(`rTR ${rTR.map(v=>v.toFixed(5)).join(', ')}`);
console.log(`rBR ${rBR.map(v=>v.toFixed(5)).join(', ')}`);
console.log(`rBL ${rBL.map(v=>v.toFixed(5)).join(', ')}`);

// clip-path: polygon(...) usando porcentagens relativas ao AABB.
console.log('--- clip-path polygon ---');
console.log(
  `clip-path: polygon(` +
  `${(rTL[0]*100).toFixed(3)}% ${(rTL[1]*100).toFixed(3)}%, ` +
  `${(rTR[0]*100).toFixed(3)}% ${(rTR[1]*100).toFixed(3)}%, ` +
  `${(rBR[0]*100).toFixed(3)}% ${(rBR[1]*100).toFixed(3)}%, ` +
  `${(rBL[0]*100).toFixed(3)}% ${(rBL[1]*100).toFixed(3)}%);`
);

// Imagem debug.
const dbg = new PNG({ width: W, height: H });
for (let i = 0; i < data.length; i += 4) {
  dbg.data[i]     = data[i];
  dbg.data[i + 1] = data[i + 1];
  dbg.data[i + 2] = data[i + 2];
  dbg.data[i + 3] = 255;
}
// Pinta pontos de borda em amarelo
function paintDot(px, py, color, r=2) {
  const cx = Math.round(px), cy = Math.round(py);
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = cx + dx, y = cy + dy;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = (y * W + x) * 4;
    dbg.data[i] = color[0]; dbg.data[i+1] = color[1]; dbg.data[i+2] = color[2];
  }
}
for (const p of leftPtsF)  paintDot(p[0], p[1], [255, 255, 0]);
for (const p of rightPtsF) paintDot(p[0], p[1], [255, 255, 0]);
for (const p of topPtsF)   paintDot(p[0], p[1], [255, 200, 0]);
for (const p of botPtsF)   paintDot(p[0], p[1], [255, 200, 0]);
// 4 cantos
for (const c of [TL, TR, BL, BR]) paintDot(c[0], c[1], [0, 255, 0], 8);
// Linhas das arestas detectadas (faz overlay verde)
function paintLine(x0, y0, x1, y1, color) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = Math.round(x0 + t*(x1-x0));
    const y = Math.round(y0 + t*(y1-y0));
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = (y * W + x) * 4;
    dbg.data[i] = color[0]; dbg.data[i+1] = color[1]; dbg.data[i+2] = color[2];
  }
}
paintLine(TL[0], TL[1], TR[0], TR[1], [0, 200, 255]);
paintLine(TR[0], TR[1], BR[0], BR[1], [0, 200, 255]);
paintLine(BR[0], BR[1], BL[0], BL[1], [0, 200, 255]);
paintLine(BL[0], BL[1], TL[0], TL[1], [0, 200, 255]);

fs.writeFileSync(path.resolve(__dirname, 'debug-mask.png'), PNG.sync.write(dbg));
console.log('Wrote scripts/debug-mask.png');
