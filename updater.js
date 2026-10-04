// Mise à jour intégrée de Pure : lit la dernière « Release » GitHub, télécharge PureSetup.exe,
// vérifie le fichier, puis laisse l'application lancer l'installateur en mode silencieux.
// Aucune dépendance à Electron : tout ce qui touche l'application est injecté (voir createUpdater),
// ce qui permet de tester le module seul.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function parseVersion(v) {
  const m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

// « 26.1.0 » s'affiche « 26.1 » ; un éventuel 3e chiffre non nul reste visible (« 26.1.3 »)
function formatVersion(v) {
  const p = parseVersion(v);
  return p ? (p[2] === 0 ? p[0] + '.' + p[1] : p.join('.')) : String(v || '');
}

function isNewer(remote, local) {
  const a = parseVersion(remote), b = parseVersion(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// L'installateur doit s'appeler PureSetup.exe dans la Release ; à défaut, on accepte un autre « *Setup*.exe »
function pickAsset(assets) {
  const list = Array.isArray(assets) ? assets : [];
  return list.find(a => /^puresetup\.exe$/i.test(a.name))
    || list.find(a => /setup.*\.exe$/i.test(a.name))
    || null;
}

function createUpdater(opts) {
  const {
    repo,                                   // « Nilsounn/pure »
    getVersion,                             // () => version installée
    tempDir,                                // dossier où ranger l'installateur téléchargé
    onState = () => {},                     // appelé à chaque changement d'état
    launchInstaller,                        // (fichier) => lance l'installateur puis ferme l'application
    apiBase = 'https://api.github.com',
    fetchImpl = (typeof fetch === 'function' ? fetch : null),
    trustAssetUrls = false                  // réservé aux tests
  } = opts;

  const state = {
    status: 'idle',      // idle | checking | downloading | ready | uptodate | error
    current: formatVersion(getVersion()),
    version: null,       // version proposée
    progress: 0,         // 0..100 pendant le téléchargement
    error: null,
    checkedAt: 0,
    noRelease: false
  };
  let busy = false;
  let readyFile = null;

  const emit = () => { try { onState({ ...state }); } catch (e) { /* ignoré */ } };
  const set = (patch) => { Object.assign(state, patch); emit(); };

  async function getJson(url) {
    const res = await fetchImpl(url, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'Pure/' + state.current },
      signal: AbortSignal.timeout(15000)
    });
    return res;
  }

  function cleanOldFiles(keepName) {
    try {
      for (const f of fs.readdirSync(tempDir)) {
        if (f !== keepName) fs.rmSync(path.join(tempDir, f), { force: true, recursive: true });
      }
    } catch (e) { /* dossier absent : rien à nettoyer */ }
  }

  function sha256OfFile(file) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
  }

  async function verifyFile(file, asset) {
    const st = fs.statSync(file);
    if (asset.size && st.size !== asset.size) throw new Error('taille inattendue');
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    if (head.toString('latin1') !== 'MZ') throw new Error('fichier invalide');
    const m = /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest || ''));
    if (m && (await sha256OfFile(file)) !== m[1].toLowerCase()) throw new Error('empreinte SHA-256 différente');
  }

  async function download(asset, version) {
    const url = String(asset.browser_download_url || '');
    if (!trustAssetUrls && !url.startsWith('https://github.com/' + repo + '/releases/download/')) throw new Error('adresse de téléchargement inattendue');
    fs.mkdirSync(tempDir, { recursive: true });
    const finalName = 'PureSetup-' + version + '.exe';
    const finalPath = path.join(tempDir, finalName);
    cleanOldFiles(finalName);

    // Déjà téléchargé lors d'un lancement précédent ?
    if (fs.existsSync(finalPath)) {
      try { await verifyFile(finalPath, asset); return finalPath; } catch (e) { fs.rmSync(finalPath, { force: true }); }
    }

    const partPath = finalPath + '.part';
    const res = await fetchImpl(url, { headers: { 'User-Agent': 'Pure/' + state.current }, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error('téléchargement refusé (' + res.status + ')');
    const total = Number(res.headers.get('content-length')) || asset.size || 0;
    const out = fs.createWriteStream(partPath);
    let got = 0, lastPct = -1;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (!out.write(value)) await new Promise(r => out.once('drain', r));
        if (total) {
          const pct = Math.min(99, Math.floor(got / total * 100));
          if (pct !== lastPct) { lastPct = pct; set({ progress: pct }); }
        }
      }
      await new Promise((resolve, reject) => { out.end(err => err ? reject(err) : resolve()); });
      await verifyFile(partPath, asset);
      fs.renameSync(partPath, finalPath);
    } catch (err) {
      out.destroy();
      fs.rmSync(partPath, { force: true });
      throw err;
    }
    return finalPath;
  }

  // manual = true : l'utilisateur a cliqué sur « Rechercher » (les erreurs sont affichées, sinon elles restent discrètes)
  async function check(manual) {
    if (busy) return { ...state };
    if (state.status === 'ready') return { ...state };
    if (!fetchImpl) { set({ status: 'error', error: 'indisponible' }); return { ...state }; }
    busy = true;
    set({ status: 'checking', progress: 0, error: null, noRelease: false });
    try {
      const res = await getJson(apiBase + '/repos/' + repo + '/releases/latest');
      if (res.status === 404) {                      // aucune Release publiée pour l'instant
        set({ status: 'uptodate', checkedAt: Date.now(), noRelease: true, version: null });
        return { ...state };
      }
      if (!res.ok) throw new Error('GitHub a répondu ' + res.status);
      const rel = await res.json();
      const version = formatVersion(rel.tag_name);
      if (!isNewer(version, state.current)) {
        set({ status: 'uptodate', checkedAt: Date.now(), version: null });
        return { ...state };
      }
      const asset = pickAsset(rel.assets);
      if (!asset) throw new Error('la Release ' + rel.tag_name + ' ne contient pas PureSetup.exe');
      set({ status: 'downloading', version, progress: 0 });
      readyFile = await download(asset, version);
      set({ status: 'ready', version, progress: 100, checkedAt: Date.now() });
    } catch (err) {
      readyFile = null;
      set({ status: 'error', error: String((err && err.message) || err), checkedAt: Date.now(), version: null, progress: 0 });
    } finally {
      busy = false;
    }
    return { ...state };
  }

  function install() {
    if (state.status !== 'ready' || !readyFile || !fs.existsSync(readyFile)) return false;
    try { launchInstaller(readyFile); return true; }
    catch (err) { set({ status: 'error', error: String((err && err.message) || err) }); return false; }
  }

  return { check, install, getState: () => ({ ...state }) };
}

module.exports = { createUpdater, parseVersion, formatVersion, isNewer, pickAsset };
