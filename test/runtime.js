'use strict';
const assert = require('node:assert/strict');
const { InteractionEngine } = require('../src/interaction');
const { AutomationService } = require('../src/automation');

function pass(name){console.log(`PASS  ${name}`)}

(async()=>{
  const session = {
    id:'s1', settings:{interactionEnabled:true, timezone:'Asia/Muscat', interactionQuietEnabled:false, maxActionsPerMinute:20},
    interaction:{enabled:true,scope:'all',rules:[{
      id:'r1',name:'سلام',enabled:true,priority:10,cooldownSec:0,scope:'all',chatIds:[],
      when:{type:'message',match:'contains',value:'سلام',ignoreCase:true},
      then:{reply:'وعليكم السلام {{sender}}',reaction:'👍',stopAfter:true}
    }],recent:[]},
    stats:{interactionActions:0,interactionErrors:0},
  };
  const store = { loadSession:()=>session, saveSession:s=>Object.assign(session,s) };
  const calls=[];
  const whatsapp = {
    replyToMessage:async(_id,_msg,text)=>{calls.push(['reply',text]);return {id:{_serialized:'m1'}}},
    reactToMessage:async(_id,_msg,emoji)=>{calls.push(['reaction',emoji]);return {ok:true}}
  };
  const engine = new InteractionEngine({store,whatsapp,log:()=>{}});
  await engine.onMessage('s1',{from:'555@c.us',fromMe:false,id:{_serialized:'m1'},body:'سلام عليكم',notifyName:'نور'});
  assert.deepEqual(calls,[['reply','وعليكم السلام نور'],['reaction','👍']]);
  pass('automatic message reply + reaction');
  session.settings.interactionScope='selected';
  session.settings.interactionChatIds=['selected@g.us'];
  session.interaction.scope='selected';
  session.interaction.chatIds=['selected@g.us'];
  calls.length=0;
  await engine.onMessage('s1',{from:'other@g.us',fromMe:false,id:{_serialized:'m2'},body:'سلام',notifyName:'اختبار'});
  assert.deepEqual(calls,[]);
  await engine.onMessage('s1',{from:'selected@g.us',fromMe:false,id:{_serialized:'m3'},body:'سلام',notifyName:'اختبار'});
  assert.equal(calls[0][0],'reply');
  pass('global selected interaction scope');

  const autoSession = {
    id:'s1', settings:{automationEnabled:true, maxInstantPairs:10},
    automation:{enabled:true,tasks:[{
      id:'t1',name:'مهمة',enabled:true,kind:'text',runAt:new Date(Date.now()-1000).toISOString(),nextRunAt:new Date(Date.now()-1000).toISOString(),
      timezone:'Asia/Muscat',targets:{recipientIds:['r1'],groupIds:['g1']},messageText:'hello',repeat:{kind:'once',interval:1},lastRunAt:null,lastStatus:null,lastError:null
    }],recent:[]},
    stats:{successfulRuns:0,failedRuns:0}
  };
  let deliveryRun=0;
  const autoStore={
    listSessionIds:()=>['s1'],safeSessionId:x=>x,loadSession:()=>autoSession,saveSession:s=>Object.assign(autoSession,JSON.parse(JSON.stringify(s))),
    normalizeTask:x=>x
  };
  const automation=new AutomationService({store:autoStore,delivery:{runAutomation:async()=>{deliveryRun++;return {ok:true,sent:[1,2],failed:[]}}},whatsapp:{},log:()=>{}});
  automation.started=true;
  await automation.tick(new Date());
  assert.equal(deliveryRun,1);
  assert.equal(autoSession.automation.tasks[0].lastStatus,'success');
  assert.equal(autoSession.automation.tasks[0].nextRunAt,null);
  pass('exact-date once automation execution + completion state');
})();
