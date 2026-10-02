'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { patchUtils, MARKERS } = require('../scripts/patch-whatsapp');

const fixture = `
const message = {
    ...options,
    id: newMsgKey,
    ...mediaOptions,
    ...(mediaOptions.toJSON ? mediaOptions.toJSON() : {}),
    ...quotedMsgOptions,
    ...extraOptions,
};
// Bot's won't reply if canonicalUrl is set (linking)
if (botOptions) {
    delete message.canonicalUrl;
}
return window
    .require('WAWebCollections')
    .Msg.get(newMsgKey._serialized);
`;
const out = patchUtils(fixture).source;
if (!out.includes(MARKERS.media)) throw new Error('marker missing');
if (!out.includes('if (message && message.__x_id) delete message.__x_id;')) throw new Error('__x_id fix missing');
if (!out.includes('.Msg.get(newMsgKey._serialized || newMsgKey.$1);')) throw new Error('message-id fallback missing');
const before = out.indexOf(MARKERS.media);
const close = out.lastIndexOf('};', before + 1);
const open = out.lastIndexOf('const message = {', before);
if (close < open) throw new Error('patch landed inside object literal');
new Function(out); // syntax check
console.log('PASS  compatibility patch placement + syntax');

// Verify idempotence.
const second = patchUtils(out);
if (second.changed) throw new Error('patch is not idempotent');
console.log('PASS  compatibility patch idempotence');
