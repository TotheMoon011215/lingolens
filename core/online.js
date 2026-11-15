'use strict';
/** 在线词典（Wiktionary via dictionaryapi.dev）：IPA + 真人 mp3 + 英文释义。免 key。 */

const mem = new Map();

async function fetchEntry(word) {
  const key = word.toLowerCase();
  if (mem.has(key)) return mem.get(key);

  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
  let data;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) { mem.set(key, null); return null; }
    data = await res.json();
  } catch {
    return null; // 网络失败不缓存，下次再试
  }
  const e = Array.isArray(data) ? data[0] : null;
  if (!e) { mem.set(key, null); return null; }

  const out = {
    word: e.word,
    phonetics: (e.phonetics || [])
      .filter((p) => p.text || p.audio)
      .map((p) => ({ text: p.text || '', audio: p.audio || '', accent: accentOf(p.audio) })),
    meanings: (e.meanings || []).map((m) => ({
      pos: m.partOfSpeech || '',
      defs: (m.definitions || []).slice(0, 3).map((d) => d.definition).filter(Boolean),
      synonyms: (m.synonyms || []).slice(0, 5),
    })),
  };
  if (mem.size > 500) mem.clear();
  mem.set(key, out);
  return out;
}

function accentOf(audio = '') {
  if (/-uk\./i.test(audio)) return 'uk';
  if (/-us\./i.test(audio)) return 'us';
  if (/-au\./i.test(audio)) return 'au';
  return '';
}

/** 挑出发音链接：优先指定口音，其次任意 */
function pickAudio(entry, accent = 'us') {
  if (!entry || !entry.phonetics) return '';
  const withAudio = entry.phonetics.filter((p) => p.audio);
  const exact = withAudio.find((p) => p.accent === accent);
  return (exact || withAudio[0] || {}).audio || '';
}

function pickIpa(entry, accent = 'us') {
  if (!entry || !entry.phonetics) return '';
  const withText = entry.phonetics.filter((p) => p.text);
  const exact = withText.find((p) => p.accent === accent);
  const any = exact || withText[0];
  return any ? any.text : '';
}

module.exports = { fetchEntry, pickAudio, pickIpa };
