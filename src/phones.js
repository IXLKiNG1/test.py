"use strict";
const {parsePhoneNumberFromString,getCountries,getCountryCallingCode}=require('libphonenumber-js');
function normalizeDigits(v){return String(v||'').replace(/[٠-٩۰-۹]/g,d=>String('٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹'.indexOf(d)%10));}
function parse(input,country='OM'){
  let raw=normalizeDigits(input).trim();
  if(!raw)throw new Error('اكتب رقم الهاتف.');
  if(/^00\d+/.test(raw))raw='+'+raw.slice(2);
  const hint=String(country||'OM').trim().toUpperCase();
  const p=parsePhoneNumberFromString(raw.startsWith('+')?raw:raw,hint||'OM');
  if(!p||!p.isValid())throw new Error('رقم الهاتف غير صالح. استخدم +رمز_الدولة للرقم الدولي.');
  const digits=p.number.replace(/\D/g,'');
  return {digits,country:p.country||hint,callingCode:String(p.countryCallingCode||''),international:p.formatInternational(),national:p.formatNational(),formatted:p.formatInternational()};
}
function tryParse(input,country='OM'){try{return{ok:true,...parse(input,country)}}catch(e){return{ok:false,error:e.message}}}
function flag(code){return String(code||'').toUpperCase().replace(/[A-Z]/g,c=>String.fromCodePoint(127397+c.charCodeAt(0)))}
function countries(){const names=new Intl.DisplayNames(['ar'],{type:'region'});return getCountries().map(code=>({code,callingCode:String(getCountryCallingCode(code)),name:names.of(code)||code,flag:flag(code)})).sort((a,b)=>(a.name||a.code).localeCompare(b.name||b.code,'ar'));}
module.exports={parse,tryParse,countries};
