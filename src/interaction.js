"use strict";
function norm(v){return String(v||'').normalize('NFKC').trim().toLocaleLowerCase('ar');}
function minutes(v){const m=String(v||'').match(/^(\d{2}):(\d{2})$/);if(!m)return null;const h=+m[1],n=+m[2];return h>23||n>59?null:h*60+n}
function quiet(settings,now=new Date()){if(!settings?.interactionQuietEnabled)return false;const a=minutes(settings.interactionQuietStart),b=minutes(settings.interactionQuietEnd);if(a==null||b==null||a===b)return false;const tz=settings.timezone||'Asia/Muscat';const p=new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(now);const c=(+(p.find(x=>x.type==='hour')?.value||0))*60+(+(p.find(x=>x.type==='minute')?.value||0));return a<b?c>=a&&c<b:c>=a||c<b}
function scopeOk(scope,chatId,selected=[]){const id=String(chatId||'').toLowerCase(),gid=id.endsWith('@g.us');if(scope==='groups')return gid;if(scope==='private')return !gid;if(scope==='selected')return selected.map(norm).includes(norm(id));return true}
function match(rule,event,text,emoji){const input=norm(event==='reaction'?emoji:text),value=norm(rule.when?.value);switch(rule.when?.match){case'any':return Boolean(input);case'exact':return Boolean(value)&&input===value;case'contains':return Boolean(value)&&input.includes(value);case'starts':return Boolean(value)&&input.startsWith(value);case'ends':return Boolean(value)&&input.endsWith(value);case'regex':try{return new RegExp(rule.when.value,rule.when.ignoreCase===false?'u':'iu').test(event==='reaction'?emoji:text)}catch{return false}default:return false}}
function render(text,ctx,tz='Asia/Muscat'){const time=new Intl.DateTimeFormat('ar-OM',{timeZone:tz,hour:'2-digit',minute:'2-digit'}).format(new Date());return String(text||'').replace(/\{\{message\}\}/gi,ctx.message||'').replace(/\{\{sender\}\}/gi,ctx.sender||'صديق').replace(/\{\{chat\}\}/gi,ctx.chat||'').replace(/\{\{time\}\}/gi,time).replace(/\{\{type\}\}/gi,ctx.type||'').replace(/\{\{emoji\}\}/gi,ctx.emoji||'').trim()}
function valid(rule){if(!['message','reaction'].includes(rule.when?.type))throw new Error('نوع الحدث غير مدعوم.');if(!['any','contains','exact','starts','ends','regex'].includes(rule.when?.match))throw new Error('نوع المطابقة غير مدعوم.');if(rule.when.match!=='any'&&!String(rule.when.value||'').trim())throw new Error('اكتب قيمة المطابقة.');if(rule.when.match==='regex')new RegExp(rule.when.value);if(!['all','groups','private','selected'].includes(rule.scope||'all'))throw new Error('نطاق غير مدعوم.');if(!rule.then?.reply&&!rule.then?.reaction)throw new Error('اختر ردًا أو Reaction.');}
function reactionChatId(raw){return String(raw?.chatId||raw?.msgId?.remote?._serialized||raw?.msgId?.remote||raw?.id?.remote?._serialized||raw?.id?.remote||'').trim().toLowerCase()}
function messageChatId(raw){return String(raw?.from||raw?.chatId||raw?.to||raw?.id?.remote||raw?._data?.id?.remote||'').trim().toLowerCase()}
class InteractionEngine{
  constructor({store,whatsapp,log}){this.store=store;this.whatsapp=whatsapp;this.log=log;this.seen=new Map;this.cool=new Map;this.rate=new Map;this.inFlight=new Set}
  rateOk(key,limit){const now=Date.now();let b=this.rate.get(key);if(!b||now-b.start>=60000)b={start:now,count:0},this.rate.set(key,b);if(b.count>=limit)return false;b.count++;return true}
  async onMessage(id,msg){return this.handle(id,'message',msg)}
  async onReaction(id,reaction){return this.handle(id,'reaction',reaction)}
  async handle(id,event,raw){
    const s=this.store.loadSession(id);if(!s.settings.interactionEnabled||!s.interaction.enabled||quiet(s.settings))return;
    const chatId=event==='reaction'?reactionChatId(raw):messageChatId(raw);if(!chatId)return;
    if(!scopeOk(s.settings.interactionScope||'all',chatId,s.settings.interactionChatIds||[]))return;
    const text=event==='message'?String(raw?.body||''):'';
    const emoji=event==='reaction'?String(raw?.reaction||raw?.emoji||raw?.value||''):'';
    if(event==='message'&&raw?.fromMe)return;
    const stable=String(raw?.id?._serialized||raw?.id?.$1||raw?.msgId?._serialized||raw?.msgId?.$1||raw?.messageId?._serialized||raw?.messageId?.$1||raw?.id||raw?.timestamp||`${chatId}|${text}|${emoji}`);
    const seen=`${event}|${chatId}|${stable}|${text}|${emoji}`;
    if(this.seen.has(seen))return;this.seen.set(seen,Date.now());
    if(this.seen.size>5000)for(const [k,t] of this.seen)if(Date.now()-t>600000)this.seen.delete(k);
    const rules=[...s.interaction.rules].filter(r=>r.enabled!==false).sort((a,b)=>(b.priority||0)-(a.priority||0));
    for(const rule of rules){
      if(!scopeOk(rule.scope||'all',chatId,rule.chatIds||[]))continue;
      if(!match(rule,event,text,emoji))continue;
      try{valid(rule)}catch(e){this.record(id,event,rule,'error',chatId,text,emoji,e);continue}
      const key=`${id}|${rule.id}|${chatId}`;if(this.inFlight.has(key))continue;
      const cd=Math.min(+rule.cooldownSec||0,+s.settings.interactionCooldownCapSec||86400);if(Date.now()-(this.cool.get(key)||0)<cd*1000)continue;
      if(!this.rateOk(`${id}|${chatId}`,+s.settings.maxActionsPerMinute||20))return;
      this.inFlight.add(key);
      try{
        const ctx={message:text,sender:event==='reaction'?String(raw?.senderId||'صديق'):String(raw?.notifyName||raw?._data?.notifyName||'صديق'),chat:chatId,type:event,emoji};
        const reply=render(rule.then.reply,ctx,s.settings.timezone);
        if(reply){if(event==='message')await this.whatsapp.replyToMessage(id,raw,reply);else await this.whatsapp.sendText(id,chatId,reply)}
        if(rule.then.reaction){
          const mid=raw?.msgId||raw?.messageId||raw?.id;
          if(mid)await this.whatsapp.reactToMessage(id,mid,rule.then.reaction);
        }
        this.cool.set(key,Date.now());this.record(id,event,rule,'success',chatId,text,emoji,null);
      }catch(e){this.record(id,event,rule,e.code==='SEND_UNCERTAIN'?'uncertain':'error',chatId,text,emoji,e);this.log(id,'ERROR',`فشل التفاعل ${rule.name}: ${e.message}`)}
      finally{this.inFlight.delete(key)}
      if(rule.then.stopAfter!==false)break;
    }
  }
  record(id,event,rule,status,chatId,text,emoji,error){const s=this.store.loadSession(id);s.interaction.recent=[...s.interaction.recent,{at:new Date().toISOString(),event,ruleId:rule.id,status,chatId,text:String(text||'').slice(0,250),emoji,detail:error?String(error.message||error):undefined}].slice(-200);status==='success'?s.stats.interactionActions++:s.stats.interactionErrors++;this.store.saveSession(s)}
}
module.exports={InteractionEngine,match,valid,quiet,scopeOk,render,reactionChatId,messageChatId};
