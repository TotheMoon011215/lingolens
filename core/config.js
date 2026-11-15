'use strict';
/** 配置：先明文存项目根，P1 再换 DPAPI 加密 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'config.json');
const DEFAULTS = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  accent: 'us',        // us | uk
  hoverEnabled: true,
  hotkeys: { lookup: 'Alt+X', shot: 'Alt+S', input: 'Alt+Q', live: 'Alt+L' },
  // 同传引擎（已有的 Python 工程）
  speechRoot: 'D:\\文件\\2026AI\\同传',
  speechSource: 'system',   // system | microphone
  speechModel: '',          // 留空 = 用同传 config.json 里的 deepseek-chat
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  if (!cache.apiKey && process.env.DEEPSEEK_API_KEY) cache.apiKey = process.env.DEEPSEEK_API_KEY;
  return cache;
}

function get(key) { return load()[key]; }

function set(patch) {
  cache = { ...load(), ...patch };
  fs.writeFileSync(FILE, JSON.stringify(cache, null, 2), 'utf8');
  return cache;
}

function hasKey() { return Boolean(load().apiKey); }

module.exports = { get, set, load, hasKey, DEFAULTS };
