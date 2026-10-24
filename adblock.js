// Bloqueur de pub "façon uBlock Origin" pour Pure.
//
// Même méthode que uBO :
//  1. filtrage réseau avec les listes de filtres (EasyList, EasyPrivacy, uBlock filters,
//     badware, privacy, quick-fixes, unbreak, Peter Lowe + liste française) ;
//  2. filtrage cosmétique : masquage CSS des éléments publicitaires restants ;
//  3. scriptlets : scripts injectés au chargement de la page. Sur YouTube, c'est le défuseur de Pure
//     (yt-defuser.js) qui reprend les scriptlets uBO actuels : la pub n'est jamais planifiée et la détection
//     de bloqueur ne se déclenche pas.
//
// Le moteur est @ghostery/adblocker-electron, qui interprète la syntaxe des filtres uBO.
// Les listes sont téléchargées au lancement, mises en cache sur disque et rafraîchies
// toutes les 24 h.
const fs = require('fs');
const path = require('path');
const { app, net, webContents, ipcMain } = require('electron');
const { ElectronBlocker, Request } = require('@ghostery/adblocker-electron');

// Listes officielles de uBlock Origin (uAssets), celles que uBO active par défaut : elles sont mises à jour
// plusieurs fois par semaine, notamment les règles anti-détection YouTube. Les copies de Ghostery servent
// uniquement de secours si une liste officielle est injoignable.
const UASSETS = 'https://ublockorigin.github.io/uAssets';
const GHOSTERY = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets';
const LISTS = [
  { url: `${UASSETS}/filters/filters.min.txt`,        fallback: `${GHOSTERY}/ublock-origin/filters.txt` },
  { url: `${UASSETS}/filters/badware.min.txt`,        fallback: `${GHOSTERY}/ublock-origin/badware.txt` },
  { url: `${UASSETS}/filters/privacy.min.txt`,        fallback: `${GHOSTERY}/ublock-origin/privacy.txt` },
  { url: `${UASSETS}/filters/quick-fixes.min.txt`,    fallback: `${GHOSTERY}/ublock-origin/quick-fixes.txt` },
  { url: `${UASSETS}/filters/unbreak.min.txt`,        fallback: `${GHOSTERY}/ublock-origin/unbreak.txt` },
  { url: `${UASSETS}/filters/resource-abuse.txt`,     fallback: `${GHOSTERY}/ublock-origin/resource-abuse.txt` },
  { url: `${UASSETS}/thirdparties/easylist.txt`,      fallback: `${GHOSTERY}/easylist/easylist.txt` },
  { url: `${UASSETS}/thirdparties/easyprivacy.txt`,   fallback: `${GHOSTERY}/easylist/easyprivacy.txt` },
  { url: `${GHOSTERY}/peter-lowe/serverlist.txt` },
  // Liste française (uBO l'active automatiquement pour les navigateurs en français)
  { url: 'https://raw.githubusercontent.com/easylist/easylistfrench/master/easylistfrench.txt' }
];
const FILTER_LISTS = LISTS.map(l => l.url);
const FALLBACKS = new Map(LISTS.filter(l => l.fallback).map(l => [l.url, l.fallback]));


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
//   niveau 0 : défuseur complet (yt-defuser.js) + filtrage réseau + masquage CSS
//   niveau 1 : seulement le piège sur les données initiales du lecteur
//   niveau 2 : aucun scriptlet (on passe directement au niveau 3 en cas de blocage)
//   niveau 3 : YouTube n'est plus filtré du tout (ni réseau, ni scriptlets) : le lecteur natif marche toujours,
//              les pubs éventuelles sont coupées/passées côté page (webview-preload.js)
// Le niveau est mémorisé 24 h (userData/adblock-yt-level.json) : si YouTube exige des règles plus légères sur cette machine,
// Pure n'a pas à le redécouvrir (rechargements) à chaque lancement ; il retente le blocage maximal le lendemain.
const YT_LEVEL_FILE = path.join(app.getPath('userData'), 'adblock-yt-level.json');
function loadYtLevel() {
  try {
    const j = JSON.parse(fs.readFileSync(YT_LEVEL_FILE, 'utf8'));
    if (j && Date.now() - j.at < 24 * 60 * 60 * 1000 && [0, 1, 2, 3].includes(j.level)) return j.level;
  } catch (e) { /* pas de fichier : niveau 0 */ }
  return 0;
}
function saveYtLevel(level) {
  try { fs.writeFileSync(YT_LEVEL_FILE, JSON.stringify({ level, at: Date.now() })); } catch (e) { /* non bloquant */ }
}
let ytLevel = loadYtLevel();
let ytLastDegrade = 0;
let ytDefuserSrc = '';
try { ytDefuserSrc = fs.readFileSync(path.join(__dirname, 'yt-defuser.js'), 'utf8'); } catch (e) { console.error('[adblock] yt-defuser.js introuvable', e && e.message); }
// niveau 0 : défuseur complet ; niveau 1 : seulement le piège sur ytInitialPlayerResponse ; niveaux 2 et 3 : aucun script
function ytScript() {
  if (!ytDefuserSrc || ytLevel >= 2) return '';
  return '(function(){const PURE_FULL=' + (ytLevel === 0) + ';' + ytDefuserSrc + '\n})();';
}
const isYouTubeHost = (h) => /(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(h || '');
const hostOfUrl = (u) => { try { return new URL(u).hostname; } catch (e) { return ''; } };
// Nouveau nom de cache : force le téléchargement des listes officielles uBO au premier lancement de cette version
const CACHE_FILE = path.join(app.getPath('userData'), 'adblock-engine-ubo.bin');
try { fs.unlinkSync(path.join(app.getPath('userData'), 'adblock-engine.bin')); } catch (e) { /* ancien cache absent */ }
const REFRESH_MS = 24 * 60 * 60 * 1000;

// net.fetch passe par la pile réseau de Chromium (proxy système inclus)
// Une liste officielle injoignable (ou en erreur HTTP) est remplacée par sa copie de secours.
const fetchImpl = async (url, opts) => {
  try {
    const r = await net.fetch(url, opts);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r;
  } catch (e) {
    const fb = FALLBACKS.get(url);
    if (!fb) throw e;
    console.warn('[adblock] liste officielle indisponible, copie de secours :', url);
    return net.fetch(fb, opts);
  }
};

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
 * @param {{contents?: (wc) => boolean, details?: (details) => boolean}} excl  sites exclus du blocage (réglage de Pure)
 */
function createAdblockService(getSessions, onBlocked, excl) {
  const isExcludedWc = (excl && excl.contents) || (() => false);
  const baseExcludedReq = (excl && excl.details) || (() => false);
  // Niveau 3 : toutes les requêtes émises par une page YouTube passent sans filtrage
  const isExcludedReq = (details) => {
    if (baseExcludedReq(details)) return true;
    if (ytLevel < 3) return false;
    try {
      const wc = details.webContentsId != null ? webContents.fromId(details.webContentsId) : null;
      const pageUrl = wc && !wc.isDestroyed() ? wc.getURL() : (details.referrer || '');
      return isYouTubeHost(hostOfUrl(pageUrl)) || isYouTubeHost(hostOfUrl(details.url));
    } catch (e) { return false; }
  };
  let blocker = null;
  const enabled = new Set();
  const preloads = new Map(); // session -> id du preload d'injection
  const pending = new Set(); // sessions créées avant que le moteur soit prêt

  // Cosmétique : le moteur injecte lui-même les scriptlets, trop tard et sans isolation.
  // On garde son CSS (async) mais on retire les scripts : ils passent par adblock-preload.js.
  const patchEngine = (b) => {
    b.onInjectCosmeticFilters = async (event, url, msg) => {
      if (isExcludedWc(event.sender)) return;   // site exclu : aucun masquage cosmétique
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
      if (blocker && typeof url === 'string' && !isExcludedWc(event.sender)) {
        const req = Request.fromRawDetails({ url, type: 'main_frame' });
        const r = blocker.getCosmeticsFilters({
          domain: req.domain || '', hostname: req.hostname || '', url,
          getBaseRules: true, getInjectionRules: true, getExtendedRules: false,
          getRulesFromHostname: true, getRulesFromDOM: false
        });
        if (r.active !== false) {
          // YouTube : défuseur de Pure à la place des scriptlets du moteur (qui ne gère pas les scriptlets « trusted » de uBO)
          const code = isYouTubeHost(req.hostname) ? ytScript() : bundleScriptlets(r.scripts);
          out = { styles: r.styles || '', code };
        }
      }
    } catch (e) { out = null; }
    event.returnValue = out;
  });

  // Le préchargement des pages (webview-preload.js) demande si le site courant est exclu (saut de pub YouTube côté page)
  ipcMain.on('pure:adblock-excluded', (event) => {
    let out = false;
    try { out = !!isExcludedWc(event.sender); } catch (e) { out = false; }
    event.returnValue = out;
  });

  ipcMain.on('pure:yt-stuck', (event) => {
    if (ytLevel >= 3) return; // déjà sans aucun filtrage : inutile de recharger en boucle
    if (Date.now() - ytLastDegrade < 2500) return; // un seul cran à la fois (la page renvoie son signal tant que le lecteur reste figé)
    ytLastDegrade = Date.now();
    ytLevel = ytLevel === 1 ? 3 : Math.min(3, ytLevel + 1);   // le niveau 2 (réseau filtré, sans défuseur) ne règle jamais la détection
    saveYtLevel(ytLevel);
    console.log('[adblock] lecteur YouTube figé -> règles allégées (niveau ' + ytLevel + ')');
    try { event.sender.reloadIgnoringCache(); } catch (e) { /* onglet fermé */ }
  });

  const attach = (b) => {
    patchEngine(b);
    // Sites exclus : les requêtes passent sans filtrage (le moteur appelle ces méthodes à chaque requête)
    const origBefore = b.onBeforeRequest, origHeaders = b.onHeadersReceived;
    b.onBeforeRequest = (details, callback) => { if (isExcludedReq(details)) { callback({}); return; } origBefore(details, callback); };
    b.onHeadersReceived = (details, callback) => { if (isExcludedReq(details)) { callback({}); return; } origHeaders(details, callback); };
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
