'use strict';
/**
 * 查词编排：本地词典立刻出，在线词典并行补发音/英文释义，DeepSeek 流式补语境义。
 * 任何一路失败都不阻塞其它路。
 */
const path = require('path');
const { Dict } = require('./dict');
const online = require('./online');
const llm = require('./llm');
const config = require('./config');

let dict = null;
function getDict() {
  if (dict) return dict;
  const file = path.join(__dirname, '..', 'data', 'dict.bin');
  dict = new Dict(file);
  return dict;
}

const WORD_RE = /^[A-Za-z][A-Za-z'’\- ]{0,48}$/;

const POS_MAP = {
  a: 'adj.', adj: 'adj.', ad: 'adv.', adv: 'adv.', n: 'n.', v: 'v.',
  vt: 'v.t.', vi: 'v.i.', prep: 'prep.', conj: 'conj.', pron: 'pron.',
  num: 'num.', art: 'art.', int: 'int.', aux: 'aux.', abbr: 'abbr.', pl: 'pl.',
};

/** ECDICT 的 translation 常把词性写在开头（"a. 无所不在的"），拆出来单独显示 */
function splitPos(tr, posField) {
  let pos = String(posField || '').trim();
  let text = String(tr || '').trim();
  const m = text.match(/^([A-Za-z]{1,5})\.\s+/);
  if (m) {
    const mapped = POS_MAP[m[1].toLowerCase()];
    if (mapped) {
      if (!pos) pos = mapped;
      text = text.slice(m[0].length);
    }
  }
  return { pos, text };
}

function classify(text) {
  const t = String(text || '').trim();
  if (!t) return { kind: 'empty' };
  if (WORD_RE.test(t) && t.split(/\s+/).length <= 3) return { kind: 'word', word: t };
  return { kind: 'phrase', word: t };
}

/**
 * @param {string} text 选中的词/短语
 * @param {object} opts { context, onEvent }
 */
async function lookup(text, { context = '', onEvent = () => {} } = {}) {
  const { kind, word } = classify(text);
  if (kind === 'empty') { onEvent({ type: 'error', message: '没有选中文字' }); return; }

  const single = kind === 'word';
  const accent = config.get('accent') || 'us';

  // 1) 本地词典：同步、亚毫秒
  let local = null;
  try {
    local = getDict().lookup(word);
  } catch (e) {
    onEvent({ type: 'error', message: `词库打不开：${e.message}` });
  }

  // 2) 在线词典：只对单词查
  const onlineP = single
    ? online.fetchEntry(word).then((o) => {
        if (o) {
          onEvent({
            type: 'online',
            ipa: online.pickIpa(o, accent),
            audio: online.pickAudio(o, accent),
            meanings: o.meanings,
          });
        }
        return o;
      }).catch(() => null)
    : Promise.resolve(null);

  const parsed = splitPos(local && local.tr, local && local.pos);
  onEvent({
    type: 'local',
    word: local ? local.w : word,
    phonetic: (local && local.ph) || '',
    translation: local ? parsed.text : '',
    pos: local ? parsed.pos : '',
    tags: (local && local.tag) || '',
    collins: (local && local.col) || 0,
    oxford: (local && local.oxf) || 0,
    freq: (local && local.frq) || 0,
    exchange: (local && local.ex) || '',
    inflected: Boolean(local && local.inflected),
  });

  // 3) DeepSeek：流式
  let ai = null;
  if (config.hasKey()) {
    try {
      const r = await llm.streamLookup({
        word,
        context,
        kind,
        onPartial: (p) => onEvent({ type: 'ai-partial', ...p }),
      });
      ai = r.parsed;
      onEvent({ type: 'ai', data: ai, raw: ai ? null : r.raw, ms: r.ms });
    } catch (e) {
      onEvent({ type: 'error', message: e.code === 'NO_KEY' ? '还没填 API key' : `AI 出错：${e.message}` });
    }
  } else {
    onEvent({ type: 'error', message: '还没填 API key（点右上角设置）' });
  }

  await onlineP;
  onEvent({ type: 'done' });
  return { local, ai };
}

module.exports = { lookup, classify, getDict };
