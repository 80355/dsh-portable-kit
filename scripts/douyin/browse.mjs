// 抖音自动浏览（低频、像真人）：滑 N 条，记录标题/作者/点赞 + 截图
// 用法：node browse.mjs [条数] [等待秒]
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:9222';
const STEPS = Number(process.argv[2] || 5);
const WAIT_MS = Number(process.argv[3] || 2.5) * 1000;
const OUT = path.resolve('feed');
fs.mkdirSync(OUT, { recursive: true });

const list = (await (await fetch(`${BASE}/json/list`)).json()).filter((t) => t.type === 'page');
const target = list.find((t) => /douyin\.com/.test(t.url)) || list[0];
if (!target) { console.error('没有抖音标签页'); process.exit(1); }

class Cdp {
  constructor(url) { this.url = url; this.seq = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); }
      }, 20000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const cdp = new Cdp(target.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalJson(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.value;
}

async function keyDown() {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
}

async function shot(file) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
}

// 从页面里粗提取「作者/文案/点赞/评论」——抖音 DOM 会变，这里用可见文本 + 简单启发式
const EXTRACT = `(() => {
  const txt = (document.body.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
  return { title: document.title, url: location.href, lines: txt.slice(0, 120) };
})()`;

const items = [];
for (let i = 0; i < STEPS; i++) {
  await sleep(WAIT_MS);
  const data = await evalJson(EXTRACT);
  const file = path.join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`);
  await shot(file);
  // 从文本里挑可能属于这条视频的行：@开头 / 数字(万) 等
  const lines = data?.lines || [];
  const authorLine = lines.find((l) => l.startsWith('@')) || '';
  const capLines = lines.filter((l) => l.length > 8 && !l.startsWith('@') && !/^\\d+(\\.\\d+)?(万|w)?$/.test(l)).slice(0, 6);
  items.push({ step: i + 1, title: data?.title, author: authorLine, caption: capLines, screenshot: file });
  if (i < STEPS - 1) { await keyDown(); }
}
fs.writeFileSync(path.join(OUT, 'items.json'), JSON.stringify(items, null, 2), 'utf8');
console.log(JSON.stringify(items, null, 2));
cdp.close();
