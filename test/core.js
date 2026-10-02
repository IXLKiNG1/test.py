'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { normalizeRule, defaultRule } = require('../src/store');
const { matchRule, validateRule, idText, chatIdFromReaction } = require('../src/interaction');
const { due, nextRun, localParts } = require('../src/scheduler');
const { scanImages, normalizeNames, importImage, BACKGROUND_EXT, importBackground, safeBackgroundPath } = require('../src/media');
const { patchUtils, MARKERS } = require('../scripts/patch-whatsapp');

function pass(name) { console.log(`PASS  ${name}`); }
function fail(name, error) { console.error(`FAIL  ${name}: ${error.message}`); process.exitCode = 1; }

try {
  const rule = normalizeRule(defaultRule(null, 'تحية'));
  assert.equal(matchRule(rule, 'message', 'السلام عليكم', ''), true);
  assert.equal(matchRule(rule, 'message', 'مرحبا', ''), false);
  assert.doesNotThrow(() => validateRule(rule));
  pass('interaction matching and validation');

  const reaction = { msgId: { remote: '12345@g.us', $1: 'false_12345@g.us_ABC' } };
  assert.equal(chatIdFromReaction(reaction), '12345@g.us');
  assert.equal(idText({ $1: 'false_123@c.us_ABC' }), 'false_123@c.us_ABC');
  pass('WhatsApp modern id normalization');

  const settings = { scheduleEnabled: true, timezone: 'Asia/Muscat', dayOfWeek: 5, hour: 17, minute: 30, catchUpMinutes: 60 };
  const friday = new Date('2026-09-25T13:30:00.000Z');
  assert.equal(due(friday, { settings }).due, true);
  const upcoming = nextRun({ settings }, new Date('2026-09-25T12:00:00.000Z'));
  assert.ok(upcoming);
  assert.equal(localParts(new Date('2026-09-25T13:30:00.000Z'), 'Asia/Muscat').weekday, 5);
  pass('schedule calculation Asia/Muscat');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatbot-'));
  const dir = path.join(root, 'images');
  fs.mkdirSync(dir);
  const img = path.join(root, 'a.jpg');
  fs.writeFileSync(img, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  importImage(img, 'صورة اختبار.jpg', dir);
  normalizeNames(dir);
  const scan = scanImages(dir, 1);
  assert.equal(scan.images.length, 1);
  assert.equal(scan.images[0].sequence, 1);
  assert.match(scan.images[0].filename, /^img\.1\./);
  pass('image sequence and automatic naming');

  const second = importImage(img, 'another.png', dir);
  assert.match(second, /^img\.2\.png$/);
  pass('next image receives next img.N name');

  assert.equal(BACKGROUND_EXT.has('.jpg'), true);
  const bgDir = path.join(root, 'backgrounds');
  fs.mkdirSync(bgDir);
  const bg = path.join(root, 'bg.png');
  fs.writeFileSync(bg, Buffer.from([1, 2, 3, 4]));
  const bgName = importBackground(bg, 'خلفية.png', bgDir);
  assert.equal(bgName, 'background.png');
  assert.equal(fs.existsSync(safeBackgroundPath(bgDir, bgName)), true);
  pass('background upload and safe path');

  const utils = `            const message = {\n                ...options,\n                id: newMsgKey,\n                ...mediaOptions,\n                ...(mediaOptions.toJSON ? mediaOptions.toJSON() : {}),\n            };\n            return window\n                .require('WAWebCollections')\n                .Msg.get(newMsgKey._serialized);` ;
  const patchedUtils = patchUtils(utils).source;
  assert.match(patchedUtils, new RegExp(MARKERS.media.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(patchedUtils, /delete message\.__x_id/);
  pass('WhatsApp compatibility patch is deterministic');

  const disabled = { settings: { scheduleEnabled: false, timezone: 'Asia/Muscat', dayOfWeek: 5, hour: 17, minute: 30, catchUpMinutes: 60 } };
  assert.equal(due(new Date('2026-09-25T13:30:00.000Z'), disabled).due, false);
  pass('disabled schedule never reports due');
} catch (error) {
  fail('core tests', error);
}
