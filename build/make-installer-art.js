// Génère les visuels de l'installateur (BMP 24 bits exigés par NSIS) aux couleurs de Pure.
// Usage : node build/make-installer-art.js   (nécessite sharp)
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SERIF = "'Liberation Serif', Georgia, 'Times New Roman', serif";
const SANS = "'Liberation Sans', 'Segoe UI', Arial, sans-serif";

function writeBmp24(file, width, height, rgb) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + rowSize * height);
  buf.write('BM', 0); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14); buf.writeInt32LE(width, 18); buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28); buf.writeUInt32LE(rowSize * height, 34);
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width * 3;   // BMP : lignes de bas en haut
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * 3, d = 54 + y * rowSize + x * 3;
      buf[d] = rgb[s + 2]; buf[d + 1] = rgb[s + 1]; buf[d + 2] = rgb[s];   // BGR
    }
  }
  fs.writeFileSync(file, buf);
}

async function render(svg, w, h, outBase) {
  const png = await sharp(Buffer.from(svg)).resize(w, h, { kernel: 'lanczos3' }).flatten({ background: '#ffffff' }).png().toBuffer();
  fs.writeFileSync(outBase + '.preview.png', png);
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  writeBmp24(outBase + '.bmp', info.width, info.height, data);
}

// Pastille du logo Pure : rond rose foncé + « P » italique crème
const badge = (cx, cy, r, fs, id) => `
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="#8C3459" ${id ? `filter="url(#${id})"` : ''}/>
  <circle cx="${cx}" cy="${cy}" r="${r - 5}" fill="none" stroke="#FBF1F5" stroke-opacity="0.22" stroke-width="2"/>
  <text x="${cx}" y="${cy + fs * 0.34}" text-anchor="middle" font-family="${SERIF}" font-style="italic" font-weight="700" font-size="${fs}" fill="#FBF1F5">P</text>`;

(async () => {
  // Barre latérale des pages d'accueil / de fin : 164 x 314 (dessinée en 2x)
  const side = `<svg xmlns="http://www.w3.org/2000/svg" width="328" height="628" viewBox="0 0 328 628">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#E693B5"/><stop offset="0.55" stop-color="#D9799F"/><stop offset="1" stop-color="#A8466F"/>
    </linearGradient>
    <filter id="sh" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#5A1D3A" flood-opacity="0.45"/></filter>
  </defs>
  <rect width="328" height="628" fill="url(#g)"/>
  <circle cx="330" cy="40" r="170" fill="#FBF1F5" fill-opacity="0.08"/>
  <circle cx="-30" cy="640" r="210" fill="#FBF1F5" fill-opacity="0.08"/>
  <circle cx="300" cy="520" r="70" fill="#FBF1F5" fill-opacity="0.07"/>
  ${badge(164, 200, 92, 124, 'sh')}
  <text x="164" y="378" text-anchor="middle" font-family="${SERIF}" font-style="italic" font-size="72" fill="#FBF1F5">Pure</text>
  <line x1="124" y1="410" x2="204" y2="410" stroke="#FBF1F5" stroke-opacity="0.45" stroke-width="2"/>
  <text x="164" y="450" text-anchor="middle" font-family="${SANS}" font-size="22" fill="#FBF1F5" fill-opacity="0.95">Navigation rapide,</text>
  <text x="164" y="482" text-anchor="middle" font-family="${SANS}" font-size="22" fill="#FBF1F5" fill-opacity="0.95">personnalisation forte.</text>
</svg>`;
  await render(side, 164, 314, path.join(__dirname, 'installer-sidebar'));

  // Bandeau des autres pages : 150 x 57, fond identique à MUI_BGCOLOR (F7DEEA)
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="228" viewBox="0 0 600 228">
  <rect width="600" height="228" fill="#F7DEEA"/>
  <circle cx="560" cy="20" r="110" fill="#EFC2D8" fill-opacity="0.55"/>
  <circle cx="420" cy="250" r="80" fill="#EFC2D8" fill-opacity="0.45"/>
  ${badge(486, 114, 70, 96, null)}
</svg>`;
  await render(head, 150, 57, path.join(__dirname, 'installer-header'));
  console.log('visuels de l\'installateur écrits');
})().catch(e => { console.error('ERREUR:', e.message); process.exit(1); });
