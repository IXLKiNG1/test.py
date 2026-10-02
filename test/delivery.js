'use strict';
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const assert=require('node:assert/strict');
const {DeliveryService,stageKey}=require('../src/delivery');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'chatbot-delivery-'));const imagesDir=path.join(temp,'images');fs.mkdirSync(imagesDir,{recursive:true});
for(const name of ['img.1.jpg','img.2.jpg'])fs.writeFileSync(path.join(imagesDir,name),Buffer.from([0xff,0xd8,0xff,0xd9]));
const session={id:'demo',name:'Demo',recipients:[{id:'r1',name:'نور',phone:'96890000000',enabled:true}],groups:[],settings:{maxImageSizeMB:5,timezone:'Asia/Muscat',preText:'chat BOT',postText:'تمت الصورة {{image}}',retryAttempts:1,retryDelayMs:10,sendDelayMs:0,scheduledGroupsEnabled:true,maxInstantPairs:50,instantDuplicateGuard:true,instantCountTowardCycle:true},cycle:{imageOrder:[],currentIndex:0,round:1,roundStartedAt:new Date().toISOString(),delivery:{}},stats:{sentImages:0,sentMessages:0,confirmedAcks:0,uncertainSends:0,failedSends:0,skippedDuplicates:0},lastRun:null};
const fakeStore={safeSessionId:x=>x,loadSession:()=>JSON.parse(JSON.stringify(session)),saveSession:s=>{Object.assign(session,JSON.parse(JSON.stringify(s)));return session},getPaths:()=>({images:imagesDir})};
const calls=[];const ok=kind=>({__chatBotAck:{status:'confirmed',ack:1},id:{_serialized:`m-${calls.length+1}`} });
const fakeWhatsapp={ensureReady:async()=>true,isReady:()=>true,resolveChatId:async()=> '96890000000@c.us',sendText:async(_id,chat,text)=>{calls.push(['text',chat,text]);return ok('text')},sendMedia:async(_id,chat,file)=>{calls.push(['media',chat,path.basename(file)]);return ok('media')}};
const delivery=new DeliveryService({store:fakeStore,whatsapp:fakeWhatsapp,log:()=>{}});
(async()=>{
 const image=delivery.currentImage('demo');assert.equal(image.filename,'img.1.jpg');
 const result=await delivery.sequence('demo',session.recipients[0],image,{scheduled:false,countTowardCycle:true});
 assert.deepEqual(calls.map(x=>x[0]),['text','media','text']);assert.match(calls[1][2],/img\.1\.jpg/);assert.equal(result.image,true);assert.ok(session.cycle.delivery[image.id].r1.imageKey);
 // Complete the current scheduled round and verify it rolls into a clean new round.
 const s=delivery.session('demo');s.cycle.imageOrder=[image.id];s.cycle.currentIndex=0;s.cycle.round=7;s.cycle.delivery[image.id]={r1:{pre:true,image:true,post:true,preKey:stageKey('pre','chat BOT',image),imageKey:stageKey('image','',image),postKey:stageKey('post','تمت الصورة '+image.filename,image),lastError:null,round:7}};delivery.syncCycle=()=>s;delivery.currentImage=()=>image;delivery.save(s);assert.equal(delivery.advanceIfComplete('demo'),true);assert.equal(session.cycle.round,8);assert.equal(session.cycle.currentIndex,0);assert.deepEqual(session.cycle.delivery,{});delete delivery.syncCycle;delete delivery.currentImage;

 // Manual duplicate guard is independent from the weekly cycle and survives a second manual send.
 session.settings.instantCountTowardCycle=false;session.settings.instantDuplicateGuard=true;session.cycle.delivery={};session.cycle.manualGuard={};
 const beforeCalls=calls.length;
 const first=await delivery.instantSend('demo',{recipientIds:['r1'],groupIds:[],imageIds:[image.id],preText:'chat BOT',postText:'',duplicateGuard:true,countTowardCycle:false});
 assert.equal(first.sent.length,1);assert.equal(first.skipped.length,0);assert.equal(session.cycle.manualGuard[image.id].r1,true);
 const second=await delivery.instantSend('demo',{recipientIds:['r1'],groupIds:[],imageIds:[image.id],preText:'chat BOT',postText:'',duplicateGuard:true,countTowardCycle:false});
 assert.equal(second.sent.length,0);assert.equal(second.skipped.length,1);assert.equal(calls.length,beforeCalls+2);assert.ok(session.stats.sentImages>=2);

 // Dynamic template variables must not invalidate a completed delivery stage between retries.
 session.settings.preText='chat BOT {{time}}';session.settings.postText='تمت {{date}}';session.cycle.delivery={};session.settings.instantCountTowardCycle=true;
 const dyn=delivery.session('demo');dyn.cycle.imageOrder=[image.id];dyn.cycle.currentIndex=0;dyn.cycle.round=8;dyn.cycle.delivery={ [image.id]: {r1:{pre:true,image:true,post:true,preKey:stageKey('pre','chat BOT {{time}}',image),imageKey:stageKey('image','',image),postKey:stageKey('post','تمت {{date}}',image),lastError:null,round:8}}};delivery.save(dyn);assert.equal(delivery.allComplete(dyn,image),true);
 console.log('PASS  delivery sequence, stage keys and automatic new-round cycle');
})().catch(e=>{console.error(`FAIL  delivery tests: ${e.message}`);process.exitCode=1});
