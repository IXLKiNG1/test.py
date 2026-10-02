"use strict";
const fs=require('node:fs');const path=require('node:path');
const MARK='/* CHAT_BOT_61_COMPAT */';
function patch(){const result={ok:true,changed:[],notes:[]};try{const root=path.dirname(require.resolve('whatsapp-web.js/package.json'));const file=path.join(root,'src','util','Injected','Utils.js');if(!fs.existsSync(file)){result.notes.push('Utils.js غير موجود؛ تم تجاوز patch.');return result}let s=fs.readFileSync(file,'utf8');if(s.includes(MARK)){result.notes.push('patch موجود مسبقًا.');return result}let out=s;let changed=false;
const idReplacements=[[/.Msg\.get\(newMsgKey\._serialized\)/g,'.Msg.get(newMsgKey._serialized || newMsgKey.$1)'],[/.Msg\.get\(newMsgKey\.\$1\)/g,'.Msg.get(newMsgKey._serialized || newMsgKey.$1)']];for(const [re,val] of idReplacements){const next=out.replace(re,val);if(next!==out){changed=true;out=next}}
const obj=/((?:const|let)\s+message\s*=\s*\{)/.exec(out);if(obj){const at=out.indexOf('\n',obj.index);const inject=`\n        ${MARK}\n        if (message && message.__x_id) delete message.__x_id;`;out=out.slice(0,at)+inject+out.slice(at);changed=true}else result.notes.push('لم يوجد كائن رسالة بالصيغة القديمة؛ سيتم الاعتماد على طبقة الإرسال fallback.');
if(changed){const tmp=file+'.chatbot.tmp';fs.writeFileSync(tmp,out,'utf8');fs.renameSync(tmp,file);result.changed.push(path.basename(file))}else result.notes.push('لا تغيير مطبق على Utils.js.');return result}catch(e){result.ok=false;result.notes.push(e.message||String(e));return result}}
module.exports={patch,MARK};
