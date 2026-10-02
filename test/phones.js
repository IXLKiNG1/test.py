'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
assert.equal(pkg.dependencies['libphonenumber-js'], '1.13.13');
try {
  const phones = require('../src/phones');
  const om = phones.parse('9XXXXXXX'.replace(/X/g, '0'), 'OM');
  assert.equal(om.country, 'OM');
  const ae = phones.parse('+971501234567');
  assert.equal(ae.country, 'AE');
  const fr = phones.parse('+33612345678');
  assert.equal(fr.country, 'FR');
  const ar = phones.parse('٩١٢٣٤٥٦٧', 'OM');
  assert.equal(ar.country, 'OM');
  assert.ok(phones.countries().some(x => x.code === 'OM'));
  assert.ok(phones.countries().some(x => x.code === 'US'));
  assert.throws(() => phones.parse('+999111222333'));
  console.log('PASS  international phone parsing and country coverage');
} catch (error) {
  if (error?.code === 'MODULE_NOT_FOUND' && /libphonenumber-js/.test(error.message)) {
    console.log('SKIP  international phone runtime test (dependencies not installed in audit environment)');
  } else {
    console.error(`FAIL  international phone runtime test: ${error.message}`);
    process.exitCode = 1;
  }
}
