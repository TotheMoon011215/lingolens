'use strict';
/** DeepSeek 调用：流式 JSON，边到边解析，先出"语境义"，再补细节。 */
const config = require('./config');

const SYSTEM = `你是一名面向中文母语者的英语词典编辑。用户会给你一个英文词或短语，以及它出现的上下文。你输出严格的 JSON。

规则：
- 中文释义简洁，像词典，不写套话。
- 有上下文时，gloss 必须写"它在这个句子里是什么意思"，不要罗列全部义项。
- 英文释义（en）控制在 15 词以内，用学习者看得懂的词。
- 音标、词源、词频这类你不确定的字段一律留空字符串，绝对不许猜。
- 例句要地道、短，配中文翻译。
- 只输出 JSON 对象本身，不要 markdown 代码块，不要任何解释。

JSON 结构（字段不可增删）：
{"gloss":"一句话中文语境义","senses":[{"pos":"adj.","zh":"中文释义","en":"English definition"}],"examples":[{"en":"例句","zh":"译文"}],"collocations":["搭配"],"family":["同族词"],"compare":"与近义词的区别，一句话","note":"中式英语或常见错误提示，没有就空"}`;

const USER = (word, context, kind) =>
  `词：${word}\n` +
  (context ? `上下文：${context}\n` : '') +
  `类型：${kind}\n` +
  `请输出 JSON。`;

/** 从半截 JSON 里抠出已经完整的字段，用于流式提前渲染 */
function pluck(text, field) {
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const m = text.match(re);
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
}

function stripFences(s) {
  return s.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
}

/**
 * @param {object} opts
 * @param {(patch:object)=>void} opts.onPartial  收到部分字段
 * @returns {Promise<{parsed:object|null, raw:string, ms:number}>}
 */
async function streamLookup({ word, context = '', kind = 'word', onPartial = () => {} }) {
  const cfg = config.load();
  if (!cfg.apiKey) {
    const err = new Error('NO_KEY');
    err.code = 'NO_KEY';
    throw err;
  }

  const t0 = Date.now();
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      thinking: { type: 'disabled' },
      temperature: 0.3,
      response_format: { type: 'json_object' },
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: USER(word, context, kind) },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`DS ${res.status}: ${body.slice(0, 200)}`);
    err.code = 'HTTP';
    throw err;
  }

  let acc = '';
  let sentGloss = false;
  let sentSenses = false;
  const decoder = new TextDecoder();
  let buf = '';

  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let json;
        try { json = JSON.parse(payload); } catch { continue; }
        const delta = json.choices?.[0]?.delta?.content;
        if (!delta) continue;
        acc += delta;

        if (!sentGloss) {
          const g = pluck(acc, 'gloss');
          if (g) { sentGloss = true; onPartial({ gloss: g }); }
        }
        if (!sentSenses) {
          const s = pluck(acc, 'note'); // 用后面字段出现判断整体接近完成
          if (s !== null) { sentSenses = true; }
        }
      }
    }
  }

  const raw = stripFences(acc);
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* 交给调用方兜底 */ }
  return { parsed, raw, ms: Date.now() - t0 };
}

const TRANSLATE_SYSTEM = `你是英译中翻译。把用户给的英文翻成自然、准确的中文。

规则：
- 只输出译文本身，不要引号、不要原文、不要任何解释。
- 口语就译得口语，技术词保留常用英文原名（如 API、GPU）。
- 多行文本按原顺序翻，保留换行。`;

/** 纯文本流式翻译（截图取词用）：不要 JSON，首字更快 */
async function translate(text, onDelta = () => {}) {
  const cfg = config.load();
  if (!cfg.apiKey) {
    const err = new Error('NO_KEY');
    err.code = 'NO_KEY';
    throw err;
  }
  const t0 = Date.now();
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      thinking: { type: 'disabled' },
      temperature: 0.2,
      stream: true,
      messages: [
        { role: 'system', content: TRANSLATE_SYSTEM },
        { role: 'user', content: text },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`DS ${res.status}`);

  const decoder = new TextDecoder();
  let buf = '';
  let out = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const d = j.choices?.[0]?.delta?.content;
          if (d) { out += d; onDelta(d); }
        } catch {}
      }
    }
  }
  return { text: out.trim(), ms: Date.now() - t0 };
}

module.exports = { streamLookup, translate, SYSTEM };
