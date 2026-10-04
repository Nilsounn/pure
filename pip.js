// Vidéo détachée : une petite fenêtre flottante, toujours au-dessus, qui affiche la vidéo d'un onglet.
//  - le clic passe à travers (sauf sur la barre du haut et la poignée du coin) ;
//  - la vidéo devient transparente quand la souris passe dessus ;
//  - la barre du haut déplace la fenêtre, la poignée du coin la redimensionne.
// Les images viennent de la page (webview-preload.js) par un canal MessagePort direct : le son reste dans l'onglet d'origine.
const path = require('path');
const fs = require('fs');

const BAR_H = 34;        // hauteur de la zone « déplacer » (doit rester identique dans pip.html)
const GRIP = 28;         // côté de la poignée de redimensionnement (idem)
const MIN_W = 240;
const DEFAULT_W = 480;
const MARGIN = 24;

// --- Calculs purs (testés séparément) ---
function aspectHeight(width, aspect) { return Math.max(60, Math.round(width / (aspect || 16 / 9))); }

function clampMove(x, y, w, h, area) {
  const minX = area.x - w + 80, maxX = area.x + area.width - 80;          // il en reste toujours 80 px visibles
  const minY = area.y, maxY = area.y + area.height - BAR_H;               // la barre reste atteignable
  return { x: Math.round(Math.min(maxX, Math.max(minX, x))), y: Math.round(Math.min(maxY, Math.max(minY, y))) };
}

function resizeBounds(start, dx, aspect, area) {
  const maxW = Math.max(MIN_W, area.width);
  const width = Math.round(Math.min(maxW, Math.max(MIN_W, start.width + dx)));
  return { x: start.x, y: start.y, width, height: aspectHeight(width, aspect) };
}

function defaultBounds(area, aspect) {
  const width = Math.min(DEFAULT_W, area.width - 2 * MARGIN);
  const height = aspectHeight(width, aspect);
  return { x: area.x + area.width - width - MARGIN, y: area.y + area.height - height - MARGIN, width, height };
}

function createPip(deps) {
  const { app, BrowserWindow, MessageChannelMain, ipcMain, screen, webContents, userDataDir } = deps;
  const BOUNDS_FILE = path.join(userDataDir, 'pip-bounds.json');

  let win = null;            // fenêtre flottante
  let guest = null;          // webContents de l'onglet source
  let host = null;           // webContents de l'interface qui a demandé l'ouverture
  let aspect = 16 / 9;
  let pollTimer = null, dragTimer = null;
  let interactive = false, lastHover = '';
  let drag = null;
  let pending = null;        // { resolve, timer } pendant l'ouverture
  let guestListeners = [];

  const loadSaved = () => { try { return JSON.parse(fs.readFileSync(BOUNDS_FILE, 'utf8')); } catch (e) { return null; } };
  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    try { fs.writeFileSync(BOUNDS_FILE, JSON.stringify({ x: b.x, y: b.y, width: b.width }), 'utf8'); } catch (e) { /* best-effort */ }
  };
  const notifyHost = (open, extra) => {
    if (host && !host.isDestroyed()) host.send('pip:state', { open, ...(extra || {}) });
  };
  const areaAt = (pt) => screen.getDisplayNearestPoint(pt).workArea;

  function startBounds() {
    const saved = loadSaved();
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && Number.isFinite(saved.width)) {
      const width = Math.max(MIN_W, Math.round(saved.width));
      const b = { x: Math.round(saved.x), y: Math.round(saved.y), width, height: aspectHeight(width, aspect) };
      const area = areaAt({ x: b.x + 40, y: b.y + 20 });
      const m = clampMove(b.x, b.y, b.width, b.height, area);
      // L'écran d'avant a pu disparaître : on revient au coin si la position n'est plus visible
      const visible = screen.getAllDisplays().some(d => {
        const w = d.workArea;
        return b.x + 80 <= w.x + w.width && b.x + b.width - 80 >= w.x && b.y + 10 <= w.y + w.height && b.y >= w.y - 4;
      });
      if (visible) return { ...b, x: m.x, y: m.y };
    }
    return defaultBounds(screen.getPrimaryDisplay().workArea, aspect);
  }

  function setBoundsSafe(b) {
    if (!win || win.isDestroyed()) return;
    // Toujours les 4 valeurs : sous Windows avec mise à l'échelle, un setPosition seul fait « dériver » la taille
    win.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
  }

  // --- Souris : on interroge la position du curseur (les événements ne passent pas quand la fenêtre est « transparente aux clics ») ---
  function pollCursor() {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const c = screen.getCursorScreenPoint();
    const inside = c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
    const rx = c.x - b.x, ry = c.y - b.y;
    const overBar = inside && ry < BAR_H;
    const overGrip = inside && rx >= b.width - GRIP && ry >= b.height - GRIP;
    const wantInteractive = !!drag || overBar || overGrip;
    if (wantInteractive !== interactive) {
      interactive = wantInteractive;
      win.setIgnoreMouseEvents(!interactive);
    }
    const key = (inside || drag ? 'in' : 'out') + (overBar ? 'B' : '') + (overGrip ? 'G' : '');
    if (key !== lastHover) {
      lastHover = key;
      win.webContents.send('pip:hover', { inside: inside || !!drag, overBar, overGrip });
    }
  }

  function startDrag(mode) {
    if (!win || win.isDestroyed()) return;
    const start = win.getBounds();
    const sc = screen.getCursorScreenPoint();
    drag = { mode, start, sc };
    clearInterval(dragTimer);
    dragTimer = setInterval(() => {
      if (!win || win.isDestroyed() || !drag) return;
      const c = screen.getCursorScreenPoint();
      const area = areaAt(c);
      if (drag.mode === 'move') {
        const m = clampMove(drag.start.x + (c.x - drag.sc.x), drag.start.y + (c.y - drag.sc.y), drag.start.width, drag.start.height, area);
        setBoundsSafe({ x: m.x, y: m.y, width: drag.start.width, height: drag.start.height });
      } else {
        const r = resizeBounds(drag.start, c.x - drag.sc.x, aspect, area);
        const m = clampMove(r.x, r.y, r.width, r.height, area);   // rétrécir près d'un bord ne doit pas faire sortir la fenêtre de l'écran
        setBoundsSafe({ x: m.x, y: m.y, width: r.width, height: r.height });
      }
    }, 8);
  }

  function endDrag() {
    if (!drag) return;
    const wasResize = drag.mode === 'resize';
    drag = null;
    clearInterval(dragTimer);
    dragTimer = null;
    void wasResize;
    saveBounds();
  }

  function close(reason) {
    if (pending) {
      clearTimeout(pending.timer);
      const p = pending; pending = null;
      p.resolve({ ok: false, reason: reason || 'closed' });
    }
    clearInterval(pollTimer); pollTimer = null;
    clearInterval(dragTimer); dragTimer = null;
    drag = null; interactive = false; lastHover = '';
    guestListeners.forEach(([ev, fn]) => { try { guest.removeListener(ev, fn); } catch (e) { /* déjà détruit */ } });
    guestListeners = [];
    if (guest && !guest.isDestroyed()) {
      try { guest.send('pip:stop'); } catch (e) { /* page fermée */ }
      try { guest.setBackgroundThrottling(true); } catch (e) { /* ignoré */ }
    }
    const w = win;
    win = null;
    if (w && !w.isDestroyed()) { saveBoundsOf(w); w.destroy(); }
    notifyHost(false);
    guest = null;
  }

  function saveBoundsOf(w) {
    try { const b = w.getBounds(); fs.writeFileSync(BOUNDS_FILE, JSON.stringify({ x: b.x, y: b.y, width: b.width }), 'utf8'); } catch (e) { /* best-effort */ }
  }

  function createWindow() {
    const b = startBounds();
    const w = new BrowserWindow({
      x: b.x, y: b.y, width: b.width, height: b.height,
      show: false, frame: false, transparent: true, backgroundColor: '#00000000',
      resizable: false, movable: false, hasShadow: false, skipTaskbar: true, focusable: false,
      alwaysOnTop: true, fullscreenable: false, minimizable: false, maximizable: false,
      title: 'Pure — vidéo détachée',
      icon: path.join(__dirname, 'build', 'icon.ico'),
      webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
    });
    w.setMenu(null);
    w.setAlwaysOnTop(true, 'screen-saver');          // au-dessus de tout, y compris les applications en plein écran
    w.setIgnoreMouseEvents(true);                    // le clic passe à travers
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.on('closed', () => { if (win === w) { win = null; close('closed'); } });
    return w;
  }

  async function open(sender, guestId) {
    const g = webContents.fromId(guestId);
    if (!g || g.isDestroyed() || g.getType() !== 'webview' || g.hostWebContents !== sender) return { ok: false, reason: 'invalid' };
    close('replaced');
    guest = g; host = sender; aspect = 16 / 9;

    win = createWindow();
    const w = win;
    await w.loadFile(path.join(__dirname, 'pip.html'));
    if (win !== w) return { ok: false, reason: 'closed' };

    // Le canal direct : une extrémité pour la page, l'autre pour la fenêtre flottante
    const { port1, port2 } = new MessageChannelMain();
    w.webContents.postMessage('pip:port', null, [port2]);
    g.postMessage('pip:start', { width: Math.max(MIN_W, w.getBounds().width) }, [port1]);
    try { g.setBackgroundThrottling(false); } catch (e) { /* ignoré */ }   // l'onglet peut passer en arrière-plan sans que les images s'arrêtent

    // Fermer si l'onglet source change de page ou disparaît
    const onNav = (details) => {
      const isMain = details && (details.isMainFrame !== undefined ? details.isMainFrame : true);
      if (isMain && !(details && details.isSameDocument)) close('navigated');
    };
    const onGone = () => close('gone');
    g.on('did-start-navigation', onNav);
    g.on('destroyed', onGone);
    g.on('render-process-gone', onGone);
    guestListeners = [['did-start-navigation', onNav], ['destroyed', onGone], ['render-process-gone', onGone]];

    return new Promise((resolve) => {
      const timer = setTimeout(() => { if (pending) close('timeout'); }, 5000);
      pending = { resolve, timer };
    });
  }

  // --- IPC ---
  ipcMain.handle('pip:open', (e, guestId) => open(e.sender, guestId));
  ipcMain.handle('pip:close', () => { close('user'); return true; });

  // La fenêtre flottante est prête (première image reçue) ou a échoué
  ipcMain.on('pip:ready', (e, info) => {
    if (!win || win.isDestroyed() || e.sender !== win.webContents || !pending) return;
    const w = Number(info && info.w) || 16, h = Number(info && info.h) || 9;
    aspect = w / h;
    const b = win.getBounds();
    setBoundsSafe({ x: b.x, y: b.y, width: b.width, height: aspectHeight(b.width, aspect) });
    win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
    pollTimer = setInterval(pollCursor, 50);
    clearTimeout(pending.timer);
    const p = pending; pending = null;
    notifyHost(true);
    p.resolve({ ok: true });
  });
  ipcMain.on('pip:error', (e, reason) => {
    if (!win || win.isDestroyed() || e.sender !== win.webContents) return;
    close(String(reason || 'error'));
  });
  ipcMain.on('pip:request-close', (e) => { if (win && !win.isDestroyed() && e.sender === win.webContents) close('user'); });
  ipcMain.on('pip:drag-start', (e, mode) => { if (win && !win.isDestroyed() && e.sender === win.webContents) startDrag(mode === 'resize' ? 'resize' : 'move'); });
  ipcMain.on('pip:drag-end', (e) => { if (win && !win.isDestroyed() && e.sender === win.webContents) endDrag(); });
  // Le format de la vidéo a changé (ex. qualité adaptative) : on ajuste la hauteur
  ipcMain.on('pip:aspect', (e, info) => {
    if (!win || win.isDestroyed() || e.sender !== win.webContents || drag) return;
    const a = Number(info && info.w) / Number(info && info.h);
    if (!isFinite(a) || a <= 0.2 || a > 6 || Math.abs(a - aspect) < 0.01) return;
    aspect = a;
    const b = win.getBounds();
    setBoundsSafe({ x: b.x, y: b.y, width: b.width, height: aspectHeight(b.width, aspect) });
  });

  app.on('before-quit', () => close('quit'));

  return { close, getWindow: () => win, isOpen: () => !!win };
}

module.exports = { createPip, aspectHeight, clampMove, resizeBounds, defaultBounds, BAR_H, GRIP, MIN_W };
