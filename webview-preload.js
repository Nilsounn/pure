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
