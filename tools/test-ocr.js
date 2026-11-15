#!/usr/bin/env node
'use strict';
/** 验证 OCR：node tools/test-ocr.js <图片路径> */
const path = require('path');
const ocr = require('../core/ocr');

(async () => {
  const img = process.argv[2] || path.join(__dirname, '..', 'data', 'ocr-test.png');
  const t0 = Date.now();
  const r = await ocr.recognize(img);
  const cold = Date.now() - t0;

  const t1 = Date.now();
  await ocr.recognize(img);
  const warm = Date.now() - t1;

  console.log('cold total:', cold, 'ms (含模型加载)');
  console.log('warm total:', warm, 'ms');
  console.log('ocr.ms:', r.ms, 'ms');
  console.log('words:', r.words.length);
  console.log('text:', JSON.stringify(r.text.trim()));
  console.log('first 8 words:');
  for (const w of r.words.slice(0, 8)) {
    console.log(`  ${w.text.padEnd(14)} conf=${String(w.conf).padStart(3)}  x0=${w.bbox.x0} y0=${w.bbox.y0} x1=${w.bbox.x1} y1=${w.bbox.y1}`);
  }
  await ocr.terminate();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
