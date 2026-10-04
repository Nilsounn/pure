// Préchargé dans CHAQUE frame (pages, iframes, YouTube embarqué) de la session.
// Comme uBlock Origin, on injecte les scriptlets dans le monde "page" AVANT que les scripts
// du site ne s'exécutent : demande synchrone au processus principal, puis exécution immédiate.
// (La voie asynchrone du moteur arrive trop tard : YouTube a déjà lu ses données de pub.)
const { ipcRenderer, webFrame } = require('electron');

try {
  if (/^https?:$/.test(location.protocol)) {
    const res = ipcRenderer.sendSync('pure:adblock-inject', location.href);
    if (res) {
      if (res.styles) { try { webFrame.insertCSS(res.styles, { cssOrigin: 'user' }); } catch (e) { /* page fermée */ } }
      if (res.code) { webFrame.executeJavaScript(res.code).catch(() => { /* un scriptlet défaillant ne casse pas la page */ }); }
    }
  }
} catch (e) { /* jamais bloquant pour la page */ }
