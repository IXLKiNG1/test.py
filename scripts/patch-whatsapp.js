'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MARKERS = {
  media: '/* CHAT_BOT_MEDIA_COMPAT_401 */'
};

function findMessageObjectEnd(source, start) {
  let depth = 0;
  let inString = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i += 1; }
      continue;
    }
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '/' && next === '/') { inLineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i += 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }

    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        let end = i + 1;
        while (end < source.length && /\s/.test(source[end])) end += 1;
        if (source[end] === ';') end += 1;
        return end;
      }
    }
  }

  return -1;
}

function patchUtils(source) {
  const marker = MARKERS.media;
  if (source.includes(marker)) return { source, changed: false };

  const messageCandidates = [
    /\bconst\s+message\s*=\s*\{/g,
    /\blet\s+message\s*=\s*\{/g,
    /\bmessage\s*=\s*\{/g
  ];

  let messageStart = -1;
  let match = null;
  for (const re of messageCandidates) {
    const candidate = re.exec(source);
    if (candidate && (messageStart < 0 || candidate.index < messageStart)) {
      messageStart = candidate.index;
      match = candidate;
    }
  }

  if (messageStart < 0) {
    throw new Error('لم أجد كائن الرسالة الخارجة داخل Utils.js، لذلك أوقفت التشغيل بدل تطبيق patch غير آمن.');
  }

  const openBrace = source.indexOf('{', messageStart);
  const objectEnd = findMessageObjectEnd(source, openBrace);
  if (objectEnd < 0) {
    throw new Error('لم أستطع تحديد نهاية كائن الرسالة الخارجة داخل Utils.js.');
  }

  const compatibilityBlock = `\n        ${marker}\n        // WhatsApp Web 2026 may leak MediaData.__x_id into the outgoing Msg model.\n        // It collides with the message key and breaks media sends.\n        if (message && message.__x_id) delete message.__x_id;`;

  let out = source.slice(0, objectEnd) + compatibilityBlock + source.slice(objectEnd);

  out = out.replace(
    /\.Msg\.get\(newMsgKey\._serialized\)/g,
    '.Msg.get(newMsgKey._serialized || newMsgKey.$1)'
  );

  out = out.replace(
    /\.Msg\.get\(newMsgKey\.\$1\)/g,
    '.Msg.get(newMsgKey._serialized || newMsgKey.$1)'
  );

  return { source: out, changed: true, anchor: match?.[0] || null };
}

function applyPatch() {
  const result = { ok: true, changed: [], errors: [] };
  try {
    const root = path.dirname(require.resolve('whatsapp-web.js/package.json'));
    const utilsFile = path.join(root, 'src', 'util', 'Injected', 'Utils.js');
    if (!fs.existsSync(utilsFile)) throw new Error('ملف Utils.js الخاص بـ whatsapp-web.js غير موجود.');

    const source = fs.readFileSync(utilsFile, 'utf8');
    const patched = patchUtils(source);

    if (patched.changed) {
      const temp = `${utilsFile}.${process.pid}.tmp`;
      fs.writeFileSync(temp, patched.source, 'utf8');
      fs.renameSync(temp, utilsFile);
      result.changed.push(path.basename(utilsFile));
    }

    verifyPatched();
  } catch (error) {
    result.ok = false;
    result.errors.push(error.message || String(error));
  }
  return result;
}

function verifyPatched() {
  const root = path.dirname(require.resolve('whatsapp-web.js/package.json'));
  const file = path.join(root, 'src', 'util', 'Injected', 'Utils.js');
  if (!fs.existsSync(file)) throw new Error('Utils.js غير موجود أثناء الفحص.');

  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(MARKERS.media)) throw new Error('لم يتم العثور على علامة patch الخاصة بالوسائط.');
  if (!/if \(message && message\.__x_id\) delete message\.__x_id;/.test(text)) throw new Error('لم يتم العثور على إزالة __x_id بعد كائن الرسالة.');
  if (/\.Msg\.get\(newMsgKey\._serialized\)/.test(text)) throw new Error('ما زال هناك lookup يعتمد على _serialized فقط.');
  if (!/\.Msg\.get\(newMsgKey\._serialized \|\| newMsgKey\.\$1\)/.test(text)) throw new Error('لم تتم إضافة fallback لـ $1 في lookup الخاص برسالة WhatsApp.');
  return true;
}

if (require.main === module) {
  const result = applyPatch();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

module.exports = { applyPatch, patchUtils, verifyPatched, MARKERS, findMessageObjectEnd };
