#!/usr/bin/env node
'use strict';
/**
 * 把 ECDICT 的 ecdict.csv 转成自带的 dict.bin（偏移索引 + 二分查找）。
 * 不依赖任何原生模块，运行时只读这个文件。
 *
 * 文件布局：
 *   [0]  magic  'LLD1'
 *   [4]  u32    count
 *   [8]  u32    recordsOffset
 *   [12] u32    keysOffset
 *   [16] u32    keysLen
 *   [20] u32    indexOffset
 *   ...  records blob（每条记录是 UTF-8 JSON，紧凑键名）
 *   ...  keys    blob（每条 = 小写词的 UTF-8 字节）
 *   ...  index   blob（每条 16 字节：keyOff u32 | keyLen u16 | pad u16 | recOff u32 | recLen u32）
 *
 * 用法：node core/dict-build.js data/ecdict.csv data/dict.bin
 */
const fs = require('fs');
const path = require('path');

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQ = false; }
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const num = (s) => {
  const n = parseInt(String(s || '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function main() {
  const src = process.argv[2] || path.join(__dirname, '..', 'data', 'ecdict.csv');
  const out = process.argv[3] || path.join(__dirname, '..', 'data', 'dict.bin');

  console.log('reading', src);
  const text = fs.readFileSync(src, 'utf8').replace(/^\uFEFF/, '');
  console.log('parsing csv', (text.length / 1024 / 1024).toFixed(1), 'MB');
  const rows = parseCSV(text);
  const header = rows.shift().map((h) => h.trim());
  const col = (name) => header.indexOf(name);
  const C = {
    word: col('word'), phonetic: col('phonetic'), definition: col('definition'),
    translation: col('translation'), pos: col('pos'), collins: col('collins'),
    oxford: col('oxford'), tag: col('tag'), bnc: col('bnc'), frq: col('frq'),
    exchange: col('exchange'),
  };

  const byKey = new Map();
  let skipped = 0;
  for (const r of rows) {
    const word = (r[C.word] || '').trim();
    if (!word || !/^[A-Za-z][A-Za-z'’.\- ]*$/.test(word)) { skipped++; continue; }
    const key = word.toLowerCase();
    const rec = {
      w: word,
      ph: (r[C.phonetic] || '').trim(),
      tr: (r[C.translation] || '').replace(/\\n/g, '\n').trim(),
      df: (r[C.definition] || '').trim(),
      pos: (r[C.pos] || '').trim(),
      col: num(r[C.collins]),
      oxf: num(r[C.oxford]),
      tag: (r[C.tag] || '').trim(),
      bnc: num(r[C.bnc]),
      frq: num(r[C.frq]),
      ex: (r[C.exchange] || '').trim(),
    };
    // 同一个词多行时，留信息量最大的那条
    const prev = byKey.get(key);
    if (!prev || score(rec) > score(prev)) byKey.set(key, rec);
  }

  const keys = [...byKey.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const keyBufs = keys.map((k) => Buffer.from(k));
  const recBufs = keys.map((k) => Buffer.from(JSON.stringify(byKey.get(k))));
  const keyBlob = Buffer.concat(keyBufs);
  const recBlob = Buffer.concat(recBufs);

  const idx = Buffer.alloc(keys.length * 16);
  let recOff = 0;
  let keyOff = 0;
  for (let i = 0; i < keys.length; i++) {
    idx.writeUInt32LE(keyOff, i * 16);
    idx.writeUInt16LE(keyBufs[i].length, i * 16 + 4);
    idx.writeUInt32LE(recOff, i * 16 + 8);
    idx.writeUInt32LE(recBufs[i].length, i * 16 + 12);
    keyOff += keyBufs[i].length;
    recOff += recBufs[i].length;
  }

  const head = Buffer.alloc(20);
  head.write('LLD1', 0, 'ascii');
  head.writeUInt32LE(keys.length, 4);
  head.writeUInt32LE(24, 8);
  head.writeUInt32LE(24 + recBlob.length, 12);
  head.writeUInt32LE(keyBlob.length, 16);
  const indexOffset = 24 + recBlob.length + keyBlob.length;
  // indexOffset 放不进 head 的 20 字节，追加到末尾前先写进 idx 头？改成：head[20..24) 存 indexOffset
  const head2 = Buffer.alloc(24);
  head.copy(head2, 0);
  head2.writeUInt32LE(indexOffset, 20);

  fs.writeFileSync(out, Buffer.concat([head2, recBlob, keyBlob, idx]));
  const st = fs.statSync(out);
  console.log(`ok  ${keys.length} words  skipped=${skipped}`);
  console.log(`    ${out}  ${(st.size / 1024 / 1024).toFixed(1)} MB`);
}

function score(r) {
  return (r.tr ? 3 : 0) + (r.df ? 1 : 0) + (r.ph ? 1 : 0) + (r.col ? 2 : 0) + (r.frq ? 1 : 0);
}

main();
