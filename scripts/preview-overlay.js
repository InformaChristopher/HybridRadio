// Renderiza uma simulação do overlay HTML sobre a foto do painel, usando os
// 4 cantos do quad (mesmos valores que o CSS/JS usam). Serve para validar
// visualmente o alinhamento sem precisar abrir o navegador.

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const IMG = path.resolve(__dirname, '..', 'public', 'img', 'PainelCarro.png');
const png = PNG.sync.read(fs.readFileSync(IMG));
const { width: W, height: H, data } = png;

// AABB e quad — devem casar com styles.css.
const AABB = { top: 0.32396, left: 0.36166, width: 0.43951, height: 0.38514 };
const Q = {
  TL: [0.00174, 0.05008],
  TR: [0.91191, 0.00000],
  BR: [1.00000, 1.00000],
  BL: [0.00000, 0.95693],
};

const aabbXpx = AABB.left * W;
const aabbYpx = AABB.top * H;
const aabbWpx = AABB.width * W;
const aabbHpx = AABB.height * H;

// 4 cantos absolutos em pixels.
const TL = [aabbXpx + Q.TL[0] * aabbWpx, aabbYpx + Q.TL[1] * aabbHpx];
const TR = [aabbXpx + Q.TR[0] * aabbWpx, aabbYpx + Q.TR[1] * aabbHpx];
const BR = [aabbXpx + Q.BR[0] * aabbWpx, aabbYpx + Q.BR[1] * aabbHpx];
const BL = [aabbXpx + Q.BL[0] * aabbWpx, aabbYpx + Q.BL[1] * aabbHpx];

console.log('Quad corners (px):');
console.log(`  TL=(${TL[0].toFixed(1)}, ${TL[1].toFixed(1)})`);
console.log(`  TR=(${TR[0].toFixed(1)}, ${TR[1].toFixed(1)})`);
console.log(`  BR=(${BR[0].toFixed(1)}, ${BR[1].toFixed(1)})`);
console.log(`  BL=(${BL[0].toFixed(1)}, ${BL[1].toFixed(1)})`);

// Preview: pinta o interior do quad com tint translúcido (sobre a foto)
// e desenha o contorno em vermelho, simulando onde o overlay vai aparecer.
const out = new PNG({ width: W, height: H });
for (let i = 0; i < data.length; i += 4) {
  out.data[i]     = data[i];
  out.data[i + 1] = data[i + 1];
  out.data[i + 2] = data[i + 2];
  out.data[i + 3] = 255;
}
function pointInQuad(px, py) {
  const corners = [TL, TR, BR, BL];
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const [xi, yi] = corners[i], [xj, yj] = corners[j];
    if (((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
const tint = [80, 200, 100, 90]; // r,g,b,alpha
for (let y = Math.floor(Math.min(TL[1], TR[1])); y <= Math.ceil(Math.max(BL[1], BR[1])); y++) {
  for (let x = Math.floor(Math.min(TL[0], BL[0])); x <= Math.ceil(Math.max(TR[0], BR[0])); x++) {
    if (!pointInQuad(x, y)) continue;
    const i = (y * W + x) * 4;
    out.data[i]     = (tint[0] * tint[3] + out.data[i]     * (255 - tint[3])) / 255;
    out.data[i + 1] = (tint[1] * tint[3] + out.data[i + 1] * (255 - tint[3])) / 255;
    out.data[i + 2] = (tint[2] * tint[3] + out.data[i + 2] * (255 - tint[3])) / 255;
  }
}
function paintLine(x0, y0, x1, y1, color) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cx = Math.round(x0 + t*(x1-x0));
    const cy = Math.round(y0 + t*(y1-y0));
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = (y * W + x) * 4;
      out.data[i] = color[0]; out.data[i+1] = color[1]; out.data[i+2] = color[2];
    }
  }
}
paintLine(TL[0], TL[1], TR[0], TR[1], [255, 0, 60]);
paintLine(TR[0], TR[1], BR[0], BR[1], [255, 0, 60]);
paintLine(BR[0], BR[1], BL[0], BL[1], [255, 0, 60]);
paintLine(BL[0], BL[1], TL[0], TL[1], [255, 0, 60]);

fs.writeFileSync(path.resolve(__dirname, 'preview-overlay.png'), PNG.sync.write(out));
console.log('Wrote scripts/preview-overlay.png');
