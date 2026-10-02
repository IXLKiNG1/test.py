'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif'
};
const EXT = new Set(Object.keys(MIME));
const NAME_RE = /^(?:img\.(\d+)(?:_\d+)?|0*(\d{1,6})__.+)$/u;
const cache = new Map();

const BACKGROUND_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp'
};
const BACKGROUND_EXT = new Set(Object.keys(BACKGROUND_MIME));

function slug(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  const stem = path.basename(String(name || 'image'), ext)
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}_ -]+/gu, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, 60);
  return stem || 'image';
}
function entries(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && EXT.has(path.extname(e.name).toLowerCase()))
    .map(e => {
      const full = path.join(dir, e.name);
      const st = fs.statSync(full);
      const stem = path.basename(e.name, path.extname(e.name));
      const m = stem.match(NAME_RE);
      const sequence = m ? Number(m[1] || m[2]) : null;
      return { filename: e.name, path: full, ext: path.extname(e.name).toLowerCase(), size: st.size, mtime: st.mtimeMs, sequence: Number.isFinite(sequence) ? sequence : null };
    })
    .sort((a, b) => (a.sequence ?? 1e9) - (b.sequence ?? 1e9) || a.mtime - b.mtime || a.filename.localeCompare(b.filename, 'ar'));
}
function nextSequence(dir) { return entries(dir).reduce((m, x) => Math.max(m, x.sequence || 0), 0) + 1; }
function uniqueName(dir, seq, original) {
  const ext = path.extname(String(original || '')).toLowerCase();
  if (!EXT.has(ext)) throw new Error('نوع الصورة غير مدعوم.');
  const base = slug(original);
  let name = `img.${seq}${ext}`;
  let n = 2;
  while (fs.existsSync(path.join(dir, name))) name = `img.${seq}_${n++}${ext}`;
  return name;
}
function normalizeNames(dir) {
  const list = entries(dir);
  let seq = nextSequence(dir);
  const changes = [];
  for (const item of list) {
    if (item.sequence != null) continue;
    const target = uniqueName(dir, seq++, item.filename);
    fs.renameSync(item.path, path.join(dir, target));
    changes.push({ from: item.filename, to: target });
  }
  return { changes, images: entries(dir) };
}
function importImage(sourcePath, originalName, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error('الملف فارغ أو غير صالح.');
  const ext = path.extname(originalName || '').toLowerCase();
  if (!EXT.has(ext)) throw new Error('ارفع JPG أو PNG أو WEBP أو GIF.');
  normalizeNames(dir);
  const targetName = uniqueName(dir, nextSequence(dir), originalName);
  const target = path.join(dir, targetName);
  fs.copyFileSync(sourcePath, target);
  return targetName;
}
function hashFile(file, stat = fs.statSync(file)) {
  const c = cache.get(file);
  if (c && c.size === stat.size && c.mtime === stat.mtimeMs) return c.hash;
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  cache.set(file, { size: stat.size, mtime: stat.mtimeMs, hash });
  return hash;
}
function scanImages(dir, maxMB = 50) {
  const maxBytes = Math.max(1, Number(maxMB) || 50) * 1024 * 1024;
  const images = []; const duplicates = []; const invalid = []; const seen = new Map();
  for (const item of entries(dir)) {
    if (item.size <= 0 || item.size > maxBytes) { invalid.push({ filename: item.filename, reason: item.size <= 0 ? 'empty' : 'too_large' }); continue; }
    let id;
    try { id = hashFile(item.path); } catch (e) { invalid.push({ filename: item.filename, reason: e.message }); continue; }
    if (seen.has(id)) { duplicates.push({ filename: item.filename, duplicateOf: seen.get(id).filename }); continue; }
    const data = { id, filename: item.filename, sequence: item.sequence || 0, size: item.size, mtime: item.mtime, mime: MIME[item.ext] };
    seen.set(id, data); images.push(data);
  }
  images.sort((a, b) => a.sequence - b.sequence || a.mtime - b.mtime || a.filename.localeCompare(b.filename, 'ar'));
  return { images, duplicates, invalid };
}

function safeImagePath(dir, filename) {
  const safe = path.basename(String(filename || ''));
  if (!safe || safe !== String(filename)) throw new Error('اسم الملف غير صالح.');
  const ext = path.extname(safe).toLowerCase();
  if (!EXT.has(ext)) throw new Error('نوع الملف غير مدعوم.');
  const root = path.resolve(dir); const full = path.resolve(dir, safe);
  if (!full.startsWith(root + path.sep)) throw new Error('مسار الملف غير صالح.');
  if (!fs.existsSync(full)) throw new Error('الصورة غير موجودة.');
  const st = fs.statSync(full);
  if (!st.isFile() || st.size <= 0) throw new Error('الصورة غير صالحة.');
  return full;
}


function backgroundName(original) {
  const ext = path.extname(String(original || '')).toLowerCase();
  if (!BACKGROUND_EXT.has(ext)) throw new Error('خلفية غير مدعومة. استخدم JPG أو PNG أو WEBP.');
  return `background${ext}`;
}
function importBackground(sourcePath, originalName, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error('ملف الخلفية فارغ أو غير صالح.');
  const ext = path.extname(originalName || '').toLowerCase();
  if (!BACKGROUND_EXT.has(ext)) throw new Error('استخدم JPG أو PNG أو WEBP للخلفية.');
  const targetName = backgroundName(originalName);
  for (const file of fs.readdirSync(dir)) {
    if (/^background\.(jpg|jpeg|png|webp)$/i.test(file) && file !== targetName) {
      try { fs.unlinkSync(path.join(dir, file)); } catch {}
    }
  }
  const target = path.join(dir, targetName);
  fs.copyFileSync(sourcePath, target);
  return targetName;
}
function safeBackgroundPath(dir, filename) {
  const safe = path.basename(String(filename || ''));
  if (!safe || safe !== String(filename)) throw new Error('اسم الخلفية غير صالح.');
  const ext = path.extname(safe).toLowerCase();
  if (!BACKGROUND_EXT.has(ext) || !/^background\.(jpg|jpeg|png|webp)$/i.test(safe)) throw new Error('ملف خلفية غير مسموح.');
  const root = path.resolve(dir);
  const full = path.resolve(dir, safe);
  if (!full.startsWith(root + path.sep)) throw new Error('مسار الخلفية غير صالح.');
  if (!fs.existsSync(full)) throw new Error('الخلفية غير موجودة.');
  const st = fs.statSync(full);
  if (!st.isFile() || st.size <= 0) throw new Error('الخلفية غير صالحة.');
  return full;
}

module.exports = { MIME, EXT, normalizeNames, importImage, scanImages, safeImagePath, slug, BACKGROUND_MIME, BACKGROUND_EXT, importBackground, safeBackgroundPath };
