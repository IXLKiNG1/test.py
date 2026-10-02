'use strict';

const assert = require('node:assert/strict');
const { normalizeGid, extractInviteCode, formatGroupAnalysis, normalizeGroupInfo } = require('../src/groups');
const { zonedDateToUtc, addNextRun, taskDue } = require('../src/automation');
const { normalizeTask } = require('../src/store');
const { matchRule } = require('../src/interaction');
const { DeliveryService } = require('../src/delivery');

function pass(name) { console.log(`PASS  ${name}`); }
function fail(name, error) { console.error(`FAIL  ${name}: ${error.message}`); process.exitCode = 1; }

try {
  assert.equal(normalizeGid(' 12036301234@g.us '), '12036301234@g.us');
  assert.equal(normalizeGid('12036301234'), '12036301234@g.us');
  assert.equal(extractInviteCode('https://chat.whatsapp.com/AbC_123-xy'), 'AbC_123-xy');
  assert.equal(extractInviteCode('AbC_123-xy'), 'AbC_123-xy');
  const group = normalizeGroupInfo({ id: '12036301234@g.us', subject: 'اختبار', size: 17, description: 'وصف', owner: 'admin@c.us', inviteCode: 'AbC' });
  assert.equal(group.gid, '12036301234@g.us');
  assert.equal(group.participantsCount, 17);
  assert.equal(group.adminsCount, 0);
  assert.match(formatGroupAnalysis(group), /اختبار/);
  pass('phase2 group parsing and analysis formatting');

  const utc = zonedDateToUtc('2026-10-02', '17:30', 'Asia/Muscat');
  assert.equal(utc.toISOString(), '2026-10-02T13:30:00.000Z');
  const recurring = normalizeTask({
    id: 'task1', name: 'شهري', kind: 'text', runAt: '2026-01-31T08:00:00.000Z', timezone: 'Asia/Muscat',
    targets: { recipientIds: ['r1'], groupIds: [] }, repeat: { kind: 'monthly', interval: 1 }, messageText: 'hello'
  });
  recurring.lastRunAt = '2026-01-31T08:00:00.000Z';
  recurring.nextRunAt = recurring.runAt;
  const next = addNextRun(recurring, new Date('2026-02-01T00:00:00.000Z'));
  assert.equal(next, '2026-02-28T08:00:00.000Z');
  assert.equal(taskDue({ enabled:true, nextRunAt:'2026-02-01T00:00:00.000Z' }, new Date('2026-02-02T00:00:00.000Z')), true);
  pass('phase2 exact-date automation and calendar recurrence');

  const regexRule = { when:{ type:'message', match:'regex', value:'^(سلام|مرحبا)', ignoreCase:true }, scope:'all' };
  assert.equal(matchRule(regexRule, 'message', 'سلام عليكم', ''), true);
  assert.equal(matchRule(regexRule, 'message', 'أهلًا', ''), false);
  pass('phase2 interaction regex matching');

  const session = {
    id:'demo', name:'Demo',
    recipients:[{id:'r1',name:'نور',phone:'',enabled:true}],
    groups:[{id:'g1',name:'مجموعة',gid:'12036301234@g.us',enabled:true}],
    settings:{ maxImageSizeMB:5, instantDuplicateGuard:true, instantCountTowardCycle:false, timezone:'Asia/Muscat', preText:'chat BOT', postText:'بعد {{image}}', retryAttempts:1, retryDelayMs:10, sendDelayMs:0, scheduledGroupsEnabled:true, maxInstantPairs:50 },
    cycle:{ imageOrder:[], currentIndex:0, round:1, roundStartedAt:new Date().toISOString(), delivery:{} },
    stats:{sentImages:0,sentMessages:0,confirmedAcks:0,uncertainSends:0,failedSends:0}, lastRun:null
  };
  const fakeStore = {
    safeSessionId:x=>x, loadSession:()=>JSON.parse(JSON.stringify(session)), saveSession:s=>{Object.assign(session, JSON.parse(JSON.stringify(s)));return session;}, getPaths:()=>({images:__dirname})
  };
  const d = Object.create(DeliveryService.prototype);
  d.store=fakeStore;
  d.log=()=>{};
  d.targetLists=DeliveryService.prototype.targetLists;
  d.scheduledTargets=DeliveryService.prototype.scheduledTargets;
  const targets = d.scheduledTargets(session);
  assert.equal(targets.length, 2);
  assert.deepEqual(targets.map(x=>x.kind), ['recipient','group']);
  pass('phase2 scheduled group target integration');
} catch (error) {
  fail('phase2 regression suite', error);
}
