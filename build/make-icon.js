const sharp = require('sharp');
const pngToIcoMod = require('png-to-ico');
const pngToIco = pngToIcoMod.default || pngToIcoMod;
const fs = require('fs');
const path = require('path');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const svgPath = path.join(__dirname, 'logo.svg');

async function main() {
  const buffers = await Promise.all(SIZES.map(s =>
    sharp(svgPath).resize(s, s).png().toBuffer()
  ));
  // PNG haute résolution pour le "à propos" / la home (pas seulement l'icône système)
  await sharp(svgPath).resize(512, 512).png().toFile(path.join(__dirname, 'logo-512.png'));
  await sharp(svgPath).resize(128, 128).png().toFile(path.join(__dirname, 'logo-128.png'));

  const icoBuf = await pngToIco(buffers);
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), icoBuf);
  console.log('icon.ico écrit,', icoBuf.length, 'octets, tailles:', SIZES.join(','));
}
main().catch(e => { console.error('ERREUR:', e.message); process.exit(1); });
