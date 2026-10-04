// Injecté dans chaque page web (main frame). Il ne s'expose PAS à la page :
// il parle uniquement à l'interface de Pure via sendToHost.
const { ipcRenderer, webFrame } = require('electron');

// Un clic dans la page n'atteint pas l'interface de Pure : on la prévient pour qu'elle ferme ses menus ouverts
window.addEventListener('mousedown', () => { try { ipcRenderer.sendToHost('ui:hide-menus'); } catch (e) { /* page fermée */ } }, true);

if (/^https?:$/.test(location.protocol)) {
  let announced = null;
  let lastSent = { key: '', time: 0 };

  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const passwordFields = () => [...document.querySelectorAll('input[type="password"]')].filter(isVisible);

  // Champ identifiant = dernier champ texte/e-mail visible qui précède le mot de passe
  const usernameFor = (pw) => {
    const scope = pw.form || document;
    let best = null;
    for (const c of scope.querySelectorAll('input')) {
      const t = (c.type || 'text').toLowerCase();
      if (!['text', 'email', 'tel'].includes(t) || !isVisible(c)) continue;
      if (c.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) best = c;
    }
    return best;
  };

  const announce = (force) => {
    const has = passwordFields().length > 0;
    if (force || has !== announced) {
      announced = has;
      ipcRenderer.sendToHost('pw:field-state', { origin: location.origin, has });
    }
  };

  const capture = () => {
    const filled = passwordFields().filter(p => p.value);
    if (!filled.length) return;
    // Formulaire de changement de mot de passe (ancien / nouveau / confirmation) : on prend le nouveau
    const pw = filled.length >= 3 ? filled[1] : filled[0];
    const user = usernameFor(pw);
    const payload = { origin: location.origin, username: user ? user.value.trim() : '', password: pw.value };
    const k = payload.username + '\u0000' + payload.password;
    if (k === lastSent.key && Date.now() - lastSent.time < 2000) return;
    lastSent = { key: k, time: Date.now() };
    ipcRenderer.sendToHost('pw:submit', payload);
  };

  document.addEventListener('submit', capture, true);
  document.addEventListener('click', (e) => {
    if (e.target && e.target.closest && e.target.closest('button, input[type="submit"], input[type="button"], [role="button"]')) capture();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target && e.target.type === 'password') capture();
  }, true);

  const setValue = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  ipcRenderer.on('pw:fill', (event, creds) => {
    if (!creds || typeof creds.password !== 'string') return;
    const pw = passwordFields()[0];
    if (!pw) return;
    const user = usernameFor(pw);
    if (user && creds.username) setValue(user, creds.username);
    setValue(pw, creds.password);
  });

  let timer = null;
  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => announce(true), 700);
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => announce(false), 500);
    }).observe(document.documentElement, { childList: true, subtree: true });
  });

  // --- YouTube : la vidéo et sa pub viennent du même serveur (googlevideo.com),
  // donc impossible de bloquer la requête réseau sans casser la vidéo. On agit
  // à la place sur le lecteur lui-même : clic auto sur "passer", et si la pub
  // n'est pas "passable", on la coupe (son + avance à la fin) le temps qu'elle finisse.
  // Les bannières/pubs statiques (hors lecteur) sont masquées par CSS, sans risque.
  if (/(^|\.)youtube\.com$/.test(location.hostname)) {
    // Le préchargement s'exécute avant que la page existe (document.head est encore null) :
    // on passe par webFrame.insertCSS, qui s'applique dès la création du document.
    try {
      webFrame.insertCSS([
        '.ytp-ad-overlay-container, .ytp-ad-image-overlay,',
        '#masthead-ad, ytd-display-ad-renderer, ytd-promoted-sparkles-web-renderer,',
        'ytd-promoted-video-renderer, ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer,',
        '.ytd-companion-slot-renderer, #player-ads { display: none !important; }'
      ].join(' '));
    } catch (e) { /* page fermée */ }

    let preAdState = null; // { muted, volume } du lecteur avant l'entrée en pub

    const isAdShowing = () => {
      const p = document.querySelector('.html5-video-player, #movie_player');
      return !!(p && p.classList.contains('ad-showing'));
    };
    const clickSkipIfPresent = () => {
      const btn = document.querySelector(
        '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-container button'
      );
      if (btn && isVisible(btn)) { btn.click(); return true; }
      return false;
    };
    const handleAdTick = () => {
      const showing = isAdShowing();
      const video = document.querySelector('video.html5-main-video, video');
      if (showing) {
        if (!preAdState && video) preAdState = { muted: video.muted, volume: video.volume };
        if (clickSkipIfPresent()) return;
        if (video) {
          video.muted = true;
          if (video.duration && isFinite(video.duration) && video.currentTime < video.duration - 0.25) {
            video.currentTime = video.duration; // force la fin de la pub non "passable"
          }
        }
      } else if (preAdState && video) {
        video.muted = preAdState.muted;
        video.volume = preAdState.volume;
        preAdState = null;
      }
    };
    setInterval(handleAdTick, 300);

    // --- Filet de sécurité : lecteur figé (message anti-bloqueur, chargement sans fin...) ---
    // 1) on retire le message qui bloque et on relance la lecture ;
    // 2) si la vidéo ne repart toujours pas, on demande un rechargement avec des règles plus légères.
    let wdUrl = location.href, wdLastT = -1, wdLastMove = Date.now(), wdNudged = false, wdReported = false;
    const wdReset = () => { wdUrl = location.href; wdLastT = -1; wdLastMove = Date.now(); wdNudged = false; wdReported = false; };
    const removeBlockingOverlay = () => {
      document.querySelectorAll('ytd-enforcement-message-view-model, tp-yt-iron-overlay-backdrop.opened')
        .forEach(el => el.remove());
      if (document.body && document.body.style.overflow === 'hidden') document.body.style.overflow = '';
    };
    setInterval(() => {
      if (location.href !== wdUrl) wdReset();
      if (!location.pathname.startsWith('/watch')) return;
      const video = document.querySelector('video.html5-main-video, video');
      if (!video) return;
      if (isAdShowing()) { wdLastMove = Date.now(); return; } // les pubs sont gérées plus haut
      removeBlockingOverlay();
      const t = video.currentTime;
      if (Math.abs(t - wdLastT) > 0.2) { wdLastT = t; wdLastMove = Date.now(); return; }  // la lecture avance
      if (video.paused && video.readyState >= 3) { wdLastMove = Date.now(); return; }       // simple pause
      const stuckFor = Date.now() - wdLastMove;
      if (stuckFor > 8000 && !wdNudged) { wdNudged = true; video.play().catch(() => {}); }
      if (stuckFor > 14000 && !wdReported) { wdReported = true; ipcRenderer.send('pure:yt-stuck'); }
    }, 1000);
  }
}

// --- Vidéo détachée : envoie les images de la vidéo vers la fenêtre flottante (pip.js / pip.html) ---
// Le son reste dans l'onglet ; seules les images partent, par un canal direct (MessagePort).
(() => {
  let session = null;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function pickVideo() {
    const area = (el) => { const r = el.getBoundingClientRect(); return Math.max(0, r.width) * Math.max(0, r.height); };
    const list = [...document.querySelectorAll('video')].filter(v => v.videoWidth > 0 && v.videoHeight > 0 && v.readyState >= 2);
    if (!list.length) return null;
    const score = (v) => (!v.paused && !v.ended ? 1e12 : 0) + area(v);
    list.sort((a, b) => score(b) - score(a));
    return list[0];
  }

  function stop() {
    const s = session;
    if (!s) return;
    session = null;
    s.closed = true;
    clearInterval(s.timer);
    s.listeners.forEach(([t, ev, fn]) => t.removeEventListener(ev, fn));
    try { s.port.close(); } catch (e) { /* déjà fermé */ }
  }

  async function start(port, opts) {
    stop();
    const video = pickVideo();
    if (!port) return;
    if (!video) { port.postMessage({ type: 'error', reason: 'no-video' }); port.close(); return; }
    if (video.mediaKeys) { port.postMessage({ type: 'error', reason: 'protected' }); port.close(); return; }   // contenu protégé (DRM)

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    const s = { video, port, canvas, ctx, timer: null, busy: false, lastTime: -1, force: true, closed: false, listeners: [],
                targetW: clamp(Math.round(((opts && opts.width) || 480) * 2), 480, 1280) };

    const grab = async () => {
      const vw = video.videoWidth, vh = video.videoHeight;
      const scale = Math.min(1, s.targetW / vw);
      const w = Math.max(2, Math.round(vw * scale)), h = Math.max(2, Math.round(vh * scale));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      ctx.drawImage(video, 0, 0, w, h);
      const blob = await new Promise((res, rej) => {
        try { canvas.toBlob(b => (b ? res(b) : rej(new Error('encodage'))), 'image/jpeg', 0.72); } catch (e) { rej(e); }
      });
      return { buf: await blob.arrayBuffer(), w, h };
    };

    // Première image : si la page l'interdit (vidéo d'un autre site, protégée...), on le dit tout de suite
    let first;
    try { first = await grab(); } catch (e) { port.postMessage({ type: 'error', reason: 'protected' }); port.close(); return; }
    if (session) stop();
    session = s;
    s.lastTime = video.currentTime;
    s.force = false;
    port.postMessage({ type: 'hello', w: first.w, h: first.h, paused: video.paused });
    port.postMessage({ type: 'frame', buf: first.buf, w: first.w, h: first.h }, [first.buf]);

    const on = (t, ev, fn) => { t.addEventListener(ev, fn); s.listeners.push([t, ev, fn]); };
    const sendState = () => { if (!s.closed) port.postMessage({ type: 'state', paused: video.paused || video.ended }); };
    on(video, 'play', sendState);
    on(video, 'pause', sendState);
    on(video, 'ended', sendState);
    on(video, 'seeked', () => { s.force = true; });
    on(video, 'loadedmetadata', () => { s.force = true; });
    on(video, 'resize', () => { s.force = true; });
    on(window, 'pagehide', () => { try { port.postMessage({ type: 'ended' }); } catch (e) { /* ignoré */ } stop(); });

    port.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === 'toggle') {
        if (video.paused || video.ended) video.play().catch(() => {}); else video.pause();
      } else if (m.type === 'size') {
        s.targetW = clamp(Number(m.width) || 960, 480, 1280);
        s.force = true;
      } else if (m.type === 'stop') {
        stop();
      }
    };
    port.start();

    // ~30 images par seconde ; on n'envoie que si l'image a changé (rien à envoyer quand la vidéo est en pause)
    s.timer = setInterval(async () => {
      if (s.busy || s.closed || video.readyState < 2) return;
      if (!s.force && video.currentTime === s.lastTime) return;
      s.busy = true;
      try {
        const f = await grab();
        s.lastTime = video.currentTime;
        s.force = false;
        if (!s.closed) port.postMessage({ type: 'frame', buf: f.buf, w: f.w, h: f.h }, [f.buf]);
      } catch (e) {
        if (!s.closed) port.postMessage({ type: 'error', reason: 'protected' });
        stop();
      }
      s.busy = false;
    }, 33);
  }

  ipcRenderer.on('pip:start', (event, opts) => { start(event.ports && event.ports[0], opts); });
  ipcRenderer.on('pip:stop', () => stop());
})();
