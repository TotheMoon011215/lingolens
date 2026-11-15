'use strict';
/** 同传引擎（Python）的进程管理：一行 JSON 一条事件。 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class Speech {
  constructor() {
    this.proc = null;
    this.buf = '';
    this.handlers = [];
    this.alive = false;
  }

  on(fn) { this.handlers.push(fn); }

  _emit(ev) {
    for (const h of this.handlers) {
      try { h(ev); } catch {}
    }
  }

  start({ root, apiKey, source = 'system', model = '' } = {}) {
    if (this.proc) {
      // 进程已在，直接让它开始听
      this.send({ cmd: 'start' });
      return true;
    }
    const py = path.join(root, 'runtime', 'python.exe');
    if (!fs.existsSync(py)) {
      this._emit({ e: 'error', text: `找不到语音运行时：${py}` });
      return false;
    }
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', LL_AUDIO_SOURCE: source };
    if (apiKey) env.DEEPSEEK_API_KEY = apiKey;
    if (model) env.LL_MT_MODEL = model;

    try {
      this.proc = spawn(py, ['-m', 'app.bridge'], { cwd: root, env, windowsHide: true });
    } catch (e) {
      this._emit({ e: 'error', text: `启动语音进程失败：${e.message}` });
      return false;
    }
    this.alive = true;
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (t) => { if (t && t.trim()) this._emit({ e: 'stderr', text: t.trim().slice(0, 400) }); });
    this.proc.on('exit', (code) => {
      this.alive = false;
      this.proc = null;
      this._emit({ e: 'exit', code });
    });
    this.proc.on('error', (e) => this._emit({ e: 'error', text: e.message }));

    // 关键：桥接进程只会在收到 start 后打开音频、加载模型
    this.send({ cmd: 'start' });
    return true;
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try { this._emit(JSON.parse(line)); } catch {}
    }
  }

  send(obj) {
    if (!this.proc) return false;
    try { this.proc.stdin.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; }
  }

  stop() {
    if (!this.proc) return;
    this.send({ cmd: 'quit' });
    const p = this.proc;
    setTimeout(() => { try { p.kill(); } catch {} }, 2500);
  }
}

module.exports = Speech;
