'use strict';
/** 同传记录：按天存 jsonl，供控制台查看 / 导出。 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'transcript');
const pad = (n) => String(n).padStart(2, '0');

function ensure() { fs.mkdirSync(DIR, { recursive: true }); }
function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fileFor(date) { return path.join(DIR, `${date}.jsonl`); }

function append(rec) {
  const en = String(rec.en || '').trim();
  const zh = String(rec.zh || '').trim();
  if (!en && !zh) return null;
  ensure();
  const now = new Date();
  const row = { t: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`, en, zh };
  try { fs.appendFileSync(fileFor(dayKey(now)), JSON.stringify(row) + '\n', 'utf8'); } catch { return null; }
  return row;
}

function list() {
  ensure();
  let names = [];
  try { names = fs.readdirSync(DIR); } catch { return []; }
  return names
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort()
    .reverse()
    .map((f) => {
      const date = f.slice(0, 10);
      let count = 0;
      try { count = fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter(Boolean).length; } catch {}
      return { date, count };
    });
}

function load(date) {
  const f = fileFor(date);
  if (!fs.existsSync(f)) return [];
  let txt = '';
  try { txt = fs.readFileSync(f, 'utf8'); } catch { return []; }
  return txt.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function toMarkdown(date) {
  const rows = load(date);
  const head = `# 同传记录 ${date}\n\n共 ${rows.length} 条\n\n`;
  return head + rows.map((r) => `- **${r.t}**  ${r.en}\n  - ${r.zh}`).join('\n') + '\n';
}

module.exports = { append, list, load, toMarkdown, dayKey, DIR };
