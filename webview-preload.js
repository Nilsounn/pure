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
  let siteExcluded = false;   // site exclu du bloqueur (Réglages > Sites sans bloqueur de pub)
  try { siteExcluded = !!ipcRenderer.sendSync('pure:adblock-excluded'); } catch (e) { siteExcluded = false; }
  if (!siteExcluded && /(^|\.)youtube\.com$/.test(location.hostname)) {
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

    // --- Message « bloqueurs de pub non autorisés » de YouTube ---
    // 1) on retire la fenêtre et on relance la vidéo ;
    // 2) si la vidéo ne repart pas (lecteur verrouillé par YouTube), on la remplace par le lecteur intégré
    //    (youtube-nocookie.com/embed), sans compte ni cookies, qui n'a pas ce verrou ;
    // 3) lecteur figé sans message : même secours après un long silence.
    let wdUrl = location.href, wdLastT = -1, wdLastMove = Date.now(), wdNudged = false, wdReported = false, wdBlockedAt = 0;
    const wdReset = () => { wdUrl = location.href; wdLastT = -1; wdLastMove = Date.now(); wdNudged = false; wdReported = false; wdBlockedAt = 0; };

    const ADBLOCK_TEXT = /ad.?block|bloqueur|publicit|terms of service|conditions d.utilisation/i;
    const enforcementPresent = () => {
      if (document.querySelector('ytd-enforcement-message-view-model')) return true;
      const err = document.querySelector('yt-player-error-message-renderer, #error-screen .ytp-error, .ytp-error');
      return !!(err && isVisible(err) && ADBLOCK_TEXT.test(err.textContent || ''));
    };
    const removeBlockingOverlay = () => {
      document.querySelectorAll('ytd-enforcement-message-view-model').forEach(el => {
        const dlg = el.closest('tp-yt-paper-dialog');
        (dlg || el).remove();
      });
      document.querySelectorAll('tp-yt-iron-overlay-backdrop.opened').forEach(el => el.remove());
      if (document.body && document.body.style.overflow === 'hidden') document.body.style.overflow = '';
      if (document.documentElement.style.overflow === 'hidden') document.documentElement.style.overflow = '';
    };

    const FALLBACK_ID = 'pure-yt-fallback';
    const hasFallback = () => !!document.getElementById(FALLBACK_ID);
    const removeFallback = () => { const w = document.getElementById(FALLBACK_ID); if (w) w.remove(); };
    const pauseNativeVideo = () => {
      document.querySelectorAll('video').forEach(v => { try { if (!v.paused) v.pause(); } catch (e) { /* ignoré */ } });
    };
    const videoIdFromUrl = () => {
      try {
        const u = new URL(location.href);
        const v = u.searchParams.get('v');
        if (v) return v;
        const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{6,})/);
        return m ? m[1] : null;
      } catch (e) { return null; }
    };
    const activateFallback = () => {
      if (hasFallback()) return;
      const id = videoIdFromUrl();
      if (!id) return;
      const video = document.querySelector('video.html5-main-video, video');
      const t = video && isFinite(video.currentTime) ? video.currentTime : 0;
      removeBlockingOverlay();
      const u = new URL('https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id));
      u.searchParams.set('autoplay', '1');
      u.searchParams.set('rel', '0');
      u.searchParams.set('playsinline', '1');
      if (t > 3) u.searchParams.set('start', String(Math.floor(t)));
      const list = new URLSearchParams(location.search).get('list');
      if (list) u.searchParams.set('list', list);

      const host = document.querySelector('#movie_player, #player-container-inner, #player-container, #player, ytd-player');
      if (!host) { location.replace(u.toString()); return; }   // aucune zone de lecteur trouvée : on ouvre le lecteur intégré seul
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

      const wrap = document.createElement('div');
      wrap.id = FALLBACK_ID;
      wrap.style.cssText = 'position:absolute;inset:0;z-index:2147483000;background:#000;';
      const frame = document.createElement('iframe');
      frame.setAttribute('src', u.toString());
      frame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write');
      frame.setAttribute('allowfullscreen', '');
      frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      frame.setAttribute('frameborder', '0');
      frame.style.cssText = 'width:100%;height:100%;border:0;display:block;';
      const pill = document.createElement('button');
      pill.textContent = 'Lecteur de secours · recharger la page';
      pill.style.cssText = 'position:absolute;top:8px;right:8px;z-index:2;opacity:0;transition:opacity .2s;border:0;border-radius:999px;padding:4px 10px;font:12px sans-serif;color:#fff;background:rgba(0,0,0,.65);cursor:pointer;';
      pill.addEventListener('click', () => location.reload());
      wrap.addEventListener('mouseenter', () => { pill.style.opacity = '0.9'; });
      wrap.addEventListener('mouseleave', () => { pill.style.opacity = '0'; });
      wrap.append(frame, pill);
      host.appendChild(wrap);
      pauseNativeVideo();
    };

    setInterval(() => {
      if (location.href !== wdUrl) { removeFallback(); wdReset(); }
      if (!/^\/(watch|shorts|live)(\/|$)/.test(location.pathname)) return;
      if (hasFallback()) { pauseNativeVideo(); return; }
      const video = document.querySelector('video.html5-main-video, video');
      if (video && isAdShowing()) { wdLastMove = Date.now(); return; }   // les pubs sont gérées plus haut

      const blocked = enforcementPresent();
      if (blocked) {
        if (!wdBlockedAt) wdBlockedAt = Date.now();
        removeBlockingOverlay();
        if (video) video.play().catch(() => {});
      }
      const t = video ? video.currentTime : -1;
      if (video && Math.abs(t - wdLastT) > 0.2) { wdLastT = t; wdLastMove = Date.now(); if (!blocked) wdBlockedAt = 0; return; }   // la lecture avance

      // Message vu il y a plus de 3,5 s et la vidéo ne repart pas : lecteur de secours
      if (wdBlockedAt && Date.now() - wdBlockedAt > 3500) { activateFallback(); return; }
      if (!video) return;
      if (video.paused && video.readyState >= 3 && !wdBlockedAt) { wdLastMove = Date.now(); return; }   // simple pause de l'utilisateur
      const stuckFor = Date.now() - wdLastMove;
      if (stuckFor > 8000 && !wdNudged) { wdNudged = true; video.play().catch(() => {}); }
      if (stuckFor > 14000 && !wdReported) { wdReported = true; ipcRenderer.send('pure:yt-stuck'); }
      if (stuckFor > 22000 && wdReported) activateFallback();   // toujours figé après l'allègement des règles
    }, 1000);
  }
}

// --- Vidéo détachée : envoie les images de la vidéo vers la fenêtre flottante (pip.js / pip.html) ---
// Le son reste dans l'onglet ; seules les images partent, par un canal direct (MessagePort).
(() => {
  let session = null;
  let hint = null, hintUntil = 0;         // vidéo sur laquelle l'utilisateur vient de cliquer le bouton « Détacher »
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
    const hinted = hint && hint.isConnected && Date.now() < hintUntil && hint.videoWidth > 0 ? hint : null;
    hint = null;
    const video = hinted || pickVideo();
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


  // --- Bouton « Détacher la vidéo » : apparaît dans le coin de la vidéo quand la souris la survole ---
  // Construit avec des styles écrits un par un (compatible avec les règles de sécurité des pages) et isolé des styles du site.
  const eligible = (v) => v && v.isConnected && v.videoWidth > 0 && v.videoHeight > 0 && v.readyState >= 1 && !v.mediaKeys;
  const LABEL_ON = 'Détacher la vidéo', LABEL_OFF = 'Rattacher la vidéo';
  let btnHost = null, btn = null, btnLabel = null;
  let hoverVideo = null, overBtn = false, shown = false, hideTimer = null, raf = 0, lastMove = null;

  function buildButton() {
    btnHost = document.createElement('div');
    Object.assign(btnHost.style, { position: 'fixed', top: '0', left: '0', width: '0', height: '0', zIndex: '2147483647', pointerEvents: 'none' });
    const root = btnHost.attachShadow({ mode: 'closed' });
    btn = document.createElement('div');
    Object.assign(btn.style, {
      position: 'fixed', top: '10px', right: '10px', height: '34px', boxSizing: 'border-box', padding: '0 8px',
      display: 'none', alignItems: 'center', borderRadius: '11px', background: 'rgba(140,52,89,0.93)', color: '#FBF1F5',
      font: '600 12.5px "Segoe UI", Arial, sans-serif', cursor: 'pointer', pointerEvents: 'auto', userSelect: 'none',
      boxShadow: '0 4px 16px rgba(46,22,34,0.45)', opacity: '0', transition: 'opacity .15s ease, background .15s ease'
    });
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '18'); svg.setAttribute('height', '18');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.9');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    const r1 = document.createElementNS(NS, 'rect');
    ['x:3', 'y:5', 'width:18', 'height:14', 'rx:2.5'].forEach(kv => { const [k, v] = kv.split(':'); r1.setAttribute(k, v); });
    const r2 = document.createElementNS(NS, 'rect');
    ['x:12', 'y:11.5', 'width:7', 'height:5', 'rx:1.2'].forEach(kv => { const [k, v] = kv.split(':'); r2.setAttribute(k, v); });
    r2.setAttribute('fill', 'currentColor'); r2.setAttribute('stroke', 'none');
    svg.append(r1, r2);
    Object.assign(svg.style, { flex: '0 0 auto', display: 'block' });
    btnLabel = document.createElement('span');
    Object.assign(btnLabel.style, { maxWidth: '0', overflow: 'hidden', whiteSpace: 'nowrap', marginLeft: '0', transition: 'max-width .18s ease, margin .18s ease' });
    btnLabel.textContent = LABEL_ON;
    btn.append(svg, btnLabel);
    root.appendChild(btn);

    btn.addEventListener('mouseenter', () => {
      overBtn = true; clearTimeout(hideTimer);
      btnLabel.style.maxWidth = '150px'; btnLabel.style.marginLeft = '8px'; btn.style.background = 'rgba(184,81,121,0.97)';
    });
    btn.addEventListener('mouseleave', () => {
      overBtn = false;
      btnLabel.style.maxWidth = '0'; btnLabel.style.marginLeft = '0'; btn.style.background = 'rgba(140,52,89,0.93)';
      scheduleHide();
    });
    // Le clic ne doit pas atteindre le lecteur de la page (sinon la vidéo se met en pause)
    ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick'].forEach(t => btn.addEventListener(t, (e) => { e.stopPropagation(); }));
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault();
      if (!e.isTrusted) return;                       // seul un vrai clic de l'utilisateur compte (pas un script de la page)
      hint = hoverVideo; hintUntil = Date.now() + 5000;
      hideButton();
      try { ipcRenderer.sendToHost('pip:request'); } catch (err) { /* page fermée */ }
    });
  }

  function showButton(v) {
    if (!btnHost) buildButton();
    if (!btnHost.isConnected) (document.documentElement || document.body).appendChild(btnHost);
    hoverVideo = v;
    clearTimeout(hideTimer);
    btnLabel.textContent = session && session.video === v ? LABEL_OFF : LABEL_ON;
    const r = v.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth, vh = document.documentElement.clientHeight || window.innerHeight;
    btn.style.top = clamp(Math.max(r.top, 0) + 10, 8, Math.max(8, vh - 44)) + 'px';
    btn.style.right = Math.max(8, vw - Math.min(r.right, vw) + 10) + 'px';
    if (!shown) {
      shown = true;
      btn.style.display = 'flex';
      requestAnimationFrame(() => { if (shown) btn.style.opacity = '1'; });
    }
  }
  function hideButton() {
    clearTimeout(hideTimer);
    if (!shown) return;
    shown = false; overBtn = false;
    btn.style.opacity = '0';
    setTimeout(() => { if (!shown && btn) btn.style.display = 'none'; }, 170);
  }
  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (!overBtn) hideButton(); }, 350);
  }

  function videoAt(x, y) {
    const scan = (list) => {
      for (const el of list) {
        if (el.tagName === 'VIDEO') return el;
        if (el.shadowRoot && el.shadowRoot.elementsFromPoint) { const inner = scan(el.shadowRoot.elementsFromPoint(x, y)); if (inner) return inner; }
      }
      return null;
    };
    return scan(document.elementsFromPoint(x, y));
  }

  function onFrame() {
    raf = 0;
    const e = lastMove;
    if (!e || document.fullscreenElement) { hideButton(); return; }
    if (e.target === btnHost) { clearTimeout(hideTimer); return; }      // la souris est sur le bouton lui-même
    const v = videoAt(e.clientX, e.clientY);
    if (v && eligible(v)) {
      const r = v.getBoundingClientRect();
      if (r.width >= 160 && r.height >= 90) { showButton(v); return; }
    }
    if (shown && !overBtn) scheduleHide();
  }
  document.addEventListener('mousemove', (e) => { lastMove = e; if (!raf) raf = requestAnimationFrame(onFrame); }, true);
  document.addEventListener('mouseleave', () => { if (shown && !overBtn) scheduleHide(); }, true);
  window.addEventListener('scroll', () => { if (shown) hideButton(); }, true);
  window.addEventListener('resize', () => { if (shown) hideButton(); });

  ipcRenderer.on('pip:start', (event, opts) => { start(event.ports && event.ports[0], opts); });
  ipcRenderer.on('pip:stop', () => stop());
})();
