// Extrait la partie ZIP d'un fichier .crx (formats CRX2 et CRX3) téléchargé depuis le Chrome Web Store.
function crxToZip(buf) {
  if (buf.length < 16 || buf.toString('utf8', 0, 4) !== 'Cr24') {
    throw new Error('Fichier CRX invalide ou extension non téléchargeable.');
  }
  const version = buf.readUInt32LE(4);
  let zipStart;
  if (version === 2) {
    const keyLen = buf.readUInt32LE(8);
    const sigLen = buf.readUInt32LE(12);
    zipStart = 16 + keyLen + sigLen;
  } else if (version === 3) {
    const headerLen = buf.readUInt32LE(8);
    zipStart = 12 + headerLen;
  } else {
    throw new Error('Version de CRX non supportée (' + version + ').');
  }
  return buf.subarray(zipStart);
}
module.exports = { crxToZip };
