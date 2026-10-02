"use strict";
function normalizeGid(v){let s=String(v||'').trim().toLowerCase();s=s.replace(/^https?:\/\/[^/]+\//,'');s=s.replace(/^jid[:=]\s*/,'');if(/^\d+(?:-\d+)*$/.test(s))s+= '@g.us';if(!/^[0-9]+(?:-[0-9]+)*@g\.us$/i.test(s))throw new Error('GID غير صالح. استخدم مثل 123456789-123@g.us');return s;}
function isGroupId(v){return /^[0-9]+(?:-[0-9]+)*@g\.us$/i.test(String(v||'').trim().toLowerCase());}
function extractInviteCode(v){const s=String(v||'').trim(),m=s.match(/(?:https?:\/\/)?chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i);return m?m[1]:s.replace(/^https?:\/\//i,'').split(/[?#/\s]/)[0];}
function normalizeInfo(info,gid=''){return {name:String(info?.name||info?.subject||'مجموعة').slice(0,120),gid:String(info?.gid||gid||'').trim().toLowerCase(),inviteCode:String(info?.inviteCode||''),description:String(info?.description||'').slice(0,1000),owner:String(info?.owner||''),participantsCount:Number.isFinite(Number(info?.participantsCount??info?.size))?Number(info?.participantsCount??info?.size):null};}
function formatGroupAnalysis(info){const x=normalizeInfo(info);return `الاسم: ${x.name}\nGID: ${x.gid||'غير متاح'}\nالأعضاء: ${x.participantsCount??'غير معروف'}\nالمالك: ${x.owner||'غير معروف'}\nالوصف: ${x.description||'—'}\nرمز الدعوة: ${x.inviteCode||'غير متاح'}`;}
module.exports={normalizeGid,isGroupId,extractInviteCode,normalizeInfo,formatGroupAnalysis};
