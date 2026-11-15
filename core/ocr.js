'use strict';
/**
 * 屏幕文字识别。tesseract.js 跑在 worker 里，模型是本地 2.8MB 的 eng（best_int）。
 * 返回的每个词带 bbox（像素坐标），用于把"冻结的画面"变成可悬停的图层。
 */
const path = require('path');
const { createWorker } = require('tesseract.js');

const DATA = path.join(__dirname, '..', 'data');
let workerPromise = null;
let ready = false;

function langPath(quality) {
  return path.join(DATA, quality === 'hq' ? 'tessdata-hq' : 'tessdata');
}

async function getWorker(quality = 'fast') {
  if (workerPromise) return workerPromise;
  workerPromise = createWorker('eng', 1, {
    langPath: langPath(quality),
    cachePath: path.join(DATA, 'tesscache'),
    gzip: true,
    logger: () => {},
  }).then((w) => { ready = true; return w; });
  return workerPromise;
}

/**
 * @param {string|Buffer} image 文件路径或图片 Buffer
 * @returns {Promise<{text:string, words:Array<{text:string,conf:number,bbox:{x0,y0,x1,y1}}>, ms:number}>}
 */
async function recognize(image, { quality = 'fast' } = {}) {
  const t0 = Date.now();
  const worker = await getWorker(quality);
  const { data } = await worker.recognize(image, {}, {
    text: true,
    blocks: true,
    hocr: false,
    tsv: false,
  });
  const words = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const w of line.words || []) {
          const text = (w.text || '').trim();
          if (!text) continue;
          if (w.confidence != null && w.confidence < 30) continue;
          words.push({ text, conf: Math.round(w.confidence || 0), bbox: w.bbox });
        }
      }
    }
  }
  return { text: data.text || '', words, ms: Date.now() - t0 };
}

async function terminate() {
  if (!workerPromise) return;
  try { (await workerPromise).terminate(); } catch {}
  workerPromise = null;
  ready = false;
}

function isReady() { return ready; }

module.exports = { recognize, terminate, isReady, langPath };
