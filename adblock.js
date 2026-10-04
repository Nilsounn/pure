// Bloqueur de pub "façon uBlock Origin" pour Pure.
//
// Même méthode que uBO :
//  1. filtrage réseau avec les listes de filtres (EasyList, EasyPrivacy, uBlock filters,
//     badware, privacy, quick-fixes, unbreak, Peter Lowe + liste française) ;
//  2. filtrage cosmétique : masquage CSS des éléments publicitaires restants ;
//  3. scriptlets : scripts injectés au chargement de la page (ex. sur YouTube,
//     nettoyage de ytInitialPlayerResponse pour que la pub ne soit jamais planifiée).
//
// Le moteur est @ghostery/adblocker-electron, qui interprète la syntaxe des filtres uBO.
// Les listes sont téléchargées au lancement, mises en cache sur disque et rafraîchies
// toutes les 24 h.
const fs = require('fs');
const path = require('path');
const { app, net, webContents, ipcMain } = require('electron');
const { ElectronBlocker, Request } = require('@ghostery/adblocker-electron');

const BASE = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets';
const FILTER_LISTS = [
  `${BASE}/easylist/easylist.txt`,
  `${BASE}/easylist/easyprivacy.txt`,
  `${BASE}/peter-lowe/serverlist.txt`,
  `${BASE}/ublock-origin/badware.txt`,
  `${BASE}/ublock-origin/filters.txt`,
  `${BASE}/ublock-origin/filters-2020.txt`,
  `${BASE}/ublock-origin/filters-2021.txt`,
  `${BASE}/ublock-origin/filters-2022.txt`,
  `${BASE}/ublock-origin/filters-2023.txt`,
  `${BASE}/ublock-origin/filters-2024.txt`,
  `${BASE}/ublock-origin/privacy.txt`,
  `${BASE}/ublock-origin/quick-fixes.txt`,
  `${BASE}/ublock-origin/resource-abuse.txt`,
  `${BASE}/ublock-origin/unbreak.txt`,
  // Liste française (uBO l'active automatiquement pour les navigateurs en français)
  'https://raw.githubusercontent.com/easylist/easylistfrench/master/easylistfrench.txt'
];


const PRELOAD_PATH = path.join(__dirname, 'adblock-preload.js');
const PREFIX_SG = "if (typeof scriptletGlobals === 'undefined') { var scriptletGlobals = {}; };";

// Chaque scriptlet est isolé dans sa propre portée (sinon deux scriptlets qui déclarent la même
// classe/const au niveau global se plantent : "Identifier 'JSONPath' has already been declared"),
// tout en partageant le même objet scriptletGlobals, comme dans uBO.
function bundleScriptlets(scripts) {
  if (!scripts || !scripts.length) return '';
  const parts = scripts.map(sc => {
    const body = sc.startsWith(PREFIX_SG) ? sc.slice(PREFIX_SG.length) : sc;
    return 'try{(function(scriptletGlobals){' + body + '\n})(__sg)}catch(e){}';
  });
  return '(function(){const __sg={};' + parts.join(';\n') + '})();';
}

// Filet de sécurité YouTube : si le lecteur reste figé, le préchargement de la page le signale
// (pure:yt-stuck) et on recharge avec des règles YouTube plus légères, jusqu'au prochain lancement.
//   niveau 0 : tous les scriptlets uBO (blocage maximal)
//   niveau 1 : seulement les "set-constant" (suppression des pubs dans les données initiales du lecteur)
//   niveau 2 : aucun scriptlet sur YouTube (reste le masquage CSS + saut de pub côté page)
let ytLevel = 0;
let ytLastDegrade = 0;
const isYouTubeHost = (h) => /(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(h || '');
function filterForYouTube(scripts) {
  if (ytLevel <= 0) return scripts;
  if (ytLevel === 1) return scripts.filter(sc => sc.includes('function setConstantFn('));
  return [];
}

const CACHE_FILE = path.join(app.getPath('userData'), 'adblock-engine.bin');
const REFRESH_MS = 24 * 60 * 60 * 1000;

// net.fetch passe par la pile réseau de Chromium (proxy système inclus)
const fetchImpl = (url, opts) => net.fetch(url, opts);

const caching = {
  path: CACHE_FILE,
  read: (p) => fs.promises.readFile(p),
  write: (p, buf) => fs.promises.writeFile(p, buf)
};

function cacheIsFresh() {
  try { return Date.now() - fs.statSync(CACHE_FILE).mtimeMs < REFRESH_MS; } catch (e) { return false; }
}

async function buildEngine({ forceDownload }) {
  if (forceDownload) { try { fs.unlinkSync(CACHE_FILE); } catch (e) { /* pas de cache */ } }
  // fromLists utilise le cache disque s'il existe, sinon télécharge puis écrit le cache
  return ElectronBlocker.fromLists(fetchImpl, FILTER_LISTS, { enableCompression: true }, caching);
}

/**
 * @param {() => Electron.Session[]} getSessions  sessions où activer le blocage
 * @param {(sess, webContentsId) => void} onBlocked  appelé à chaque requête bloquée/redirigée
 */
function createAdblockService(getSessions, onBlocked) {
  let blocker = null;
  const enabled = new Set();
  const preloads = new Map(); // session -> id du preload d'injection
  const pending = new Set(); // sessions créées avant que le moteur soit prêt

  // Cosmétique : le moteur injecte lui-même les scriptlets, trop tard et sans isolation.
  // On garde son CSS (async) mais on retire les scripts : ils passent par adblock-preload.js.
  const patchEngine = (b) => {
    b.onInjectCosmeticFilters = async (event, url, msg) => {
      const req = Request.fromRawDetails({ url, type: 'main_frame' });
      const isFirstRun = msg === undefined;
      const { active, styles } = b.getCosmeticsFilters({
        domain: req.domain || '', hostname: req.hostname || '', url,
        classes: msg && msg.classes, hrefs: msg && msg.hrefs, ids: msg && msg.ids,
        getBaseRules: isFirstRun, getInjectionRules: false, getExtendedRules: false,
        getRulesFromHostname: isFirstRun, getRulesFromDOM: !isFirstRun,
        callerContext: { frameId: event.frameId, processId: event.processId, lifecycle: msg && msg.lifecycle }
      });
      if (active === false) return;
      if (styles && styles.length > 0) event.sender.insertCSS(styles, { cssOrigin: 'user' });
    };
  };

  ipcMain.on('pure:adblock-inject', (event, url) => {
    // Attention : returnValue répond immédiatement à l'appel synchrone, on ne l'assigne qu'une fois.
    let out = null;
    try {
      if (blocker && typeof url === 'string') {
        const req = Request.fromRawDetails({ url, type: 'main_frame' });
        const r = blocker.getCosmeticsFilters({
          domain: req.domain || '', hostname: req.hostname || '', url,
          getBaseRules: true, getInjectionRules: true, getExtendedRules: false,
          getRulesFromHostname: true, getRulesFromDOM: false
        });
        if (r.active !== false) {
          const scripts = isYouTubeHost(req.hostname) ? filterForYouTube(r.scripts || []) : r.scripts;
          out = { styles: r.styles || '', code: bundleScriptlets(scripts) };
        }
      }
    } catch (e) { out = null; }
    event.returnValue = out;
  });

  ipcMain.on('pure:yt-stuck', (event) => {
    if (ytLevel >= 2) return; // déjà au plus léger : inutile de recharger en boucle
    if (Date.now() - ytLastDegrade < 8000) return; // un seul cran à la fois
    ytLastDegrade = Date.now();
    ytLevel = Math.min(2, ytLevel + 1);
    console.log('[adblock] lecteur YouTube figé -> règles allégées (niveau ' + ytLevel + ')');
    try { event.sender.reloadIgnoringCache(); } catch (e) { /* onglet fermé */ }
  });

  const attach = (b) => {
    patchEngine(b);
    const handler = (request) => {
      try {
        const wc = request.tabId != null ? webContents.fromId(request.tabId) : null;
        onBlocked(wc && !wc.isDestroyed() ? wc.session : null, request.tabId);
      } catch (e) { /* compteur seulement : jamais bloquant */ }
    };
    b.on('request-blocked', handler);
    b.on('request-redirected', handler);
  };

  const enableOn = (sess) => {
    if (!blocker || !sess) return;
    try {
      blocker.enableBlockingInSession(sess);
      if (!preloads.has(sess)) { preloads.set(sess, sess.registerPreloadScript({ type: 'frame', filePath: PRELOAD_PATH })); }
      enabled.add(sess);
    } catch (e) { console.error('[adblock] enable', e); }
  };

  async function swapIn(next) {
    const old = blocker;
    const sessions = [...enabled];
    if (old) {
      for (const s of sessions) { try { old.disableBlockingInSession(s); } catch (e) { /* déjà retiré */ } }
    }
    blocker = next;
    attach(next);
    enabled.clear();
    sessions.forEach(enableOn);
  }

  async function start() {
    try {
      const fresh = cacheIsFresh();
      const b = await buildEngine({ forceDownload: !fresh && fs.existsSync(CACHE_FILE) });
      blocker = b;
      attach(b);
      [...getSessions(), ...pending].forEach(enableOn);
      pending.clear();
      console.log('[adblock] moteur prêt (' + (fresh ? 'cache' : 'listes téléchargées') + ')');
    } catch (e) {
      // Hors ligne au tout premier lancement : on garde le filtre de secours par domaines
      console.error('[adblock] échec du chargement des listes :', e && e.message);
    }
    setInterval(async () => {
      try {
        const next = await buildEngine({ forceDownload: true });
        await swapIn(next);
      } catch (e) { console.error('[adblock] rafraîchissement échoué :', e && e.message); }
    }, REFRESH_MS).unref();
  }

  // À appeler pour une session créée après le démarrage (ex. fenêtre privée)
  function enableSession(sess) {
    if (blocker) enableOn(sess); else pending.add(sess); // activée dès que le moteur est prêt
  }

  return { start, enableSession };
}

module.exports = { createAdblockService };
