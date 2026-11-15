#!/usr/bin/env node
'use strict';
/** 用本地假 SSE 服务验证流式 JSON 解析，不消耗真实额度 */
const http = require('http');
const path = require('path');
const config = require('../core/config');
const llm = require('../core/llm');

const SAMPLE = JSON.stringify({
  gloss: '无处不在的',
  senses: [
    { pos: 'adj.', zh: '普遍存在的；到处可见的', en: 'seeming to be everywhere at once' },
    { pos: 'adj.', zh: '（生）同地兼生的', en: 'biology: growing everywhere' },
  ],
  examples: [
    { en: 'Smartphones are ubiquitous in Asia.', zh: '智能手机在亚洲无处不在。' },
    { en: 'The surveillance is ubiquitous.', zh: '监控无处不在。' },
  ],
  collocations: ['~ in', 'become ~', 'the ~ nature of'],
  family: ['ubiquity n.', 'ubiquitously adv.'],
  compare: 'ubiquitous 强调“到处都有”，universal 强调“全部适用”。',
  note: '',
});

function sse(chunk) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`;
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let i = 0;
    const step = 17;
    const tick = () => {
      if (i >= SAMPLE.length) { res.write('data: [DONE]\n\n'); res.end(); return; }
      res.write(sse(SAMPLE.slice(i, i + step)));
      i += step;
      setTimeout(tick, 5);
    };
    tick();
  });
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const before = config.load();
  config.set({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key' });

  let partial = 0;
  try {
    const r = await llm.streamLookup({
      word: 'ubiquitous',
      context: 'The surveillance is ubiquitous.',
      kind: 'word',
      onPartial: (p) => { partial++; console.log('  partial ->', p); },
    });
    console.log('parsed:', r.parsed ? 'OK' : 'NULL');
    console.log('  gloss:', r.parsed && r.parsed.gloss);
    console.log('  senses:', r.parsed && r.parsed.senses.length);
    console.log('  examples:', r.parsed && r.parsed.examples.length);
    console.log('  partial events:', partial);
    console.log('  first-token gloss fast path:', partial > 0 ? 'YES' : 'NO');
  } catch (e) {
    console.log('FAILED', e.message);
  } finally {
    config.set({ baseUrl: before.baseUrl, apiKey: before.apiKey });
    server.close();
  }
});
