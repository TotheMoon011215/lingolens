#!/usr/bin/env node
'use strict';
/**
 * 把 lucide-static 里用到的图标抽成 ui/icons.js（内联 SVG，离线可用）。
 * 用法：node tools/build-icons.js
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'node_modules', 'lucide-static', 'icons');
const OUT = path.join(__dirname, '..', 'ui', 'icons.js');

const NAMES = [
  'house', 'captions', 'settings', 'mouse-pointer-2', 'scan-line', 'keyboard',
  'audio-lines', 'history', 'play', 'square', 'mic', 'x', 'minus', 'maximize-2',
  'chevron-right', 'chevron-down', 'arrow-up-right', 'copy', 'check', 'trash-2',
  'calendar', 'download', 'circle-dot', 'loader',
];

const out = {};
for (const name of NAMES) {
  const file = path.join(SRC, `${name}.svg`);
  if (!fs.existsSync(file)) { console.warn('missing', name); continue; }
  const svg = fs.readFileSync(file, 'utf8');
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '').trim()
    .replace(/\s+/g, ' ');
  out[name] = inner;
}

const body = `// 由 tools/build-icons.js 生成，勿手改。图标来自 Lucide（ISC License）。
window.ICONS = ${JSON.stringify(out, null, 2)};

window.mountIcons = function mountIcons(root) {
  (root || document).querySelectorAll('[data-icon]').forEach(function (el) {
    var name = el.getAttribute('data-icon');
    var inner = window.ICONS[name];
    if (!inner || el.firstChild) return;
    el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" '
      + 'stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' + inner + '</svg>';
  });
};
`;

fs.writeFileSync(OUT, body, 'utf8');
console.log(`wrote ${OUT}  (${Object.keys(out).length} icons, ${(body.length / 1024).toFixed(1)} KB)`);
