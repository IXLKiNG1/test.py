'use strict';

const parsePhoneNumberFromString = require('libphonenumber-js/max').default;
const { getCountries, getCountryCallingCode } = require('libphonenumber-js/max');

const REGION_LABELS = new Intl.DisplayNames(['ar'], { type: 'region' });
const EN_REGION_LABELS = new Intl.DisplayNames(['en'], { type: 'region' });
let COUNTRY_CACHE = null;

function normalizeDigits(value) {
  return String(value ?? '')
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
}

function cleanInput(value) {
  return normalizeDigits(value)
    .normalize('NFKC')
    .replace(/[\u200E\u200F\u202A-\u202E]/g, '')
    .trim();
}

function flag(country) {
  if (!/^[A-Z]{2}$/u.test(country || '')) return '🌐';
  return [...country].map(ch => String.fromCodePoint(127397 + ch.charCodeAt(0))).join('');
}

function countryName(country) {
  try {
    return REGION_LABELS.of(country) || EN_REGION_LABELS.of(country) || country;
  } catch {
    return country;
  }
}

function countries() {
  if (COUNTRY_CACHE) return COUNTRY_CACHE;
  COUNTRY_CACHE = getCountries()
    .map(country => ({
      code: country,
      name: countryName(country),
      englishName: EN_REGION_LABELS.of(country) || country,
      flag: flag(country),
      callingCode: getCountryCallingCode(country)
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  return COUNTRY_CACHE;
}

function parse(input, defaultCountry = 'OM') {
  const raw = cleanInput(input);
  if (!raw) throw new Error('اكتب رقم الهاتف.');
  let candidate = raw.replace(/[()\-\s.]/g, '');
  if (candidate.startsWith('00')) candidate = `+${candidate.slice(2)}`;
  const phone = parsePhoneNumberFromString(candidate, defaultCountry || undefined);
  if (!phone) throw new Error('تعذر فهم رقم الهاتف. استخدم صيغة دولية مثل +968 9XXXXXXX أو اختر الدولة واكتب الرقم المحلي.');
  if (!phone.isPossible()) throw new Error('طول الرقم غير ممكن لهذه الدولة. تحقق من الرقم ورمز الدولة.');
  if (!phone.isValid()) throw new Error('رقم الهاتف غير صالح لهذه الدولة. تحقق من الرقم.');
  const country = phone.country || null;
  return {
    input: raw,
    e164: phone.number,
    digits: phone.number.replace(/^\+/, ''),
    country,
    callingCode: phone.countryCallingCode,
    national: phone.formatNational(),
    international: phone.formatInternational(),
    type: typeof phone.getType === 'function' ? (phone.getType() || null) : null
  };
}

function tryParse(input, defaultCountry = 'OM') {
  try { return { ok: true, ...parse(input, defaultCountry) }; }
  catch (error) { return { ok: false, error: error.message || String(error) }; }
}

module.exports = {
  normalizeDigits,
  cleanInput,
  countries,
  parse,
  tryParse,
  flag,
  countryName
};
