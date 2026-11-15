'use strict';
/**
 * 本地词库查询：内存里只放 keys + index（约 20MB），记录按需从磁盘读。
 * 单次查询 1 次 fs.readSync，实测亚毫秒。
 */
const fs = require('fs');

const MAGIC = 'LLD1';

class Dict {
  constructor(file) {
    this.fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(24);
    fs.readSync(this.fd, head, 0, 24, 0);
    if (head.toString('ascii', 0, 4) !== MAGIC) throw new Error('dict.bin 格式不对');
    this.count = head.readUInt32LE(4);
    this.recOff = head.readUInt32LE(8);
    this.keysOff = head.readUInt32LE(12);
    this.keysLen = head.readUInt32LE(16);
    this.indexOff = head.readUInt32LE(20);

    this.keys = Buffer.alloc(this.keysLen);
    fs.readSync(this.fd, this.keys, 0, this.keysLen, this.keysOff);
    this.index = Buffer.alloc(this.count * 16);
    fs.readSync(this.fd, this.index, 0, this.count * 16, this.indexOff);
    this.cache = new Map();
  }

  keyAt(i) {
    const off = this.index.readUInt32LE(i * 16);
    const len = this.index.readUInt16LE(i * 16 + 4);
    return this.keys.subarray(off, off + len);
  }

  recAt(i) {
    const off = this.recOff + this.index.readUInt32LE(i * 16 + 8);
    const len = this.index.readUInt32LE(i * 16 + 12);
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(this.fd, buf, 0, len, off);
    return JSON.parse(buf.toString('utf8'));
  }

  find(q) {
    let lo = 0;
    let hi = this.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = Buffer.compare(this.keyAt(mid), q);
      if (c === 0) return mid;
      if (c < 0) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }

  lookup(word) {
    const norm = normalize(word);
    if (!norm) return null;
    if (this.cache.has(norm)) return this.cache.get(norm);

    let rec = null;
    for (const cand of candidates(norm)) {
      const i = this.find(Buffer.from(cand));
      if (i >= 0) { rec = this.recAt(i); if (cand !== norm) rec = { ...rec, inflected: true, form: norm }; break; }
    }
    if (this.cache.size > 3000) this.cache.clear();
    this.cache.set(norm, rec);
    return rec;
  }
}

/** 去掉标点、弯引号，转小写 */
function normalize(w) {
  if (!w) return '';
  return String(w)
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/^[^A-Za-z]+|[^A-Za-z']+$/g, '')
    .trim()
    .toLowerCase();
}

/** 简单词形回退：查不到时按常见规则还原（够用，不做完整词法） */
function candidates(w) {
  const out = [w];
  const add = (s) => { if (s && s.length > 1 && !out.includes(s)) out.push(s); };
  if (w.endsWith("'s")) add(w.slice(0, -2));
  if (w.endsWith('ies')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('ves')) add(w.slice(0, -3) + 'f'), add(w.slice(0, -3) + 'fe');
  if (w.endsWith('es')) add(w.slice(0, -2));
  if (w.endsWith('s')) add(w.slice(0, -1));
  if (w.endsWith('ied')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('ed')) { add(w.slice(0, -2)); add(w.slice(0, -1)); }
  if (w.endsWith('ing')) { add(w.slice(0, -3)); add(w.slice(0, -3) + 'e'); }
  if (w.endsWith('ly')) add(w.slice(0, -2));
  if (w.endsWith('er')) { add(w.slice(0, -2)); add(w.slice(0, -1)); }
  if (w.endsWith('est')) { add(w.slice(0, -3)); add(w.slice(0, -2)); }
  if (w.length > 3 && w[w.length - 1] === w[w.length - 2]) add(w.slice(0, -1)); // running -> runn
  return out;
}

module.exports = { Dict, normalize };
