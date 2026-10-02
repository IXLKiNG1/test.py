'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
function pass(name) { console.log(`PASS  ${name}`); }
function run(name, fn) { try { fn(); pass(name); } catch (e) { console.error(`FAIL  ${name}: ${e.message}`); process.exitCode = 1; } }

const jsFiles = [
  ...fs.readdirSync(path.join(root, 'src')).filter(x => x.endsWith('.js')).map(x => path.join(root, 'src', x)),
  path.join(root, 'server.js'),
  path.join(root, 'scripts', 'patch-whatsapp.js'),
  path.join(root, 'test', 'core.js'),
  path.join(root, 'test', 'static.js'),
  path.join(root, 'test', 'delivery.js')
];
for (const file of jsFiles) run(`syntax ${path.relative(root, file)}`, () => cp.execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }));

run('package and local-helper policy', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.version !== '6.0.0') throw new Error('version mismatch');
  if (pkg.dependencies['whatsapp-web.js'] !== '1.34.6') throw new Error('unexpected whatsapp-web.js version');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  if (/openai|gemini|anthropic|\/api\/assistant|\/control\/assistant/i.test(`${html}\n${server}`)) throw new Error('external assistant API found');
  if (/<input[^>]+type=["'](?:text|search)["'][^>]+id=["'][^"']*(assistant|question)/i.test(html)) throw new Error('free-form assistant input found');
  if (/setInterval\s*\(/.test(html)) throw new Error('UI polling found');
  const wa = fs.readFileSync(path.join(root, 'src', 'whatsapp.js'), 'utf8');
  if (!/sendTimeoutMs/.test(fs.readFileSync(path.join(root, 'src', 'store.js'), 'utf8'))) throw new Error('send timeout setting missing');
  if (!/message_ack/.test(wa) || !/pendingAcks/.test(wa) || !/getMessageById/.test(wa)) throw new Error('ack observation missing');
  if (!/withTimeout\(/.test(wa)) throw new Error('send timeout wrapper missing');
  if (!/chatCache/.test(wa)) throw new Error('chat id cache missing');
  if (!/pendingAcks\.clear\(\)/.test(wa)) throw new Error('pending ACK cleanup missing');
  if (!/__chatBotAck/.test(wa)) throw new Error('delivery acknowledgement metadata missing');
  if (!/directSendText/.test(wa) || !/directSendMedia/.test(wa)) throw new Error('direct send paths missing');
  if (/return this\.sendText\(/.test(wa)) throw new Error('nested send queue detected in WhatsApp reply path');
  if (!/priority: toInt/.test(fs.readFileSync(path.join(root, 'src', 'store.js'), 'utf8'))) throw new Error('interaction priority persistence missing');
  if (!/backgroundProfiles/.test(fs.readFileSync(path.join(root, 'src', 'store.js'), 'utf8'))) throw new Error('per-background profile persistence missing');
  const store=fs.readFileSync(path.join(root,'src','store.js'),'utf8');
  if (!/interactionScope.*selected/.test(store) || !/interactionChatIds/.test(store)) throw new Error('global selected interaction scope missing');
  if (!/cycle\.round/.test(store) || !/roundStartedAt/.test(store)) throw new Error('cycle round persistence missing');
  for (const mode of ['aurora','grid','stars','particles','orbits','waves','matrix','nebula','meteor']) if (!new RegExp(`<button[^>]+data-bg-mode=\"${mode}\"`).test(html)) throw new Error(`background mode missing: ${mode}`);
});

run('phase2 groups and automation wiring', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const auto = fs.readFileSync(path.join(root, 'src', 'automation.js'), 'utf8');
  const group = fs.readFileSync(path.join(root, 'src', 'groups.js'), 'utf8');
  if (!/control\/groups\/analyze-gid/.test(server) || !/control\/groups\/analyze-invite/.test(server)) throw new Error('group analysis routes missing');
  if (!/control\/automation\/tasks/.test(server) || !/zonedDateToUtc/.test(server)) throw new Error('automation routes missing');
  if (!/id="groupGid"/.test(html) || !/id="groupResult"/.test(html)) throw new Error('group analysis UI missing');
  if (!/id="taskDate"/.test(html) || !/id="taskTime"/.test(html)) throw new Error('exact date/time UI missing');
  if (!/addCalendarMonths/.test(auto) || !/getInviteInfo/.test(fs.readFileSync(path.join(root,'src','whatsapp.js'),'utf8'))) throw new Error('phase2 calendar/invite support missing');
  if (!/extractInviteCode/.test(group) || !/normalizeGid/.test(group)) throw new Error('group helpers missing');
});

run('server-side scheduler and real session switching', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const scheduler = fs.readFileSync(path.join(root, 'src', 'scheduler.js'), 'utf8');
  if (!/scheduler\.start\(\)/.test(server)) throw new Error('scheduler not started');
  if (!/setInterval\(\(\) =>/.test(scheduler)) throw new Error('scheduler watchdog missing');
  if (!/control\/sessions\/switch/.test(server)) throw new Error('real switch route missing');
  if (!/control\/background\/upload/.test(server) || !/control\/background\/settings/.test(server) || !/backgroundProfiles/.test(server)) throw new Error('background routes missing');
  if (!/scheduler\.cancel\(id\)/.test(server)) throw new Error('deleted-session timer is not cancelled');
  if (!/await whatsapp\.stop\(previousId\)/.test(server)) throw new Error('previous session is not stopped');
  if (!/whatsapp\.hasSavedAuth\(session\.id\)/.test(server)) throw new Error('target session saved auth check missing');
  if (!/scheduler\.wakeAll\(\)/.test(server)) throw new Error('global scheduler wake missing');
});

run('guide, privacy and manual-refresh UI', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  if (!/data-page="guide"/.test(html)) throw new Error('guide page missing');
  if (!/id="privacy"/.test(html)) throw new Error('privacy section missing');
  if (!/id="helpTab"/.test(html)) throw new Error('side guide trigger missing');
  if (!/loadState\(\)\.catch/.test(html)) throw new Error('initial/manual loading missing');
  if (/setInterval\s*\(|location\.reload\s*\(/.test(html)) throw new Error('automatic UI refresh detected');
  if (!/cache:\s*['"]no-store['"]/.test(html) && !/Cache-Control/.test(fs.readFileSync(path.join(root,'server.js'),'utf8'))) throw new Error('no cache bypass');
});

run('session isolation and local paths', () => {
  const store = fs.readFileSync(path.join(root, 'src', 'store.js'), 'utf8');
  if (!/SESSIONS_DIR/.test(store) || !/authRoot/.test(store) || !/images/.test(store)) throw new Error('session-local storage paths missing');
  if (!/clientId: this\.store\.safeSessionId\(safe\)/.test(fs.readFileSync(path.join(root, 'src', 'whatsapp.js'),'utf8'))) throw new Error('per-session WhatsApp clientId missing');
  if (!/backgrounds/.test(store) || !/backgroundImage/.test(store)) throw new Error('session background storage missing');
});

run('file checks', () => {
  for (const file of ['README.md','CHANGELOG.md','REVIEW_REPORT.md','run.py','package.json','public/index.html','data/global.json']) {
    const full = path.join(root, file);
    if (!fs.existsSync(full) || fs.statSync(full).size === 0) throw new Error(`${file} missing/empty`);
  }
  const runpy = fs.readFileSync(path.join(root, 'run.py'), 'utf8');
  if (!/--no-audit/.test(runpy) || !/--no-fund/.test(runpy)) throw new Error('run.py install flags missing');
  if (!/PORT = 7005/.test(runpy) || !/HOST = \"127\.0\.0\.1\"/.test(runpy) || !/PUPPETEER_SKIP_DOWNLOAD/.test(runpy)) throw new Error('run.py startup configuration missing');
});

run('delivery history and retry policy', () => {
  const delivery = fs.readFileSync(path.join(root, 'src', 'delivery.js'), 'utf8');
  const scheduler = fs.readFileSync(path.join(root, 'src', 'scheduler.js'), 'utf8');
  if (!/s\.cycle\.delivery=\{\}/.test(delivery) || !/startNewRound/.test(delivery)) throw new Error('cycle reset/new-round logic missing');
  if (!/retry:false/.test(delivery)) throw new Error('permanent scheduled failures are not marked non-retryable');
  if (!/result\?\.retry === false/.test(scheduler)) throw new Error('scheduler retry policy missing');
  if (!/stageKey/.test(delivery) || !/countTowardCycle/.test(delivery)) throw new Error('delivery stage keys/cycle controls missing');
  if (!/manualGuard/.test(delivery) || !/duplicateGuard/.test(delivery)) throw new Error('manual duplicate guard missing');
});
