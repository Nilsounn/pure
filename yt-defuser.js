// Défuseur anti-pub YouTube de Pure : reprend, dans le monde "page" et avant les scripts de YouTube,
// les scriptlets que uBlock Origin applique sur youtube.com (liste "uBlock filters") :
//   - set-constant ytInitialPlayerResponse.{adPlacements,adSlots,playerAds} -> undefined
//   - trusted-replace-fetch-response / trusted-replace-xhr-response : "adPlacements" / "adSlots" -> "no_ads"
//     dans les réponses /youtubei/v1/{player,next,get_watch}
//   - json-prune-fetch-response sur reel_watch_sequence (publicités des Shorts)
//   - adjust-setTimeout [native code] 17000 0.001 : le minuteur de 17 s de la détection de bloqueur part tout de suite
//   - trusted-prevent-dom-bypass : les iframes créées par YouTube pour retrouver un fetch "propre" sont traitées pareil
// Ce fichier n'est pas exécuté par Electron : adblock.js le lit, le préfixe de `const PURE_FULL = true|false;`
// (false = niveau léger : seulement le piège sur ytInitialPlayerResponse) et l'injecte via adblock-preload.js.
/* global PURE_FULL */
if (!window.__pureYtDefuser) {
  try { Object.defineProperty(window, '__pureYtDefuser', { value: 1 }); } catch (e) { /* ignoré */ }

  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds'];
  const URL_RE = /\/youtubei\/v1\/(?:player|next|get_watch|reel\/reel_watch_sequence)(?:[/?]|$)/;
  const hooked = new WeakSet();

  const prune = (o) => {
    try {
      if (o && typeof o === 'object') {
        for (const k of AD_KEYS) { if (k in o) delete o[k]; }
        if (o.playerResponse && typeof o.playerResponse === 'object') prune(o.playerResponse);
      }
    } catch (e) { /* objet figé : on laisse */ }
    return o;
  };

  // Réponse texte -> texte sans publicités (même effet que le « replace » de uBO)
  const transform = (url, text) => {
    if (typeof text !== 'string' || !text) return text;
    try {
      if (url.indexOf('reel_watch_sequence') !== -1) {
        const j = JSON.parse(text);
        if (j && Array.isArray(j.entries)) {
          j.entries = j.entries.filter(e => !(e && e.command && e.command.reelWatchEndpoint && e.command.reelWatchEndpoint.adClient));
          return JSON.stringify(j);
        }
        return text;
      }
    } catch (e) { return text; }
    return text.replace(/"(?:adPlacements|adSlots|playerAds)"/g, '"no_ads"');
  };

  // 1) Piège sur la variable globale lue par le lecteur au démarrage
  const trap = (name) => {
    try {
      const d = Object.getOwnPropertyDescriptor(window, name);
      if (d && !d.configurable) return;
      let v = prune(window[name]);
      Object.defineProperty(window, name, {
        configurable: true, enumerable: true,
        get() { return v; },
        set(n) { v = prune(n); }
      });
    } catch (e) { /* ignoré */ }
  };
  trap('ytInitialPlayerResponse');

  if (PURE_FULL) {
    // 2) fetch
    const hookFetch = (win) => {
      const orig = win.fetch;
      if (typeof orig !== 'function' || hooked.has(orig)) return;
      const proxy = new Proxy(orig, {
        apply(target, thisArg, args) {
          const p = Reflect.apply(target, thisArg, args);
          let url = '';
          try { const a = args[0]; url = typeof a === 'string' ? a : (a && a.url) || String(a); } catch (e) { return p; }
          if (!URL_RE.test(url)) return p;
          return p.then(async (res) => {
            try {
              const text = await res.clone().text();
              const out = transform(url, text);
              if (out === text) return res;
              const r = new win.Response(out, { status: res.status, statusText: res.statusText, headers: res.headers });
              try { Object.defineProperty(r, 'url', { value: res.url }); } catch (e) { /* ignoré */ }
              return r;
            } catch (e) { return res; }
          });
        }
      });
      hooked.add(proxy);
      win.fetch = proxy;
    };

    // 3) XMLHttpRequest
    const xhrUrls = new WeakMap();
    const hookXhr = (win) => {
      const X = win.XMLHttpRequest;
      if (!X || !X.prototype || hooked.has(X.prototype.open)) return;
      const openProxy = new Proxy(X.prototype.open, {
        apply(t, th, a) { try { xhrUrls.set(th, String(a[1])); } catch (e) { /* ignoré */ } return Reflect.apply(t, th, a); }
      });
      hooked.add(openProxy);
      X.prototype.open = openProxy;
      ['response', 'responseText'].forEach((prop) => {
        const d = Object.getOwnPropertyDescriptor(X.prototype, prop);
        if (!d || !d.get) return;
        Object.defineProperty(X.prototype, prop, Object.assign({}, d, {
          get: new Proxy(d.get, {
            apply(t, th, a) {
              const v = Reflect.apply(t, th, a);
              const u = xhrUrls.get(th);
              return (u && typeof v === 'string' && URL_RE.test(u)) ? transform(u, v) : v;
            }
          })
        }));
      });
    };

    // 4) Minuteur de détection de 17 s
    const hookTimeout = (win) => {
      const orig = win.setTimeout;
      if (typeof orig !== 'function' || hooked.has(orig)) return;
      const proxy = new Proxy(orig, {
        apply(t, th, a) {
          try { if (a[1] === 17000 && typeof a[0] === 'function' && String(a[0]).indexOf('[native code]') !== -1) a[1] = 17; } catch (e) { /* ignoré */ }
          return Reflect.apply(t, th, a);
        }
      });
      hooked.add(proxy);
      win.setTimeout = proxy;
    };

    const installAll = (win) => {
      try { hookFetch(win); } catch (e) { /* iframe d'une autre origine */ }
      try { hookXhr(win); } catch (e) { /* idem */ }
      try { hookTimeout(win); } catch (e) { /* idem */ }
    };
    installAll(window);

    // 5) Iframes créées par la page : même traitement, sinon elles servent un fetch « propre » à YouTube
    const wrapInsert = (proto, name) => {
      try {
        const orig = proto[name];
        if (typeof orig !== 'function') return;
        proto[name] = new Proxy(orig, {
          apply(t, th, a) {
            const r = Reflect.apply(t, th, a);
            try { for (const n of a) { if (n && n.nodeName === 'IFRAME' && n.contentWindow) installAll(n.contentWindow); } } catch (e) { /* ignoré */ }
            return r;
          }
        });
      } catch (e) { /* ignoré */ }
    };
    wrapInsert(Node.prototype, 'appendChild');
    wrapInsert(Node.prototype, 'insertBefore');
    wrapInsert(Element.prototype, 'append');
    wrapInsert(Element.prototype, 'prepend');
  }
}
