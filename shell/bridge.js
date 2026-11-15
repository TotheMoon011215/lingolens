'use strict';
/** 常驻的 NativeBridge.exe 客户端：一行 JSON 请求 / 一行 JSON 回应 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class Bridge {
  constructor() {
    this.exe = path.join(__dirname, '..', 'native', 'NativeBridge.exe');
    this.proc = null;
    this.pending = [];
    this.buf = '';
    this.alive = false;
  }

  start() {
    if (this.alive || !fs.existsSync(this.exe)) return this.alive;
    try {
      this.proc = spawn(this.exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.alive = true;
      this.proc.stdout.setEncoding('utf8');
      this.proc.stdout.on('data', (chunk) => this._onData(chunk));
      this.proc.on('exit', () => { this.alive = false; this._flush(new Error('bridge exited')); });
      this.proc.on('error', () => { this.alive = false; this._flush(new Error('bridge failed')); });
      return true;
    } catch {
      return false;
    }
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      const r = this.pending.shift();
      if (!r) continue;
      try { r.resolve(JSON.parse(line)); } catch { r.resolve({ ok: false, error: 'bad json' }); }
    }
  }

  _flush(err) {
    for (const r of this.pending) r.resolve({ ok: false, error: err.message });
    this.pending = [];
  }

  request(obj, timeoutMs = 3000) {
    if (!this.start()) return Promise.resolve({ ok: false, error: 'bridge unavailable' });
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeoutMs);
      this.pending.push({
        resolve: (v) => { clearTimeout(t); resolve(v); },
      });
      this.proc.stdin.write(JSON.stringify(obj) + '\n');
    });
  }

  selection() { return this.request({ cmd: 'selection' }, 1500); }
  textAtPoint(x, y) { return this.request({ cmd: 'textAtPoint', x, y }, 1200); }
  capture(x, y, w, h, out) { return this.request({ cmd: 'capture', x, y, w, h, out }, 4000); }
  quit() { if (this.proc) this.proc.stdin.end(); }
}

module.exports = Bridge;
