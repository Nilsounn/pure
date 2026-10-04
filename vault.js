// Coffre de mots de passe de Pure : chiffré sur disque (scrypt + AES-256-GCM).
// Aucune dépendance à Electron : le presse-papiers et le verrouillage auto sont injectés.
const crypto = require('crypto');
const fs = require('fs');

const KDF_DEFAULT = { N: 1 << 15, r: 8, p: 1 };
const MAX_FAILS = 5;
const LOCKOUT_MS = 30000;
const CLIPBOARD_CLEAR_MS = 20000;

function deriveKey(password, saltB64, kdf) {
  return crypto.scryptSync(String(password).normalize('NFKC'), Buffer.from(saltB64, 'base64'), 32, {
    N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 128 * kdf.N * kdf.r * 2
  });
}

function encryptData(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: ct.toString('base64') };
}

function decryptData(key, box) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  const pt = Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]);
  return JSON.parse(pt.toString('utf8'));
}

function normOrigin(u) {
  try {
    const s = String(u || '').trim();
    const x = new URL(s.includes('://') ? s : 'https://' + s);
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return null;
    return x.origin;
  } catch (e) { return null; }
}

function hostOf(origin) {
  try { return new URL(origin).hostname.replace(/^www\./, ''); } catch (e) { return origin; }
}

function generatePassword(len) {
  len = len || 20;
  const sets = ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789', '!@#$%^&*-_=+?'];
  const all = sets.join('');
  const out = sets.map(s => s[crypto.randomInt(s.length)]);
  while (out.length < len) out.push(all[crypto.randomInt(all.length)]);
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

function createVaultService(opts) {
  const { filePath, copyToClipboard, readClipboard, onAutoLock } = opts;
  const idleMs = opts.idleMs || 15 * 60 * 1000;
  let file = null, key = null, data = null, idleTimer = null, fails = 0, lockedUntil = 0;
  const LOCKED = { error: 'locked' };

  function load() {
    file = null;
    if (!fs.existsSync(filePath)) return;
    try {
      const f = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!f || !f.kdf || !f.data || !f.iv || !f.tag) throw new Error('format');
      file = f;
    } catch (e) {
      try { fs.renameSync(filePath, filePath + '.corrupt'); } catch (_) { /* ignoré */ }
    }
  }

  function persist() {
    file = { v: 1, name: file.name, kdf: file.kdf, ...encryptData(key, data) };
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(file), 'utf8');
    fs.renameSync(tmp, filePath);
  }

  function lock() {
    key = null; data = null;
    clearTimeout(idleTimer);
  }
  function touch() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { lock(); if (onAutoLock) onAutoLock(); }, idleMs);
    if (idleTimer.unref) idleTimer.unref();
  }
  function status() {
    return { exists: !!file, unlocked: !!key, name: file ? file.name : null, count: data ? data.entries.length : 0 };
  }

  function create(name, password) {
    if (file) return { error: 'Un compte existe déjà.' };
    name = String(name || '').trim().slice(0, 60);
    if (!name) return { error: 'Choisis un nom de compte.' };
    if (!password || String(password).length < 8) return { error: 'Le mot de passe principal doit faire au moins 8 caractères.' };
    const kdf = { ...KDF_DEFAULT, salt: crypto.randomBytes(16).toString('base64') };
    key = deriveKey(password, kdf.salt, kdf);
    data = { entries: [], neverSave: [] };
    file = { v: 1, name, kdf, ...encryptData(key, data) };
    persist(); touch();
    return { status: status() };
  }

  function unlock(password) {
    if (!file) return { error: 'Aucun compte.' };
    const now = Date.now();
    if (now < lockedUntil) return { error: 'Trop de tentatives. Réessaie dans ' + Math.ceil((lockedUntil - now) / 1000) + ' s.' };
    let k, d;
    try {
      k = deriveKey(password || '', file.kdf.salt, file.kdf);
      d = decryptData(k, file);
    } catch (e) {
      fails++;
      if (fails >= MAX_FAILS) { lockedUntil = now + LOCKOUT_MS; fails = 0; }
      return { error: 'Mot de passe principal incorrect.' };
    }
    fails = 0; key = k; data = d; touch();
    return { status: status() };
  }

  function list() {
    if (!key) return LOCKED;
    touch();
    const entries = data.entries
      .map(e => ({ id: e.id, origin: e.origin, username: e.username, updatedAt: e.updatedAt }))
      .sort((a, b) => hostOf(a.origin).localeCompare(hostOf(b.origin)));
    return { entries };
  }

  function listForOrigin(origin) {
    if (!key) return LOCKED;
    touch();
    return { entries: data.entries.filter(e => e.origin === origin).map(e => ({ id: e.id, username: e.username })) };
  }

  function checkSave(d) {
    if (!file) return { state: 'no-account' };
    if (!key) return { state: 'locked' };
    touch();
    if (data.neverSave.includes(d.origin)) return { state: 'never' };
    const ex = data.entries.find(e => e.origin === d.origin && e.username === d.username);
    if (!ex) return { state: 'new' };
    return ex.password === d.password ? { state: 'same' } : { state: 'update', id: ex.id };
  }

  function save(d) {
    if (!key) return LOCKED;
    const origin = normOrigin(d.site || d.origin);
    if (!origin) return { error: 'Adresse de site invalide.' };
    const password = String(d.password || '');
    if (!password) return { error: 'Le mot de passe est vide.' };
    if (password.length > 512) return { error: 'Mot de passe trop long.' };
    const username = String(d.username || '').trim().slice(0, 256);
    const now = Date.now();
    const ex = data.entries.find(e => e.origin === origin && e.username === username);
    let updated = false;
    if (ex) { ex.password = password; ex.updatedAt = now; updated = true; }
    else data.entries.push({ id: crypto.randomUUID(), origin, username, password, createdAt: now, updatedAt: now });
    persist(); touch();
    return { ok: true, updated };
  }

  function getCreds(id) {
    if (!key) return LOCKED;
    touch();
    const e = data.entries.find(x => x.id === id);
    return e ? { username: e.username, password: e.password } : { error: 'Entrée introuvable.' };
  }

  function copy(id) {
    const c = getCreds(id);
    if (c.error) return c;
    copyToClipboard(c.password);
    const t = setTimeout(() => { try { if (readClipboard() === c.password) copyToClipboard(''); } catch (e) { /* ignoré */ } }, CLIPBOARD_CLEAR_MS);
    if (t.unref) t.unref();
    return { ok: true };
  }

  function remove(id) {
    if (!key) return LOCKED;
    data.entries = data.entries.filter(e => e.id !== id);
    persist(); touch();
    return { ok: true };
  }

  function neverSave(origin) {
    if (!key) return LOCKED;
    if (!data.neverSave.includes(origin)) data.neverSave.push(origin);
    persist(); touch();
    return { ok: true };
  }

  function deleteAccount() {
    try { fs.rmSync(filePath, { force: true }); } catch (e) { /* ignoré */ }
    file = null; fails = 0; lockedUntil = 0; lock();
    return { ok: true };
  }

  return { load, status, create, unlock, lock, list, listForOrigin, checkSave, save, getCreds, copy, remove, neverSave, deleteAccount, generate: generatePassword };
}

module.exports = { createVaultService, normOrigin, generatePassword };
