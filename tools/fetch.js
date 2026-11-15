#!/usr/bin/env node
'use strict';
/**
 * 分片并行下载。部分网络环境下单连接会被限速到 ~50KB/s，多并发能跑满带宽。
 * 用法: node tools/fetch.js <url> <out> [parts]
 */
const fs = require('fs');
const path = require('path');

async function head(url) {
  const r = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  if (!r.ok) throw new Error(`HEAD ${r.status}`);
  return {
    size: Number(r.headers.get('content-length') || 0),
    ranges: (r.headers.get('accept-ranges') || '') === 'bytes',
  };
}

async function part(url, start, end, attempt = 0) {
  try {
    const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length !== end - start + 1) throw new Error(`short read ${buf.length}/${end - start + 1}`);
    return buf;
  } catch (e) {
    if (attempt >= 3) throw e;
    await new Promise((res) => setTimeout(res, 600 * (attempt + 1)));
    return part(url, start, end, attempt + 1);
  }
}

async function main() {
  const [url, out, partsArg] = process.argv.slice(2);
  if (!url || !out) throw new Error('usage: fetch.js <url> <out> [parts]');
  const parts = Math.max(1, parseInt(partsArg || '8', 10));

  const { size, ranges } = await head(url);
  if (!size) throw new Error('no content-length');
  fs.mkdirSync(path.dirname(out), { recursive: true });

  if (!ranges || parts === 1) {
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    fs.writeFileSync(out, buf);
    console.log(`done (single) ${(buf.length / 1048576).toFixed(1)} MB`);
    return;
  }

  const chunk = Math.ceil(size / parts);
  const ranges2 = Array.from({ length: parts }, (_, i) => [i * chunk, Math.min((i + 1) * chunk - 1, size - 1)])
    .filter(([s, e]) => s <= e);

  const t0 = Date.now();
  let done = 0;
  const bufs = await Promise.all(ranges2.map(async ([s, e], i) => {
    const b = await part(url, s, e);
    done += b.length;
    process.stdout.write(`\r  part ${i + 1}/${ranges2.length}  ${(done / 1048576).toFixed(1)}/${(size / 1048576).toFixed(1)} MB`);
    return b;
  }));
  const all = Buffer.concat(bufs);
  fs.writeFileSync(out, all);
  const secs = (Date.now() - t0) / 1000;
  console.log(`\ndone ${(all.length / 1048576).toFixed(1)} MB in ${secs.toFixed(1)}s = ${(all.length / 1024 / secs).toFixed(0)} KB/s`);
}

main().catch((e) => { console.error('FETCH FAILED:', e.message); process.exit(1); });
