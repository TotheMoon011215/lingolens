'use strict';
const { app, BrowserWindow, globalShortcut, Tray, Menu, ipcMain, screen, nativeImage, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const config = require('../core/config');
const { lookup } = require('../core/lookup');
const ocr = require('../core/ocr');
const llm = require('../core/llm');
const transcript = require('../core/transcript');
const Bridge = require('./bridge');
const Speech = require('./speech');

const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const LOG = path.join(__dirname, '..', 'data', 'app.log');

function log(...a) {
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${a.join(' ')}\n`); } catch {}
}
process.on('uncaughtException', (e) => log('UNCAUGHT', (e && e.stack) || e));
process.on('unhandledRejection', (e) => log('UNHANDLED', (e && e.stack) || e));

let win = null;
let tray = null;
let bridge = null;
let pinned = false;
let quitting = false;
let selWin = null;
let frozenWin = null;
let escBound = false;
let hoverTimer = null;
let liveWin = null;
let speech = null;
let homeWin = null;
let lastHotkeyFailures = [];
let trayRebuild = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bindEsc(on) {
  if (on && !escBound) {
    try { globalShortcut.register('Escape', closeAll); escBound = true; } catch {}
  } else if (!on && escBound) {
    try { globalShortcut.unregister('Escape'); } catch {}
    escBound = false;
  }
}

function closeAll() {
  try { if (win) win.hide(); } catch {}
  hideFrozen();
  bindEsc(false);
}

function createWindow() {
  win = new BrowserWindow({
    width: 430,
    height: 380,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  win.webContents.on('did-finish-load', () => log('did-finish-load'));
  win.webContents.on('render-process-gone', (_e, d) => log('render-gone', JSON.stringify(d)));
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  win.on('blur', () => {
    if (!pinned && !win.webContents.isDevToolsOpened()) win.hide();
  });
}

function placeNearCursor(w = 430, h = 380) {
  const pt = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(pt);
  const margin = 8;
  const x = Math.max(d.workArea.x + margin, Math.min(pt.x + 18, d.workArea.x + d.workArea.width - w - margin));
  const y = Math.max(d.workArea.y + margin, Math.min(pt.y + 18, d.workArea.y + d.workArea.height - h - margin));
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h });
}

function showInput() {
  placeNearCursor();
  win.show();
  win.focus();
  win.webContents.send('mode', { mode: 'input' });
}

async function showLookup(text) {
  const t = String(text || '').trim();
  if (!t) return;
  placeNearCursor();
  win.showInactive();
  win.webContents.send('mode', { mode: 'lookup', text: t });
  log('lookup', t);
  await lookup(t, {
    onEvent: (e) => { if (win && !win.isDestroyed()) win.webContents.send('lookup:event', e); },
  });
  log('lookup-done', t);
}

function placeAt(x, y, w = 430, h = 380) {
  const d = screen.getDisplayNearestPoint({ x, y });
  const margin = 8;
  const nx = Math.max(d.workArea.x + margin, Math.min(x, d.workArea.x + d.workArea.width - w - margin));
  const ny = Math.max(d.workArea.y + margin, Math.min(y, d.workArea.y + d.workArea.height - h - margin));
  win.setBounds({ x: Math.round(nx), y: Math.round(ny), width: w, height: h });
}

async function showLookupAt(text, pt, context = '') {
  const t = String(text || '').trim();
  if (!t) return;
  log('lookup-at', t, JSON.stringify(pt));
  placeAt(pt.x + 14, pt.y - 12);
  win.showInactive();
  win.moveTop();
  bindEsc(true);
  win.webContents.send('mode', { mode: 'lookup', text: t });
  await lookup(t, {
    context,
    onEvent: (e) => { if (win && !win.isDestroyed()) win.webContents.send('lookup:event', e); },
  });
}

function createSelectWindow() {
  selWin = new BrowserWindow({
    show: false, frame: false, transparent: true, resizable: false, movable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false, fullscreenable: false,
    enableLargerThanScreen: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  selWin.loadFile(path.join(__dirname, '..', 'ui', 'select.html'));
  selWin.setAlwaysOnTop(true, 'screen-saver');
  selWin.on('closed', () => { selWin = null; });
}

function createFrozenWindow() {
  frozenWin = new BrowserWindow({
    show: false, frame: false, transparent: true, resizable: false, movable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  frozenWin.loadFile(path.join(__dirname, '..', 'ui', 'frozen.html'));
  frozenWin.setAlwaysOnTop(true, 'screen-saver');
  frozenWin.on('closed', () => { frozenWin = null; });
}

async function startShot() {
  hideFrozen();
  if (!selWin) createSelectWindow();
  const pt = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(pt);
  selWin.setBounds(d.bounds);
  selWin.show();
  selWin.focus();
  selWin.webContents.send('shot:reset');
  bindEsc(true);
}

async function runShot(b, r) {
  const d = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
  const scale = d.scaleFactor || 1;
  try { if (selWin) selWin.hide(); } catch {}
  bindEsc(false);
  await sleep(150); // 等框选层真的消失，别把自己截进去

  const px = Math.round(b.x + r.x);
  const py = Math.round(b.y + r.y);
  const pw = Math.max(8, Math.round(r.w));
  const ph = Math.max(8, Math.round(r.h));
  const out = path.join(app.getPath('temp'), `ll-shot-${Date.now()}.png`);

  const cap = await bridge.capture(
    Math.round(px * scale), Math.round(py * scale),
    Math.round(pw * scale), Math.round(ph * scale), out,
  );
  log('capture', JSON.stringify(cap).slice(0, 200));

  if (!cap || !cap.ok) {
    placeAt(px, py);
    win.showInactive();
    bindEsc(true);
    win.webContents.send('mode', { mode: 'empty' });
    return { ok: false, cap };
  }

  // 识别完就走：不留图、不等悬停，直接把译文卡片贴到选区旁边
  const t0 = Date.now();
  let res = { words: [], text: '' };
  try {
    res = await ocr.recognize(out);
    log('ocr', res.words.length, 'words', Date.now() - t0, 'ms', String(res.text || '').slice(0, 60));
  } catch (e) {
    log('ocr fail', e.message);
  }
  try { fs.unlinkSync(out); } catch {}

  const text = String(res.text || '').trim();
  if (!text) {
    placeAt(px, py);
    win.showInactive();
    bindEsc(true);
    win.webContents.send('mode', { mode: 'empty' });
    return { ok: false, reason: 'no-text' };
  }

  placeNearRect(px, py, pw, ph);
  win.showInactive();
  win.moveTop();
  bindEsc(true);
  win.webContents.send('mode', { mode: 'ocr', original: text });

  try {
    await llm.translate(text, (d) => {
      if (win && !win.isDestroyed()) win.webContents.send('ocr:delta', d);
    });
    if (win && !win.isDestroyed()) win.webContents.send('ocr:done');
  } catch (e) {
    const msg = e.code === 'NO_KEY' ? '还没填 API key（右上角 ⚙）' : `翻译失败：${e.message}`;
    if (win && !win.isDestroyed()) win.webContents.send('ocr:error', msg);
  }

  const chips = pickWords(res.words);
  if (chips.length && win && !win.isDestroyed()) win.webContents.send('ocr:words', chips);
  return { ok: true, words: res.words.length };
}

/** 把卡片放到选区正下方；下方放不下就放上方 */
function placeNearRect(x, y, w, h) {
  const winW = 430, winH = 360, margin = 10;
  const d = screen.getDisplayNearestPoint({ x, y });
  const wa = d.workArea;
  let cx = Math.round(x + w / 2 - winW / 2);
  let cy = Math.round(y + h + margin);
  if (cy + winH > wa.y + wa.height - margin) cy = Math.round(y - winH - margin);
  cx = Math.max(wa.x + margin, Math.min(cx, wa.x + wa.width - winW - margin));
  cy = Math.max(wa.y + margin, Math.min(cy, wa.y + wa.height - winH - margin));
  win.setBounds({ x: cx, y: cy, width: winW, height: winH });
}

const STOP_WORDS = new Set(('the a an and or but if of to in on at for with from by as is are was were be been ' +
  'being this that these those it its you your we our they their he she his her i me my do does did not no so ' +
  'than then there here what which who whom when where why how all any both each few more most other some such ' +
  'only own same too very can will just should now would could about into over after before').split(' '));

/** 从 OCR 结果里挑适合点查的生词 */
function pickWords(words) {
  const seen = new Set();
  const out = [];
  for (const w of words || []) {
    const t = String(w.text || '').replace(/[^A-Za-z'-]/g, '');
    if (t.length < 3 || t.length > 20) continue;
    const lower = t.toLowerCase();
    if (STOP_WORDS.has(lower) || seen.has(lower)) continue;
    if ((w.conf || 0) < 55) continue;
    seen.add(lower);
    out.push(t);
    if (out.length >= 12) break;
  }
  return out;
}

function showFrozen(x, y, w, h, dataUrl, scale) {
  if (!frozenWin) createFrozenWindow();
  frozenWin.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
  frozenWin.setAlwaysOnTop(true, 'screen-saver');
  frozenWin.showInactive();
  frozenWin.moveTop();
  frozenWin.webContents.send('freeze:image', { dataUrl, scale });
  log('frozen-shown', x, y, w, h, 'visible=' + frozenWin.isVisible(), 'scale=' + scale);
}

function hideFrozen() {
  try { if (frozenWin && frozenWin.isVisible()) frozenWin.hide(); } catch {}
  clearTimeout(hoverTimer);
  if (!win || !win.isVisible()) bindEsc(false);
}

// ---------------- 实时字幕（同传引擎） ----------------
function createLiveWindow() {
  liveWin = new BrowserWindow({
    width: 1020, height: 224, show: false, frame: false, transparent: true,
    resizable: false, minimizable: false, maximizable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, focusable: true,
    backgroundColor: '#00000000',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  liveWin.setAlwaysOnTop(true, 'screen-saver');
  liveWin.loadFile(path.join(__dirname, '..', 'ui', 'live.html'));
  liveWin.on('close', (e) => { if (!quitting) { e.preventDefault(); liveWin.hide(); } });
}

function placeLive() {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const w = 1020, h = 224;
  liveWin.setBounds({
    x: Math.round(d.workArea.x + (d.workArea.width - w) / 2),
    y: Math.round(d.workArea.y + d.workArea.height - h - 48),
    width: w, height: h,
  });
}

function createHomeWindow() {
  homeWin = new BrowserWindow({
    width: 1000, height: 660, minWidth: 880, minHeight: 560,
    show: false, frame: false, backgroundColor: '#0f1013',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  homeWin.loadFile(path.join(__dirname, '..', 'ui', 'home.html'));
  homeWin.on('close', (e) => { if (!quitting) { e.preventDefault(); homeWin.hide(); } });
}

function showHome(view) {
  if (!homeWin) createHomeWindow();
  homeWin.show();
  homeWin.focus();
  if (view) homeWin.webContents.send('home:view', view);
}

function ensureSpeech() {
  if (speech) return speech;
  speech = new Speech();
  speech.on((ev) => {
    if (liveWin && !liveWin.isDestroyed()) liveWin.webContents.send('live:event', ev);
    if (homeWin && !homeWin.isDestroyed()) homeWin.webContents.send('home:speech', ev);

    if (ev.e === 'pair') {
      const row = transcript.append({ en: ev.en, zh: ev.zh });
      if (row && homeWin && !homeWin.isDestroyed()) homeWin.webContents.send('transcript:new', row);
      log('pair', String(ev.en || '').slice(0, 80), '|', String(ev.zh || '').slice(0, 40));
    } else if (['error', 'exit', 'ready', 'listening', 'status'].includes(ev.e)) {
      log('speech-ev', JSON.stringify(ev).slice(0, 200));
    } else if (ev.e === 'hypothesis') {
      log('asr', String(ev.text || '').slice(0, 140));
    }
  });
  return speech;
}

function startSpeech(source) {
  const s = ensureSpeech();
  const root = config.get('speechRoot');
  const src = source || config.get('speechSource') || 'system';
  log('speech-start', src, root);
  return s.start({
    root,
    apiKey: config.get('apiKey'),
    source: src,
    model: config.get('speechModel') || '',
  });
}

function stopSpeech() {
  if (!speech) return;
  try { speech.stop(); } catch {}
  speech = null;
}

function toggleLive() {
  if (!liveWin) createLiveWindow();
  if (liveWin.isVisible()) {
    liveWin.hide();
    stopSpeech();
    return;
  }
  placeLive();
  liveWin.showInactive();
  liveWin.moveTop();
  startSpeech(config.get('speechSource') || 'system');
}

function buildTray() {
  tray = new Tray(fs.existsSync(ICON) ? nativeImage.createFromPath(ICON) : nativeImage.createEmpty());
  tray.setToolTip('LingoLens — 随处查词');

  const rebuild = () => {
    const hk = config.get('hotkeys') || {};
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `划词查词  ${hk.lookup || 'Alt+X'}`, click: doSelection },
      { label: `手动查词  ${hk.input || 'Alt+Q'}`, click: showInput },
      { label: `截图取词  ${hk.shot || 'Alt+S'}`, click: () => { startShot(); } },
      { label: `实时字幕  ${hk.live || 'Alt+L'}`, click: toggleLive },
      { type: 'separator' },
      { label: '打开控制台', click: () => showHome() },
      { label: pinned ? '取消钉住' : '钉住卡片', click: () => { pinned = !pinned; rebuild(); } },
      { label: '设置…', click: () => { showHome('settings'); } },
      { type: 'separator' },
      {
        label: '开机自启', type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (mi) => app.setLoginItemSettings({ openAtLogin: mi.checked }),
      },
      { label: '退出', click: () => { quitting = true; app.quit(); } },
    ]));
  };
  trayRebuild = rebuild;
  rebuild();
  tray.on('click', () => showHome());

  try {
    const hk = config.get('hotkeys') || {};
    tray.displayBalloon({
      title: 'LingoLens 已启动',
      content: `选中英文后按 ${hk.lookup || 'Alt+X'} 查词；${hk.input || 'Alt+Q'} 手动输入；${hk.live || 'Alt+L'} 实时字幕。`,
    });
  } catch (e) { log('balloon fail', e.message); }
}

async function doSelection() {
  if (!bridge) bridge = new Bridge();
  const r = await bridge.selection();
  log('selection', JSON.stringify(r).slice(0, 200));
  if (r && r.ok && r.text && r.text.trim()) {
    await showLookup(r.text.trim());
  } else {
    placeNearCursor();
    win.showInactive();
    win.webContents.send('mode', { mode: 'empty' });
  }
}

function registerHotkeys() {
  const hk = config.get('hotkeys') || {};
  const failures = [];
  const bind = (accel, fn) => {
    if (!accel) return;
    try { if (!globalShortcut.register(accel, fn)) failures.push(accel); }
    catch { failures.push(accel); }
  };
  bind(hk.input || 'Alt+Q', showInput);
  bind(hk.lookup || 'Alt+X', doSelection);
  bind(hk.shot || 'Alt+S', startShot);
  bind(hk.live || 'Alt+L', toggleLive);
  lastHotkeyFailures = failures;
  if (failures.length) log('HOTKEY_FAILED', failures.join(','));
  return failures;
}

app.whenReady().then(() => {
  log('ready');
  try { app.setAccessibilitySupportEnabled(true); log('a11y on'); } catch (e) { log('a11y fail', e.message); }
  createWindow();
  createSelectWindow();
  createLiveWindow();
  ensureSpeech();
  createHomeWindow();
  if (!Object.keys(process.env).some((k) => k.startsWith('LINGOLENS_'))) showHome();
  bridge = new Bridge();
  bridge.start();
  buildTray();
  registerHotkeys();

  ipcMain.on('shot:cancel', () => {
    try { selWin.hide(); } catch {}
    if (!win.isVisible()) bindEsc(false);
  });

  ipcMain.on('shot:rect', (_e, r) => { runShot(selWin.getBounds(), r); });

  ipcMain.on('freeze:hover', (_e, p) => {
    if (!frozenWin) return;
    const b = frozenWin.getBounds();
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      showLookupAt(p.text, { x: b.x + p.x, y: b.y + p.y });
    }, 140);
  });

  ipcMain.on('freeze:close', () => { hideFrozen(); });

  ipcMain.on('live:start', (_e, p) => { startSpeech(p && p.source); });
  ipcMain.on('live:stop', () => { stopSpeech(); });
  ipcMain.on('live:close', () => { if (liveWin) liveWin.hide(); stopSpeech(); });
  ipcMain.on('live:restart', (_e, p) => {
    stopSpeech();
    setTimeout(() => startSpeech(p && p.source), 500);
  });
  ipcMain.on('live:open-home', () => showHome('live'));

  ipcMain.on('live:word', (_e, p) => {
    if (!liveWin) return;
    const b = liveWin.getBounds();
    showLookupAt(p.word, { x: b.x + p.x, y: b.y + p.y }, p.sentence || '');
  });

  ipcMain.on('home:win', (_e, act) => {
    if (!homeWin) return;
    if (act === 'min') homeWin.minimize();
    else if (act === 'max') { if (homeWin.isMaximized()) homeWin.unmaximize(); else homeWin.maximize(); }
    else if (act === 'close') homeWin.hide();
  });

  ipcMain.on('home:action', async (_e, act) => {
    log('home-action', act);
    if (act === 'shot') { if (homeWin) homeWin.hide(); await startShot(); return; }
    if (act === 'live') { if (homeWin) homeWin.hide(); toggleLive(); return; }
    if (act === 'lookup' || act === 'input') { if (homeWin) homeWin.hide(); showInput(); }
  });

  ipcMain.handle('home:state', () => ({ live: Boolean(liveWin && liveWin.isVisible()) }));
  ipcMain.handle('transcript:list', () => transcript.list());
  ipcMain.handle('transcript:load', (_e, date) => transcript.load(date));
  ipcMain.handle('transcript:today', () => transcript.dayKey());
  ipcMain.on('transcript:export', async (_e, date) => {
    if (!date) return;
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(homeWin, {
        defaultPath: `同传记录-${date}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (!canceled && filePath) fs.writeFileSync(filePath, transcript.toMarkdown(date), 'utf8');
    } catch (e) { log('export fail', e.message); }
  });

  ipcMain.handle('config:get', (_e, key) => (key ? config.get(key) : config.load()));
  ipcMain.handle('config:set', (_e, patch) => {
    const next = config.set(patch);
    globalShortcut.unregisterAll();
    const failures = registerHotkeys();
    if (trayRebuild) trayRebuild();
    return { ...next, hotkeyFailures: failures };
  });
  ipcMain.handle('lookup', async (_e, text) => { await showLookup(text); return true; });
  ipcMain.handle('copy', (_e, text) => { clipboard.writeText(String(text)); return true; });
  ipcMain.handle('hide', () => { win.hide(); return true; });
  ipcMain.handle('resize', (_e, h) => {
    const b = win.getBounds();
    const d = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
    const height = Math.max(200, Math.min(Math.round(h), d.workArea.height - 16));
    if (Math.abs(height - b.height) > 1) win.setBounds({ ...b, height });
    return true;
  });

  if (process.env.LINGOLENS_HOMETEST) {
    const fakeDate = '2026-11-08';
    const fakeFile = path.join(transcript.DIR, fakeDate + '.jsonl');
    const todayFile = path.join(transcript.DIR, transcript.dayKey() + '.jsonl');
    const todayExisted = fs.existsSync(todayFile);
    const demoRows = [
      { t: '15:02:11', en: 'I guess some crushes can be surface level.', zh: '我猜有些喜欢可能只是表面的。' },
      { t: '15:02:18', en: 'I jump to conclusions.', zh: '我太急着下结论了。' },
      { t: '15:02:26', en: "I don't think you didn't actually want to say them.", zh: '我觉得你不是真的不想说。' },
    ];
    try {
      fs.mkdirSync(transcript.DIR, { recursive: true });
      fs.writeFileSync(fakeFile, demoRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      if (!todayExisted) fs.writeFileSync(todayFile, demoRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    } catch {}
    setTimeout(async () => {
      showHome();
      await sleep(900);
      try {
        const img = await homeWin.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, '..', 'data', 'home.png'), img.toPNG());
        log('HOMETEST_OK', img.getSize().width, img.getSize().height);
      } catch (e) { log('HOMETEST_FAIL', e.message); }
      homeWin.webContents.send('home:view', 'live');
      await sleep(900);
      try {
        const img = await homeWin.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, '..', 'data', 'home-live.png'), img.toPNG());
        log('HOMETEST_LIVE_OK');
      } catch (e) { log('HOMETEST_LIVE_FAIL', e.message); }
      homeWin.webContents.send('home:view', 'settings');
      await sleep(900);
      try {
        const img = await homeWin.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, '..', 'data', 'home-settings.png'), img.toPNG());
        log('HOMETEST_SETTINGS_OK');
      } catch (e) { log('HOMETEST_SETTINGS_FAIL', e.message); }
      try { fs.unlinkSync(fakeFile); } catch {}
      if (!todayExisted) { try { fs.unlinkSync(todayFile); } catch {} }
      await sleep(300);
      quitting = true; app.quit();
    }, 1500);
    return;
  }

  if (process.env.LINGOLENS_LIVEONLY) {
    setTimeout(() => { toggleLive(); }, 1200);
    setTimeout(() => { quitting = true; app.quit(); }, 32000);
    return;
  }

  if (process.env.LINGOLENS_LIVETEST) {
    setTimeout(async () => {
      // 不启动引擎，避免真实音频事件污染测试
      if (!liveWin) createLiveWindow();
      placeLive();
      liveWin.showInactive();
      liveWin.moveTop();
      await sleep(3500);
      // 注入一段文本，验证渲染（不影响真实引擎）
      const push = (ev) => liveWin.webContents.send('live:event', ev);
      push({ e: 'started' });
      push({ e: 'listening', on: true });
      push({ e: 'stats', asr_ms: 88, mt_first_ms: 957 });
      push({ e: 'sentence_start', sid: 1 });
      push({ e: 'hypothesis', text: 'I mixed with the thalassa blue and highlighted the' });
      push({ e: 'pair', en: 'I mixed with the thalassa blue and highlighted the', zh: '我把塔拉萨蓝调进去，然后高光处理了', sid: 1 });
      push({ e: 'sentence_start', sid: 2 });
      push({ e: 'hypothesis', text: 'edges of the blade.' });
      push({ e: 'pair', en: 'edges of the blade.', zh: '刀刃的边缘。', sid: 2 });
      push({ e: 'sentence_start', sid: 3 });
      push({ e: 'hypothesis', text: 'Once again, I used' });
      await sleep(600);
      try {
        const clicked = await liveWin.webContents.executeJavaScript(`(function(){
          const el = [...document.querySelectorAll('#en .w')].find(
            (e) => e.textContent.replace(/[^A-Za-z]/g, '').toLowerCase() === 'ubiquitous');
          if (!el) return 'not-found';
          el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return el.textContent;
        })()`);
        log('LIVETEST_CLICK', String(clicked));
      } catch (e) { log('LIVETEST_CLICK_FAIL', e.message); }
      await sleep(1200);
      try {
        const img = await liveWin.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, '..', 'data', 'live.png'), img.toPNG());
        log('LIVETEST_OK', img.getSize().width, img.getSize().height);
      } catch (e) { log('LIVETEST_FAIL', e.message); }
      await sleep(400);
      quitting = true; app.quit();
    }, 1500);
    return;
  }

  if (process.env.LINGOLENS_SELECTTEST) {
    log('selecttest');
    if (process.env.LINGOLENS_SELECTTEST === 'drag') {
      setTimeout(() => { startShot(); }, 1200);
      return;
    }
    setTimeout(async () => {
      await startShot();
      await sleep(900);
      try {
        const img = await selWin.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, '..', 'data', 'select.png'), img.toPNG());
        log('SELECTTEST_OK', img.getSize().width, img.getSize().height);
      } catch (e) { log('SELECTTEST_FAIL', e.message); }
      await sleep(300);
      quitting = true; app.quit();
    }, 1500);
    return;
  }

  if (process.env.LINGOLENS_OCRTEST) {
    setTimeout(async () => {
      const r = await runShot({ x: 0, y: 0 }, { x: 320, y: 220, w: 680, h: 300 });
      log('OCRTEST runShot', JSON.stringify(r));
      await sleep(3000);
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, '..', 'data', 'ocr-card.png'), img.toPNG());
        log('OCRTEST_OK', img.getSize().width, img.getSize().height);
      } catch (e) { log('OCRTEST_FAIL', e.message); }
      await sleep(400);
      quitting = true; app.quit();
    }, 1500);
    return;
  }

  if (process.env.LINGOLENS_SHOTTEST) {
    const demoWin = new BrowserWindow({
      x: 200, y: 160, width: 720, height: 300, frame: false, show: true,
      webPreferences: { nodeIntegration: false },
    });
    demoWin.loadFile(path.join(__dirname, '..', 'data', 'ocr-test.png'));
    demoWin.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const b = demoWin.getBounds();
        log('SHOTTEST region', JSON.stringify(b));
        const r = await runShot(b, { x: 0, y: 0, w: b.width, h: b.height });
        log('SHOTTEST runShot', JSON.stringify(r));
        await sleep(3500);
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(__dirname, '..', 'data', 'shot-card.png'), img.toPNG());
          log('SHOTTEST_CARD_OK', img.getSize().width, img.getSize().height);
        } catch (e) { log('SHOTTEST_CARD_FAIL', e.message); }
        await sleep(300);
        quitting = true; app.quit();
      }, 1200);
    });
    return;
  }

  if (process.env.LINGOLENS_SELFTEST) {
    const testWin = new BrowserWindow({
      width: 560, height: 240, show: true, frame: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    const html = '<html><body style="font:18px Segoe UI;padding:24px">' +
      '<textarea id="t" style="width:100%;height:120px;font:18px Segoe UI">' +
      'The ubiquitous surveillance apparatus watches everything.' +
      '</textarea><script>window.onload=function(){var t=document.getElementById("t");t.focus();t.select();};</script></body></html>';
    testWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    testWin.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const b = testWin.getBounds();
        testWin.focus();
        testWin.moveTop();
        await new Promise((r) => setTimeout(r, 400));
        log('SELFTEST_FOCUSED', String(testWin.isFocused()));
        log('SELFTEST_FG', JSON.stringify(await bridge.request({ cmd: 'foreground' })));
        const sel = await bridge.selection();
        log('SELFTEST_SELECTION', JSON.stringify(sel));
        const at = await bridge.textAtPoint(b.x + 120, b.y + 70);
        log('SELFTEST_ATPOINT', JSON.stringify(at));
        testWin.webContents.executeJavaScript('document.getElementById("t").value').then((v) => log('SELFTEST_VALUE', v));
        setTimeout(() => { quitting = true; app.quit(); }, 600);
      }, 1500);
    });
    return;
  }

  if (process.env.LINGOLENS_DEMO) {
    log('demo-mode');
    const b = screen.getPrimaryDisplay().workArea;
    win.setBounds({ x: b.x + 120, y: b.y + 80, width: 430, height: 380 });
    win.webContents.once('did-finish-load', async () => {
      log('demo: loaded');
      win.showInactive();
      await showLookup(process.env.LINGOLENS_DEMO || 'ubiquitous');
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(__dirname, '..', 'data', 'demo.png'), img.toPNG());
          log('DEMO_SHOT_OK', img.getSize().width, img.getSize().height);
        } catch (e) { log('DEMO_SHOT_FAIL', e.message); }
      }, 2500);
    });
  }

  app.on('activate', () => showHome());
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (bridge) bridge.quit();
  stopSpeech();
});

app.on('window-all-closed', (e) => { if (e && e.preventDefault) e.preventDefault(); });

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showHome());
}
