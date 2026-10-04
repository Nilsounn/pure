const { app, BrowserWindow, session, ipcMain, dialog, net, clipboard, shell, nativeTheme, webContents, screen, MessageChannelMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { execFile } = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');
const { spawn } = require('child_process');
const { createUpdater } = require('./updater');
const { createPip } = require('./pip');
const { crxToZip } = require('./crx');
const { createVaultService } = require('./vault');
const { createAdblockService } = require('./adblock');

// --- Bloqueur de publicités / traqueurs (filtrage réseau) ---
const AD_BLOCK_DOMAINS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'google-analytics.com', 'googletagmanager.com', 'googletagservices.com',
  'adservice.google.com', 'adservice.google.co.uk',
  'scorecardresearch.com', 'quantserve.com', 'quantcast.com',
  'outbrain.com', 'taboola.com', 'adnxs.com', 'adsrvr.org',
  'criteo.com', 'criteo.net', 'pubmatic.com', 'rubiconproject.com',
  'openx.net', 'casalemedia.com', 'amazon-adsystem.com', 'moatads.com',
  '2mdn.net', 'adform.net', 'bidswitch.net', 'media.net', 'mathtag.com',
  'serving-sys.com', 'zedo.com', 'yieldmo.com', 'sharethrough.com',
  'teads.tv', 'smartadserver.com', 'adroll.com', 'chartbeat.com',
  'hotjar.com', 'mouseflow.com', 'crazyegg.com', 'bat.bing.com',
  'ads.linkedin.com', 'ads-twitter.com', 'static.ads-twitter.com',
  'analytics.twitter.com', 'ads-api.tiktok.com', 'analytics.tiktok.com',
  'connect.facebook.net', 'imasdk.googleapis.com', 'doubleverify.com',
  'adsafeprotected.com', 'flashtalking.com', 'tribalfusion.com',
  'exponential.com', 'contextweb.com', 'lijit.com', 'sovrn.com',
  'indexexchange.com', 'gumgum.com', 'triplelift.com', 'smaato.net',
  'vungle.com', 'applovin.com', 'unityads.unity3d.com', 'adcolony.com',
  'inmobi.com', 'chartboost.com', 'ironsrc.com', 'startapp.com',
  'mopub.com', '33across.com', 'bluekai.com', 'demdex.net', 'krxd.net',
  'exelator.com', 'rlcdn.com', 'agkn.com', 'adsymptotic.com',
  'ads.yahoo.com', 'advertising.com', 'adtechus.com', 'spotxchange.com',
  'springserve.com', 'freewheel.tv', 'fwmrm.net'
];

// YouTube sert ses publicités vidéo depuis le même domaine (googlevideo.com) que le
// contenu : impossible de les distinguer par domaine. En revanche, le pistage et la
// planification des pubs passent par des chemins dédiés sur youtube.com lui-même,
// ceux-là sont bloquables sans toucher à la lecture de la vidéo.
const YT_AD_PATH_HOSTS = ['youtube.com', 'youtube-nocookie.com'];
const YT_AD_PATHS = ['/api/stats/ads', '/ptracking', '/pagead/', '/get_midroll_info', '/log_event'];

function isBlocked(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (AD_BLOCK_DOMAINS.some(d => host === d || host.endsWith('.' + d))) return true;
    if (YT_AD_PATH_HOSTS.some(d => host === d || host.endsWith('.' + d))) {
      return YT_AD_PATHS.some(p => u.pathname.startsWith(p));
    }
    return false;
  } catch (e) {
    return false;
  }
}

// --- Instance unique : lancer Pure une seconde fois ramène simplement la fenêtre existante au premier plan ---
// L'installateur lance Pure.exe --register / --unregister : on écrit (ou retire) les clés Windows puis on quitte,
// sans verrou d'instance ni fenêtre (Pure peut déjà tourner pendant une mise à jour).
const HEADLESS_REGISTER = process.argv.includes('--register');
const HEADLESS_UNREGISTER = process.argv.includes('--unregister');
const HEADLESS = HEADLESS_REGISTER || HEADLESS_UNREGISTER;
const gotInstanceLock = HEADLESS ? true : app.requestSingleInstanceLock();
if (!gotInstanceLock) app.quit();


// --- Intégration Windows : Pure apparaît dans « Applications par défaut », ouvre les .html et les liens ---
const PROG_HTML = 'PureHTML', PROG_URL = 'PureURL';
const OPEN_EXTS = ['.html', '.htm', '.xhtml', '.xht', '.shtml', '.svg'];
const REG_REV = '1';   // à incrémenter si la liste de clés ci-dessous change : Pure se réenregistre au prochain lancement
const REG_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
const CLIENT_KEY = 'HKCU\\Software\\Clients\\StartMenuInternet\\Pure';
const canRegister = () => process.platform === 'win32' && app.isPackaged;

function regRun(args) {
  return new Promise(resolve => {
    execFile(REG_EXE, args, { windowsHide: true }, (err, stdout) => resolve({ err, out: String(stdout || '') }));
  });
}

function registryEntries(exe) {
  const C = 'HKCU\\Software\\Classes\\';
  const cap = CLIENT_KEY + '\\Capabilities';
  const open = '"' + exe + '" "%1"';
  const icon = exe + ',0';
  const e = [
    // Types de documents
    [C + PROG_HTML, null, 'REG_SZ', 'Document HTML Pure'],
    [C + PROG_HTML + '\\DefaultIcon', null, 'REG_SZ', icon],
    [C + PROG_HTML + '\\shell\\open\\command', null, 'REG_SZ', open],
    // Liens http / https
    [C + PROG_URL, null, 'REG_SZ', 'URL:Pure'],
    [C + PROG_URL, 'URL Protocol', 'REG_SZ', ''],
    [C + PROG_URL + '\\DefaultIcon', null, 'REG_SZ', icon],
    [C + PROG_URL + '\\shell\\open\\command', null, 'REG_SZ', open],
    // « Ouvrir avec… »
    [C + 'Applications\\Pure.exe', 'FriendlyAppName', 'REG_SZ', 'Pure'],
    [C + 'Applications\\Pure.exe\\shell\\open\\command', null, 'REG_SZ', open],
    // Fiche « navigateur » lue par Paramètres > Applications par défaut
    [CLIENT_KEY, null, 'REG_SZ', 'Pure'],
    [CLIENT_KEY, 'ExePath', 'REG_SZ', exe],
    [CLIENT_KEY, 'RegRev', 'REG_SZ', REG_REV],
    [CLIENT_KEY + '\\DefaultIcon', null, 'REG_SZ', icon],
    [CLIENT_KEY + '\\shell\\open\\command', null, 'REG_SZ', '"' + exe + '"'],
    [cap, 'ApplicationName', 'REG_SZ', 'Pure'],
    [cap, 'ApplicationIcon', 'REG_SZ', icon],
    [cap, 'ApplicationDescription', 'REG_SZ', 'Pure : navigateur rapide, bloqueur de pub intégré et personnalisation forte.'],
    [cap + '\\Startmenu', 'StartMenuInternet', 'REG_SZ', 'Pure'],
    [cap + '\\URLAssociations', 'http', 'REG_SZ', PROG_URL],
    [cap + '\\URLAssociations', 'https', 'REG_SZ', PROG_URL],
    ['HKCU\\Software\\RegisteredApplications', 'Pure', 'REG_SZ', 'Software\\Clients\\StartMenuInternet\\Pure\\Capabilities']
  ];
  OPEN_EXTS.forEach(x => {
    e.push([cap + '\\FileAssociations', x, 'REG_SZ', PROG_HTML]);
    e.push([C + x + '\\OpenWithProgids', PROG_HTML, 'REG_NONE', null]);
  });
  return e;
}

async function registerWithWindows() {
  const exe = process.execPath;
  for (const [key, name, type, data] of registryEntries(exe)) {
    const args = ['add', key, name === null ? '/ve' : '/v', ...(name === null ? [] : [name]), '/t', type];
    if (data !== null) args.push('/d', data);
    args.push('/f');
    await regRun(args);
  }
}

async function unregisterFromWindows() {
  const C = 'HKCU\\Software\\Classes\\';
  await regRun(['delete', C + PROG_HTML, '/f']);
  await regRun(['delete', C + PROG_URL, '/f']);
  await regRun(['delete', C + 'Applications\\Pure.exe', '/f']);
  await regRun(['delete', CLIENT_KEY, '/f']);
  await regRun(['delete', 'HKCU\\Software\\RegisteredApplications', '/v', 'Pure', '/f']);
  for (const x of OPEN_EXTS) await regRun(['delete', C + x + '\\OpenWithProgids', '/v', PROG_HTML, '/f']);
}

// Réenregistre Pure si les clés manquent, si l'exécutable a changé de dossier ou si la liste a évolué
async function ensureWindowsRegistration() {
  if (!canRegister()) return;
  const r = await regRun(['query', CLIENT_KEY, '/v', 'ExePath']);
  const rev = await regRun(['query', CLIENT_KEY, '/v', 'RegRev']);
  const okPath = !r.err && r.out.toLowerCase().includes(process.execPath.toLowerCase());
  const okRev = !rev.err && new RegExp('RegRev\\s+REG_SZ\\s+' + REG_REV + '\\s*$', 'm').test(rev.out);
  if (!okPath || !okRev) await registerWithWindows();
}

async function userChoiceProgId(proto) {
  const r = await regRun(['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\' + proto + '\\UserChoice', '/v', 'ProgId']);
  if (r.err) return '';
  const m = r.out.match(/ProgId\s+REG_SZ\s+(\S+)/i);
  return m ? m[1] : '';
}

// Windows interdit à une application de se définir elle-même par défaut : on lit donc le choix de l'utilisateur
async function isDefaultBrowser() {
  if (process.platform !== 'win32') return false;
  const [h, s] = await Promise.all([userChoiceProgId('http'), userChoiceProgId('https')]);
  return h.toLowerCase() === PROG_URL.toLowerCase() && s.toLowerCase() === PROG_URL.toLowerCase();
}

// Fichiers et liens passés à Pure.exe (double-clic sur un .html, lien ouvert depuis une autre application...)
function launchTargets(argv, cwd) {
  const out = [];
  for (const raw of (argv || []).slice(1)) {
    const a = String(raw || '').trim().replace(/^"+|"+$/g, '');
    if (!a || a.startsWith('-')) continue;
    try {
      if (/^https?:\/\//i.test(a)) { out.push(new URL(a).href); continue; }
      let p = null;
      if (/^file:\/\//i.test(a)) p = fileURLToPath(a);
      else p = path.resolve(cwd || process.cwd(), a);
      if (!OPEN_EXTS.includes(path.extname(p).toLowerCase())) continue;
      if (fs.existsSync(p) && fs.statSync(p).isFile()) out.push(pathToFileURL(p).href);
    } catch (err) { /* argument ignoré */ }
  }
  return out.slice(0, 10);
}

let pendingOpen = launchTargets(process.argv, process.cwd());
let mainReady = false;

function focusWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function deliverUrls(urls) {
  if (!urls || !urls.length) return;
  const alive = [...normalWindows].filter(w => !w.isDestroyed());
  const main = mainWindow && !mainWindow.isDestroyed() && normalWindows.has(mainWindow) ? mainWindow : null;
  if (main) {
    if (!mainReady) { pendingOpen.push(...urls); return; }   // l'interface n'est pas encore prête : elle viendra les chercher
    main.webContents.send('open-urls', urls);
    if (main.isVisible()) focusWindow(main);
  } else if (alive.length) {
    alive[0].webContents.send('open-urls', urls);
    focusWindow(alive[0]);
  } else {
    // Il ne reste que des fenêtres privées : on ouvre le lien dans une fenêtre normale
    createDetachedWindow(null, { url: urls[0] });
  }
}

ipcMain.handle('launch:take-pending', (e) => {
  if (mainWindow && !mainWindow.isDestroyed() && e.sender === mainWindow.webContents) {
    mainReady = true;
    const list = pendingOpen;
    pendingOpen = [];
    return list;
  }
  return [];
});

ipcMain.handle('default:status', async () => {
  if (!canRegister()) return { supported: false, isDefault: false };
  return { supported: true, isDefault: await isDefaultBrowser() };
});

ipcMain.handle('default:open-settings', async () => {
  if (!canRegister()) return false;
  await ensureWindowsRegistration();   // garantit que Pure figure bien dans la liste des navigateurs
  try { await shell.openExternal('ms-settings:defaultapps?registeredAppUser=Pure'); return true; }
  catch (err) {
    try { await shell.openExternal('ms-settings:defaultapps'); return true; } catch (e2) { return false; }
  }
});


// --- Mise à jour intégrée : GitHub Releases de Nilsounn/pure ---
const UPDATE_REPO = 'Nilsounn/pure';
const UPDATE_EVERY_MS = 4 * 60 * 60 * 1000;
let updater = null;

function getUpdater() {
  if (updater) return updater;
  updater = createUpdater({
    repo: UPDATE_REPO,
    getVersion: () => app.getVersion(),
    tempDir: path.join(app.getPath('temp'), 'PureUpdate'),
    onState: (st) => {
      for (const w of normalWindows) {
        if (!w.isDestroyed()) w.webContents.send('update:state', { ...st, supported: canRegister() });
      }
    },
    // L'installateur ferme Pure (au besoin), remplace les fichiers sans rien demander puis relance Pure
    launchInstaller: (file) => {
      const child = spawn(file, ['/S'], { detached: true, stdio: 'ignore' });
      child.on('error', () => { /* le prochain contrôle affichera l'erreur */ });
      child.unref();
      setTimeout(() => app.quit(), 250);
    }
  });
  return updater;
}

function autoCheckForUpdate() {
  if (!canRegister()) return;                                   // seulement l'application installée sous Windows
  if (readStore().settings.autoUpdate === false) return;
  getUpdater().check(false);
}

ipcMain.handle('update:get-state', () => ({ ...getUpdater().getState(), supported: canRegister() }));
ipcMain.handle('update:check', async () => {
  if (!canRegister()) return { ...getUpdater().getState(), supported: false };
  const st = await getUpdater().check(true);
  return { ...st, supported: true };
});
ipcMain.handle('update:install', () => (canRegister() ? getUpdater().install() : false));

// --- Vidéo détachée (fenêtre flottante) ---
const pipSvc = createPip({ app, BrowserWindow, MessageChannelMain, ipcMain, screen, webContents, userDataDir: app.getPath('userData') });

let mainWindow = null;
const normalWindows = new Set();   // fenêtre principale + fenêtres issues d'un onglet détaché
const privateWindows = new Set();
let pureSession = null;
let privateSession = null;

// Compteur de blocages : par onglet (remis à zéro à chaque navigation) + total persistant
const perTabBlocked = new Map(); // webContentsId -> count
let lifetimeBlocked = 0;
let lifetimeDirty = 0;

// Les touches pressées dans une page web n'atteignent pas l'interface : on les intercepte ici
function shortcutFor(i) {
  if (i.type !== 'keyDown') return null;
  const ctrl = !!i.control, shift = !!i.shift, alt = !!i.alt;
  const k = String(i.key || '').toLowerCase();
  const code = String(i.code || '');
  if (!ctrl && !alt) {
    if (i.key === 'F12') return 'devtools';
    if (i.key === 'F5') return 'reload';
    if (i.key === 'F6') return 'focus-address';
    if (i.key === 'F11') return 'fullscreen';
    if (i.key === 'F3') return shift ? 'find-prev' : 'find-next';
    return null;
  }
  if (alt && !ctrl) {
    if (i.key === 'ArrowLeft') return 'back';
    if (i.key === 'ArrowRight') return 'forward';
    if (k === 'd') return 'focus-address';
    return null;
  }
  if (ctrl && alt) return null;            // AltGr (clavier AZERTY) : on ne touche pas aux caractères saisis
  if (i.key === 'F5') return 'hard-reload';
  if (i.key === 'F4') return 'close-tab';
  if (i.key === 'Tab') return shift ? 'prev-tab' : 'next-tab';
  if (i.key === 'PageDown') return 'next-tab';
  if (i.key === 'PageUp') return 'prev-tab';
  if (!shift && /^Digit[1-9]$/.test(code)) return 'tab:' + code.slice(5);
  if (!shift && /^Numpad[1-9]$/.test(code)) return 'tab:' + code.slice(6);
  if (code === 'Digit0' || code === 'Numpad0') return 'zoom-reset';
  if (i.key === '+' || i.key === '=' || code === 'NumpadAdd') return 'zoom-in';
  if (i.key === '-' || i.key === '_' || code === 'NumpadSubtract') return 'zoom-out';
  if (shift) {
    if (k === 'i' || k === 'j') return 'devtools';
    if (k === 'r') return 'hard-reload';
    if (k === 't') return 'reopen-tab';
    if (k === 'n') return 'private-window';
    if (k === 'p') return 'pip';
    return null;
  }
  switch (k) {
    case 't': return 'new-tab';
    case 'w': return 'close-tab';
    case 'r': return 'reload';
    case 'l': return 'focus-address';
    case 'd': return 'bookmark';
    case 'f': return 'find';
    case 'g': return 'find-next';
    case 'p': return 'print';
    case 'h': return 'history';
    case 'j': return 'downloads';
    default: return null;
  }
}

function watchShortcuts(wc, getHost) {
  wc.on('before-input-event', (event, input) => {
    const name = shortcutFor(input);
    if (!name) return;
    const host = getHost();
    if (!host || host.isDestroyed()) return;
    event.preventDefault();
    host.send('shortcut', name);
  });
}

app.on('web-contents-created', (event, contents) => {
  if (contents.getType() !== 'webview') return;
  watchShortcuts(contents, () => contents.hostWebContents);
  contents.on('did-navigate', () => perTabBlocked.set(contents.id, 0));
  contents.on('did-navigate-in-page', () => { /* navigation interne : on garde le compteur */ });
  contents.on('destroyed', () => perTabBlocked.delete(contents.id));

  // Clic droit dans une page : on relaie les infos à l'interface, qui affiche son propre menu (aux couleurs du thème)
  contents.on('context-menu', (e, params) => {
    const host = contents.hostWebContents;
    if (!host || host.isDestroyed()) return;
    // Position exacte du clic, relative au contenu de la fenêtre (indépendante de la mise à l'échelle Windows)
    let x = params.x, y = params.y;
    const win = BrowserWindow.fromWebContents(host);
    if (win) {
      const cur = screen.getCursorScreenPoint(), cb = win.getContentBounds();
      if (cur.x >= cb.x && cur.x < cb.x + cb.width && cur.y >= cb.y && cur.y < cb.y + cb.height) { x = cur.x - cb.x; y = cur.y - cb.y; }
    }
    host.send('page:context-menu', {
      id: contents.id, x, y,
      params: {
        x: params.x, y: params.y,
        linkURL: params.linkURL || '', srcURL: params.srcURL || '', mediaType: params.mediaType || 'none',
        selectionText: (params.selectionText || '').slice(0, 500),
        isEditable: !!params.isEditable, editFlags: params.editFlags || {}
      }
    });
  });
});

ipcMain.handle('page:ctx-action', (e, d) => {
  const wc = d && webContents.fromId(d.id);
  if (!wc || wc.isDestroyed() || wc.hostWebContents !== e.sender) return false;
  switch (d.action) {
    case 'cut': wc.cut(); break;
    case 'copy': wc.copy(); break;
    case 'paste': wc.paste(); break;
    case 'selectAll': wc.selectAll(); break;
    case 'copyText': if (typeof d.text === 'string') clipboard.writeText(d.text); break;
    case 'copyImage': wc.copyImageAt(Math.round(d.x) || 0, Math.round(d.y) || 0); break;
    case 'saveImage': if (/^(https?:|data:)/i.test(d.url || '')) wc.downloadURL(d.url); break;
    case 'print': wc.print(); break;
  }
  return true;
});

function windowsForSession(sess) {
  if (sess === pureSession) return [...normalWindows].filter(w => !w.isDestroyed());
  if (sess === privateSession) return [...privateWindows].filter(w => !w.isDestroyed());
  return [];
}

// Compteur partagé : utilisé par le filtre de secours ci-dessous ET par le moteur uBO-compatible
function countBlocked(sess, id) {
  if (id != null) perTabBlocked.set(id, (perTabBlocked.get(id) || 0) + 1);
  lifetimeBlocked++;
  lifetimeDirty++;
  if (lifetimeDirty >= 15) { lifetimeDirty = 0; persistLifetimeBlocked(); }
  windowsForSession(sess).forEach(w => {
    w.webContents.send('adblock:update', { webContentsId: id, tabCount: id != null ? perTabBlocked.get(id) : null, lifetime: lifetimeBlocked });
  });
}

// Filtre de secours (liste de domaines) : actif uniquement le temps que le moteur de listes
// (adblock.js) soit chargé, ou s'il n'a pas pu l'être (premier lancement hors ligne).
// Une fois le moteur prêt, il prend la place de ce gestionnaire.
function setupAdBlocker(sess) {
  sess.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    if (isBlocked(details.url)) {
      countBlocked(sess, details.webContentsId);
      callback({ cancel: true });
    } else {
      callback({ cancel: false });
    }
  });
}

let adblockSvc = null;

// Electron 35+ expose les extensions via session.extensions (anciennes méthodes dépréciées)
const extApi = () => pureSession.extensions || pureSession;

function persistLifetimeBlocked() {
  const data = readStore();
  data.blockedTotal = lifetimeBlocked;
  writeStore(data);
}

// --- Stockage centralisé ---
const STORE_PATH = path.join(app.getPath('userData'), 'pure-data.json');
const EXT_DIR = path.join(app.getPath('userData'), 'extensions');
const HISTORY_CAP = 300;
const DOWNLOAD_CAP = 150;

const DEFAULT_SETTINGS = {
  accentColor: '#D9799F', launchAtStartup: true, theme: 'system',
  wallpaper: null, wallpaperRev: 0, wallpaperDim: 0.25,
  searchEngine: 'ddg', homeWidgets: true, notes: '', tasks: [],
  animFps: 60,   // 0 = animations désactivées, 30 / 60 / 120, 999 = cadence de l'écran
  autoUpdate: true,   // vérifie les mises à jour au lancement et les télécharge en tâche de fond
  askDefaultBrowser: true   // propose de définir Pure comme navigateur par défaut au lancement
};
const ANIM_FPS_VALUES = [0, 30, 60, 120, 999];
const WP_DIR = path.join(app.getPath('userData'), 'wallpaper');
const WP_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp'];

function wallpaperUrl(st) {
  if (!st.wallpaper) return null;
  const file = path.join(WP_DIR, path.basename(st.wallpaper));
  if (!fs.existsSync(file)) return null;
  return require('url').pathToFileURL(file).href + '?v=' + (st.wallpaperRev || 0);
}
function publicSettings(st) { return { ...st, wallpaperUrl: wallpaperUrl(st) }; }

// Seules ces clés peuvent être modifiées depuis l'interface (le fond d'écran passe par ses propres commandes)
function sanitizePatch(p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  const types = { accentColor: 'string', launchAtStartup: 'boolean', theme: 'string', wallpaperDim: 'number', searchEngine: 'string', homeWidgets: 'boolean', notes: 'string', tasks: 'object', animFps: 'number', askDefaultBrowser: 'boolean', autoUpdate: 'boolean' };
  Object.keys(types).forEach(k => { if (k in p && typeof p[k] === types[k]) out[k] = p[k]; });
  if ('accentColor' in out && !/^#[0-9a-fA-F]{6}$/.test(out.accentColor)) delete out.accentColor;
  if ('theme' in out && !['light', 'dark', 'system'].includes(out.theme)) delete out.theme;
  if ('searchEngine' in out && !['ddg', 'google', 'brave', 'qwant', 'startpage', 'ecosia'].includes(out.searchEngine)) delete out.searchEngine;
  if ('animFps' in out && !ANIM_FPS_VALUES.includes(out.animFps)) delete out.animFps;
  if ('wallpaperDim' in out) out.wallpaperDim = Math.min(0.7, Math.max(0, out.wallpaperDim || 0));
  if ('notes' in out) out.notes = out.notes.slice(0, 5000);
  if ('tasks' in out) {
    out.tasks = Array.isArray(out.tasks)
      ? out.tasks.slice(0, 50).map(t => ({ id: String((t && t.id) || ''), text: String((t && t.text) || '').slice(0, 120), done: !!(t && t.done) })).filter(t => t.text)
      : [];
  }
  return out;
}

// Le thème de l'application pilote aussi prefers-color-scheme des pages web
function applyNativeTheme(theme) {
  nativeTheme.themeSource = ['light', 'dark'].includes(theme) ? theme : 'system';
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return {
      bookmarks: data.bookmarks || [],
      shortcuts: data.shortcuts || [],
      hiddenTop: data.hiddenTop || [],
      history: data.history || [],
      session: data.session || [],
      extensions: data.extensions || [],
      settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
      downloads: data.downloads || [],
      blockedTotal: data.blockedTotal || 0
    };
  } catch (e) {
    return {
      bookmarks: [], shortcuts: [], hiddenTop: [], history: [], session: [], extensions: [],
      settings: { ...DEFAULT_SETTINGS }, downloads: [], blockedTotal: 0
    };
  }
}

function writeStore(data) {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(data), 'utf8');
  } catch (e) {
    // stockage best-effort : une erreur d'écriture n'interrompt pas la navigation
  }
}

// Favoris
ipcMain.handle('store:get-bookmarks', () => readStore().bookmarks);

ipcMain.handle('store:add-bookmark', (e, bookmark) => {
  const data = readStore();
  if (!data.bookmarks.some(b => b.url === bookmark.url)) {
    data.bookmarks.push({ url: bookmark.url, title: bookmark.title || bookmark.url, favicon: bookmark.favicon || null });
  }
  writeStore(data);
  return data.bookmarks;
});

ipcMain.handle('store:remove-bookmark', (e, url) => {
  const data = readStore();
  data.bookmarks = data.bookmarks.filter(b => b.url !== url);
  writeStore(data);
  return data.bookmarks;
});

// Raccourcis (tuiles de la page nouvel onglet)
function shortcutsPayload(data) { return { shortcuts: data.shortcuts, hidden: data.hiddenTop }; }

ipcMain.handle('store:get-shortcuts', () => shortcutsPayload(readStore()));

ipcMain.handle('store:add-shortcut', (e, s) => {
  const data = readStore();
  if (!data.shortcuts.some(x => x.url === s.url)) {
    data.shortcuts.push({ url: s.url, title: s.title || hostOf(s.url) || s.url, favicon: s.favicon || null });
  }
  const h = hostOf(s.url);
  data.hiddenTop = data.hiddenTop.filter(x => x !== h);
  writeStore(data);
  return shortcutsPayload(data);
});

ipcMain.handle('store:remove-shortcut', (e, url) => {
  const data = readStore();
  data.shortcuts = data.shortcuts.filter(x => x.url !== url);
  writeStore(data);
  return shortcutsPayload(data);
});

ipcMain.handle('store:hide-top', (e, host) => {
  const data = readStore();
  if (host && !data.hiddenTop.includes(host)) data.hiddenTop.push(host);
  writeStore(data);
  return shortcutsPayload(data);
});

// Historique (jamais appelé par les fenêtres de navigation privée, côté renderer)
ipcMain.handle('store:get-history', () => readStore().history);

ipcMain.handle('store:record-visit', (e, entry) => {
  const data = readStore();
  const existing = data.history.find(h => h.url === entry.url);
  if (existing) {
    if (entry.title) existing.title = entry.title;
    if (entry.favicon) existing.favicon = entry.favicon;
    existing.visits = (existing.visits || 1) + 1;
    existing.lastVisit = Date.now();
  } else {
    data.history.unshift({ url: entry.url, title: entry.title || entry.url, favicon: entry.favicon || null, visits: 1, lastVisit: Date.now() });
  }
  if (entry.favicon) {
    const host = hostOf(entry.url);
    data.bookmarks.forEach(b => { if (!b.favicon && hostOf(b.url) === host) b.favicon = entry.favicon; });
    data.shortcuts.forEach(s => { if (!s.favicon && hostOf(s.url) === host) s.favicon = entry.favicon; });
  }
  data.history.sort((a, b) => b.lastVisit - a.lastVisit);
  if (data.history.length > HISTORY_CAP) data.history = data.history.slice(0, HISTORY_CAP);
  writeStore(data);
  return data.history;
});

ipcMain.handle('store:clear-history', () => {
  const data = readStore();
  data.history = [];
  writeStore(data);
  return [];
});

// Session (restauration au lancement — jamais alimentée par les fenêtres privées)
ipcMain.handle('store:get-session', () => readStore().session);

ipcMain.handle('store:save-session', (e, list) => {
  const data = readStore();
  data.session = list;
  writeStore(data);
  return true;
});

// --- Paramètres ---
ipcMain.handle('settings:get', () => publicSettings(readStore().settings));

// --- Outils de développement : affichés dans un panneau à gauche de la fenêtre ---
ipcMain.handle('devtools:attach', (e, d) => {
  const target = d && webContents.fromId(d.targetId), front = d && webContents.fromId(d.frontId);
  if (!target || !front || target.isDestroyed() || front.isDestroyed()) return false;
  if (target.hostWebContents !== e.sender || front.hostWebContents !== e.sender) return false;
  try {
    if (target.isDevToolsOpened()) target.closeDevTools();
    target.setDevToolsWebContents(front);
    target.openDevTools({ mode: 'detach' });
    if (d.x != null && d.y != null) target.inspectElement(Math.round(d.x), Math.round(d.y));
    return true;
  } catch (err) { return false; }
});
ipcMain.handle('devtools:inspect', (e, d) => {
  const target = d && webContents.fromId(d.id);
  if (!target || target.isDestroyed() || target.hostWebContents !== e.sender) return false;
  target.inspectElement(Math.round(d.x) || 0, Math.round(d.y) || 0);
  return true;
});
ipcMain.handle('devtools:close', (e, id) => {
  const target = webContents.fromId(id);
  if (target && !target.isDestroyed() && target.hostWebContents === e.sender && target.isDevToolsOpened()) target.closeDevTools();
  return true;
});

ipcMain.on('window:fullscreen', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.setFullScreen(!w.isFullScreen()); });
ipcMain.handle('adblock:stats', () => lifetimeBlocked);

// --- Fond d'écran (image ou GIF copié dans le dossier de données de Pure) ---
function clearWallpaperFiles() {
  try { fs.readdirSync(WP_DIR).forEach(f => fs.rmSync(path.join(WP_DIR, f), { force: true })); } catch (err) { /* dossier absent */ }
}
ipcMain.handle('wallpaper:import', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, {
    title: 'Choisir une image ou un GIF', properties: ['openFile'],
    filters: [{ name: 'Images et GIF', extensions: WP_EXTS.map(x => x.slice(1)) }]
  });
  if (r.canceled || !r.filePaths[0]) return { cancelled: true };
  const src = r.filePaths[0], ext = path.extname(src).toLowerCase();
  if (!WP_EXTS.includes(ext)) return { error: "Format non pris en charge (PNG, JPG, GIF, WebP, AVIF ou BMP)." };
  try {
    if (fs.statSync(src).size > 100 * 1024 * 1024) return { error: 'Fichier trop volumineux (100 Mo maximum).' };
    fs.mkdirSync(WP_DIR, { recursive: true });
    clearWallpaperFiles();
    fs.copyFileSync(src, path.join(WP_DIR, 'wallpaper' + ext));
    const data = readStore();
    data.settings.wallpaper = 'wallpaper' + ext;
    data.settings.wallpaperRev = Date.now();
    writeStore(data);
    return { settings: publicSettings(data.settings) };
  } catch (err) {
    return { error: "Impossible d'importer ce fichier : " + (err.message || err) };
  }
});
ipcMain.handle('wallpaper:clear', () => {
  clearWallpaperFiles();
  const data = readStore();
  data.settings.wallpaper = null;
  writeStore(data);
  return publicSettings(data.settings);
});

ipcMain.handle('settings:save', (e, rawPatch) => {
  const patch = sanitizePatch(rawPatch);
  const data = readStore();
  data.settings = { ...data.settings, ...(patch || {}) };
  writeStore(data);
  if (patch && 'theme' in patch) applyNativeTheme(data.settings.theme);
  if (patch && 'animFps' in patch) {
    BrowserWindow.getAllWindows().forEach(w => { if (!w.isDestroyed()) w.webContents.send('settings:anim', data.settings.animFps); });
  }
  if (patch && 'launchAtStartup' in patch && process.platform === 'win32' && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: !!patch.launchAtStartup, path: process.execPath, args: [] });
  }
  return publicSettings(data.settings);
});

// --- Extensions ---
function resolveExtIconPath(ext) {
  const manifest = ext.manifest || {};
  let rel = null;
  const icons = manifest.icons;
  if (icons && typeof icons === 'object') {
    const sizes = Object.keys(icons).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
    const pick = sizes.find(s => s >= 32) || sizes[sizes.length - 1];
    if (pick) rel = icons[pick];
  }
  if (!rel) {
    const action = manifest.action || manifest.browser_action;
    const di = action && action.default_icon;
    if (typeof di === 'string') rel = di;
    else if (di && typeof di === 'object') {
      const sizes = Object.keys(di).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
      const pick = sizes.find(s => s >= 32) || sizes[sizes.length - 1];
      if (pick) rel = di[pick];
    }
  }
  if (!rel) return null;
  return path.join(ext.path, rel.replace(/^\//, ''));
}

function listExtensions() {
  if (!pureSession) return [];
  const saved = readStore().extensions;
  return extApi().getAllExtensions().map(e => {
    const entry = saved.find(x => x.id === e.id);
    const manifest = e.manifest || {};
    const action = manifest.action || manifest.browser_action || {};
    return {
      id: e.id, name: e.name, version: e.version,
      storeId: entry ? entry.storeId || null : null,
      hasPopup: !!action.default_popup,
      homepageUrl: manifest.homepage_url || null
    };
  });
}

ipcMain.handle('extensions:list', () => listExtensions());

ipcMain.handle('extensions:icon', (e, id) => {
  if (!pureSession) return null;
  const ext = extApi().getAllExtensions().find(x => x.id === id);
  if (!ext) return null;
  const p = resolveExtIconPath(ext);
  if (!p || !fs.existsSync(p)) return null;
  try {
    const buf = fs.readFileSync(p);
    const mime = /\.svg$/i.test(p) ? 'image/svg+xml' : /\.jpe?g$/i.test(p) ? 'image/jpeg' : 'image/png';
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  } catch (e2) {
    return null;
  }
});

ipcMain.handle('extensions:open-popup', (e, opts) => {
  if (!pureSession) return { opened: false };
  const win = BrowserWindow.fromWebContents(e.sender);
  const ext = extApi().getAllExtensions().find(x => x.id === (opts && opts.id));
  if (!ext) return { opened: false };
  const manifest = ext.manifest || {};
  const action = manifest.action || manifest.browser_action || {};
  if (!action.default_popup) {
    return { opened: false, fallbackUrl: manifest.homepage_url || null };
  }
  const popupUrl = 'chrome-extension://' + ext.id + '/' + String(action.default_popup).replace(/^\//, '');
  const base = win ? win.getBounds() : { x: 0, y: 0 };
  const popup = new BrowserWindow({
    width: 340, height: 460,
    x: Math.round(base.x + (opts.relX || 0)), y: Math.round(base.y + (opts.relY || 0)),
    frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true,
    parent: win || undefined, backgroundColor: '#ffffff',
    webPreferences: { partition: 'persist:pure' }
  });
  popup.setMenu(null);
  popup.loadURL(popupUrl);
  popup.once('ready-to-show', () => popup.show());
  popup.on('blur', () => { if (!popup.isDestroyed()) popup.close(); });
  return { opened: true };
});

ipcMain.handle('extensions:install-store', async (e, storeId) => {
  if (!/^[a-p]{32}$/.test(storeId || '')) {
    return { success: false, error: "Identifiant d'extension invalide.", extensions: listExtensions() };
  }
  const data = readStore();
  if (data.extensions.some(x => x.storeId === storeId)) {
    return { success: false, error: 'Cette extension est déjà installée.', extensions: listExtensions() };
  }
  try {
    const url = 'https://clients2.google.com/service/update2/crx?response=redirect' +
      '&prodversion=' + encodeURIComponent(process.versions.chrome) +
      '&acceptformat=crx2,crx3' +
      '&x=' + encodeURIComponent('id=' + storeId + '&uc');
    const res = await net.fetch(url);
    if (!res.ok) throw new Error('Le Chrome Web Store a répondu ' + res.status + '.');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 16) throw new Error("Le Chrome Web Store n'a pas fourni cette extension (retirée ou non disponible).");
    const zip = crxToZip(buf);
    const dir = path.join(EXT_DIR, storeId);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    new AdmZip(Buffer.from(zip)).extractAllTo(dir, true);
    const ext = await extApi().loadExtension(dir, { allowFileAccess: true });
    data.extensions.push({ path: dir, id: ext.id, name: ext.name, version: ext.version, storeId });
    writeStore(data);
    return { success: true, extensions: listExtensions() };
  } catch (err) {
    return { success: false, error: err.message || String(err), extensions: listExtensions() };
  }
});

ipcMain.handle('extensions:add', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: "Choisir le dossier de l'extension (contenant manifest.json)"
  });
  if (result.canceled || !result.filePaths[0]) return { success: false, cancelled: true, extensions: listExtensions() };
  const folder = result.filePaths[0];
  try {
    const ext = await extApi().loadExtension(folder, { allowFileAccess: true });
    const data = readStore();
    if (!data.extensions.some(x => x.path === folder)) {
      data.extensions.push({ path: folder, id: ext.id, name: ext.name, version: ext.version });
    }
    writeStore(data);
    return { success: true, extensions: listExtensions() };
  } catch (err) {
    return { success: false, error: err.message || String(err), extensions: listExtensions() };
  }
});

ipcMain.handle('extensions:remove', (e, id) => {
  try { extApi().removeExtension(id); } catch (err) { /* déjà retirée */ }
  const data = readStore();
  const entry = data.extensions.find(x => x.id === id);
  if (entry && entry.storeId && entry.path.startsWith(EXT_DIR)) {
    try { fs.rmSync(entry.path, { recursive: true, force: true }); } catch (err) { /* ignoré */ }
  }
  data.extensions = data.extensions.filter(x => x.id !== id);
  writeStore(data);
  return listExtensions();
});

// --- Téléchargements ---
const downloadsNormal = [];
const downloadsPrivate = [];

function broadcastDownloads(list, windows) {
  windows().forEach(w => { if (!w.isDestroyed()) w.webContents.send('downloads:update', list); });
}

function attachDownloads(sess, list, persist, windows) {
  sess.on('will-download', (event, item) => {
    let filename = item.getFilename();
    const dlDir = app.getPath('downloads');
    let savePath = path.join(dlDir, filename);
    let n = 1;
    while (fs.existsSync(savePath)) {
      const ext = path.extname(filename);
      const base = path.basename(filename, ext);
      savePath = path.join(dlDir, base + ' (' + n + ')' + ext);
      n++;
    }
    item.setSavePath(savePath);
    const rec = {
      id: crypto.randomUUID(), filename: path.basename(savePath), path: savePath,
      url: item.getURL(), state: 'progressing', receivedBytes: 0, totalBytes: item.getTotalBytes(), startTime: Date.now()
    };
    list.unshift(rec);
    if (list.length > DOWNLOAD_CAP) list.length = DOWNLOAD_CAP;
    broadcastDownloads(list, windows);

    item.on('updated', (e2, state) => {
      rec.state = state;
      rec.receivedBytes = item.getReceivedBytes();
      rec.totalBytes = item.getTotalBytes();
      broadcastDownloads(list, windows);
    });
    item.once('done', (e2, state) => {
      rec.state = state;
      rec.receivedBytes = item.getReceivedBytes();
      broadcastDownloads(list, windows);
      if (persist) { const data = readStore(); data.downloads = list.slice(0, DOWNLOAD_CAP); writeStore(data); }
    });
  });
}

function downloadsListFor(win) { return privateWindows.has(win) ? downloadsPrivate : downloadsNormal; }

ipcMain.handle('downloads:list', (e) => downloadsListFor(BrowserWindow.fromWebContents(e.sender)));

ipcMain.handle('downloads:open-file', (e, id) => {
  const list = downloadsListFor(BrowserWindow.fromWebContents(e.sender));
  const rec = list.find(d => d.id === id);
  if (rec) shell.openPath(rec.path);
  return true;
});

ipcMain.handle('downloads:show-in-folder', (e, id) => {
  const list = downloadsListFor(BrowserWindow.fromWebContents(e.sender));
  const rec = list.find(d => d.id === id);
  if (rec) shell.showItemInFolder(rec.path);
  return true;
});

ipcMain.handle('downloads:remove', (e, id) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const list = downloadsListFor(win);
  const idx = list.findIndex(d => d.id === id);
  if (idx !== -1) list.splice(idx, 1);
  if (list === downloadsNormal) { const data = readStore(); data.downloads = downloadsNormal.slice(0, DOWNLOAD_CAP); writeStore(data); }
  return list;
});

ipcMain.handle('downloads:clear', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const list = downloadsListFor(win);
  list.length = 0;
  if (list === downloadsNormal) { const data = readStore(); data.downloads = []; writeStore(data); }
  return list;
});

// --- Compte Pure & coffre de mots de passe (chiffré, local) ---
const vaultSvc = createVaultService({
  filePath: path.join(app.getPath('userData'), 'pure-vault.json'),
  copyToClipboard: (t) => clipboard.writeText(t),
  readClipboard: () => clipboard.readText(),
  onAutoLock: () => {
    [...normalWindows, ...privateWindows].forEach(w => { if (w && !w.isDestroyed()) w.webContents.send('vault:locked'); });
  }
});

ipcMain.handle('vault:status', () => vaultSvc.status());
ipcMain.handle('vault:create', (e, d) => vaultSvc.create(d && d.name, d && d.password));
ipcMain.handle('vault:unlock', (e, d) => vaultSvc.unlock(d && d.password));
ipcMain.handle('vault:lock', () => { vaultSvc.lock(); return vaultSvc.status(); });
ipcMain.handle('vault:list', () => vaultSvc.list());
ipcMain.handle('vault:list-for-origin', (e, origin) => vaultSvc.listForOrigin(origin));
ipcMain.handle('vault:check-save', (e, d) => vaultSvc.checkSave(d || {}));
ipcMain.handle('vault:save', (e, d) => vaultSvc.save(d || {}));
ipcMain.handle('vault:get-creds', (e, id) => vaultSvc.getCreds(id));
ipcMain.handle('vault:copy', (e, id) => vaultSvc.copy(id));
ipcMain.handle('vault:delete', (e, id) => vaultSvc.remove(id));
ipcMain.handle('vault:never-save', (e, origin) => vaultSvc.neverSave(origin));
ipcMain.handle('vault:generate', () => vaultSvc.generate());
ipcMain.handle('vault:delete-account', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Annuler', 'Supprimer définitivement'],
    defaultId: 0,
    cancelId: 0,
    message: 'Supprimer le compte Pure et tous les mots de passe enregistrés ?',
    detail: 'Cette action est irréversible.'
  });
  if (r.response === 1) vaultSvc.deleteAccount();
  return vaultSvc.status();
});

// --- Contrôles de fenêtre (s'appliquent à la fenêtre qui envoie la demande) ---
ipcMain.on('window:minimize', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.minimize(); });
ipcMain.on('window:maximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (w.isMaximized()) w.unmaximize(); else w.maximize();
});
ipcMain.on('window:close', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close(); });

// --- Fenêtre de navigation privée ---
function ensurePrivateSession() {
  if (privateSession) return privateSession;
  privateSession = session.fromPartition('incognito-pure'); // non persistante : tout disparaît à la fermeture
  setupAdBlocker(privateSession);
  if (adblockSvc) adblockSvc.enableSession(privateSession);
  attachDownloads(privateSession, downloadsPrivate, false, () => [...privateWindows]);
  return privateSession;
}

function createPrivateWindow(openTab, bounds) {
  ensurePrivateSession();
  const win = new BrowserWindow({
    width: 1100, height: 760, ...(bounds || {}), minWidth: 760, minHeight: 480,
    title: 'Pure — navigation privée',
    frame: false,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    backgroundColor: '#141414',
    webPreferences: { nodeIntegration: true, contextIsolation: false, webviewTag: true }
  });
  watchShortcuts(win.webContents, () => win.webContents);
  win.loadFile(path.join(__dirname, 'chrome.html'), { query: { private: '1', ...tabQuery(openTab) } });
  privateWindows.add(win);
  win.on('closed', () => privateWindows.delete(win));
  return win;
}

ipcMain.handle('window:open-private', () => { createPrivateWindow(); return true; });

// --- Onglet détaché : il s'ouvre dans une nouvelle fenêtre (même mode, normal ou privé) ---
const DETACH_URL_RE = /^(https?|file|chrome-extension):/i;
function tabQuery(t) {
  if (!t || typeof t.url !== 'string' || !DETACH_URL_RE.test(t.url)) return {};
  const q = { open: t.url };
  if (typeof t.title === 'string') q.otitle = t.title.slice(0, 200);
  if (typeof t.favicon === 'string' && /^(https?:|data:image\/)/i.test(t.favicon) && t.favicon.length < 2000) q.ofav = t.favicon;
  return q;
}

function createDetachedWindow(src, tab) {
  const isPriv = privateWindows.has(src);
  if (isPriv) { createPrivateWindowAt(src, tab); return; }
  const { x, y, width, height } = detachedBounds(src);
  const win = new BrowserWindow({
    x, y, width, height, minWidth: 760, minHeight: 480,
    title: 'Pure', frame: false, show: false,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1A1517' : '#F3D6E4',
    webPreferences: { nodeIntegration: true, contextIsolation: false, webviewTag: true }
  });
  watchShortcuts(win.webContents, () => win.webContents);
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
  win.loadFile(path.join(__dirname, 'chrome.html'), { query: tabQuery(tab) });
  normalWindows.add(win);
  win.on('closed', () => normalWindows.delete(win));
}

function createPrivateWindowAt(src, tab) {
  createPrivateWindow(tab, detachedBounds(src));
}

// La nouvelle fenêtre apparaît sous le curseur, à la taille de la fenêtre d'origine, dans les limites de l'écran
function detachedBounds(src) {
  if (!src) return { width: 1240, height: 820 };   // pas de fenêtre d'origine : Electron centre la nouvelle fenêtre
  const cur = screen.getCursorScreenPoint();
  const sb = src.getBounds();
  const width = Math.max(760, Math.min(sb.width, 1240)), height = Math.max(480, Math.min(sb.height, 820));
  const wa = screen.getDisplayNearestPoint(cur).workArea;
  const x = Math.round(Math.min(Math.max(cur.x - 90, wa.x), wa.x + Math.max(0, wa.width - width)));
  const y = Math.round(Math.min(Math.max(cur.y - 20, wa.y), wa.y + Math.max(0, wa.height - height)));
  return { x, y, width, height };
}

ipcMain.handle('window:detach-tab', (e, tab) => {
  const src = BrowserWindow.fromWebContents(e.sender);
  if (!src || !(normalWindows.has(src) || privateWindows.has(src))) return false;
  if (!tab || typeof tab.url !== 'string' || !DETACH_URL_RE.test(tab.url)) return false;
  createDetachedWindow(src, tab);
  return true;
});

// --- Fenêtre principale + écran de lancement ---
function createSplash() {
  const splash = new BrowserWindow({
    width: 260, height: 300, frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, movable: false, backgroundColor: '#00000000',
    webPreferences: {}
  });
  splash.loadFile(path.join(__dirname, 'splash.html'));
  splash.center();
  return splash;
}

function createWindow() {
  const splash = createSplash();
  const startedAt = Date.now();

  mainWindow = new BrowserWindow({
    width: 1240, height: 820, minWidth: 760, minHeight: 480,
    title: 'Pure', frame: false, show: false,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1A1517' : '#F3D6E4',
    webPreferences: { nodeIntegration: true, contextIsolation: false, webviewTag: true }
  });

  mainWindow.once('ready-to-show', () => {
    const elapsed = Date.now() - startedAt;
    const wait = Math.max(0, 1150 - elapsed);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
      if (!splash.isDestroyed()) splash.close();
    }, wait);
  });

  watchShortcuts(mainWindow.webContents, () => mainWindow && mainWindow.webContents);
  mainWindow.loadFile(path.join(__dirname, 'chrome.html'));
  normalWindows.add(mainWindow);
  const thisMain = mainWindow;
  thisMain.on('closed', () => normalWindows.delete(thisMain));

  pureSession = session.fromPartition('persist:pure');
  setupAdBlocker(pureSession);
  attachDownloads(pureSession, downloadsNormal, true, () => [...normalWindows].filter(w => !w.isDestroyed()));

  const store = readStore();
  lifetimeBlocked = store.blockedTotal || 0;
  downloadsNormal.push(...store.downloads.map(d => (d.state === 'progressing' ? { ...d, state: 'interrupted' } : d)));

  // Recharge les extensions précédemment ajoutées (best-effort, une par une)
  (async () => {
    const data = readStore();
    for (const ext of data.extensions) {
      try {
        const loaded = await extApi().loadExtension(ext.path, { allowFileAccess: true });
        ext.id = loaded.id;
        ext.name = loaded.name;
        ext.version = loaded.version;
      } catch (err) {
        // dossier déplacé/supprimé : ignoré au démarrage
      }
    }
    const fresh = readStore();
    fresh.extensions = fresh.extensions.map(x => data.extensions.find(u => u.path === x.path) || x);
    writeStore(fresh);
  })();
}

app.on('second-instance', (event, argv, workingDirectory) => {
  deliverUrls(launchTargets(argv, workingDirectory));   // fichier .html ou lien ouvert pendant que Pure tourne déjà
  const wins = [...normalWindows, ...privateWindows].filter(w => !w.isDestroyed());
  const win = wins.includes(mainWindow) ? mainWindow : wins[0];
  if (!win) { if (app.isReady()) createWindow(); return; }
  if (!win.isVisible() && win === mainWindow) return;   // écran de lancement encore en cours : la fenêtre va s'afficher d'elle-même
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(async () => {
  if (HEADLESS) {
    try { if (HEADLESS_REGISTER) await registerWithWindows(); else await unregisterFromWindows(); } catch (err) { /* best-effort */ }
    app.exit(0);
    return;
  }
  if (!gotInstanceLock) return;
  applyNativeTheme(readStore().settings.theme);
  vaultSvc.load();
  createWindow();
  adblockSvc = createAdblockService(() => [pureSession, privateSession].filter(Boolean), countBlocked);
  adblockSvc.start();

  if (process.platform === 'win32' && app.isPackaged) {
    const st = readStore().settings;
    app.setLoginItemSettings({ openAtLogin: st.launchAtStartup !== false, path: process.execPath, args: [] });
  }
  ensureWindowsRegistration().catch(() => { /* best-effort */ });
  // Contrôle des mises à jour : quelques secondes après le lancement, puis toutes les 4 h
  setTimeout(autoCheckForUpdate, 8000);
  setInterval(autoCheckForUpdate, UPDATE_EVERY_MS);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => { if (lifetimeDirty > 0) persistLifetimeBlocked(); });
