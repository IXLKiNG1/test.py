'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');

function fail(msg) { throw new Error(msg); }
function pass(msg) { console.log(`PASS  ${msg}`); }

const buttonIds = [...html.matchAll(/<button\b[^>]*\bid="([^"]+)"/gi)].map(m => m[1]);
const inputIds = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/gi)].map(m => m[1]);

function duplicates(values) {
  const seen = new Set();
  const out = new Set();
  for (const value of values) {
    if (seen.has(value)) out.add(value);
    seen.add(value);
  }
  return [...out];
}

const dupButtons = duplicates(buttonIds);
if (dupButtons.length) fail(`duplicate button ids: ${dupButtons.join(', ')}`);
const dupInputs = duplicates(inputIds);
if (dupInputs.length) fail(`duplicate control ids: ${dupInputs.join(', ')}`);

const controlIds = [...new Set([...buttonIds, ...inputIds])];
const ignored = new Set(['assistantOrb']);
for (const id of controlIds) {
  if (ignored.has(id)) continue;
  const wired = new RegExp(`(?:\\$\\(['"]${id}['"]\\)|getElementById\\(['"]${id}['"]\\)|document\\.querySelector\\([^)]*#${id}[^)]*\\)|getElementById\\(['"]${id}['"]\\)\\?)`).test(scripts);
  const attributeWired = new RegExp(`id="${id}"[^>]*(?:data-page=|data-page-link=)`).test(html);
  if (!wired && !attributeWired) fail(`control is not wired: ${id}`);
}

if (!/data-page=/.test(html) || !/\[data-page\]/.test(scripts)) fail('navigation event delegation missing');
if (!/data-page-link/.test(html) || !/\[data-page-link\]/.test(scripts)) fail('shortcut navigation missing');
if (!/data-bg-mode/.test(html) || !/\[data-bg-mode\]/.test(scripts)) fail('background interactions missing');
if (!/data-preset/.test(html) || !/\[data-preset\]/.test(scripts)) fail('interaction presets missing');
if (!/AbortController/.test(scripts)) fail('frontend request timeout missing');
if (/setInterval\s*\(/.test(scripts)) fail('UI polling detected');
if (!/localStorage\.setItem\(['"]cb_theme/.test(scripts)) fail('theme persistence missing');

pass(`UI controls wired: ${controlIds.length}`);
pass('navigation, presets, backgrounds, request timeout and manual-refresh policy');
