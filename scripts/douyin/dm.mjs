// 抖音私信：打开对话 / 读取 / 回复
// 用法：
//   node dm.mjs list               列出私信会话
//   node dm.mjs open "某某好友"   打开某个会话并读取
//   node dm.mjs send "某某好友" "想说的话"   打开会话并发送
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:9222';
const [, , cmd, ...rest] = process.argv;

const pages = (await (await fetch(`${BASE}/json/list`)).json()).filter((t) => t.type === 'page');
const target = pages.find((t) => /douyin\.com/.test(t.url)) || pages[0];
if (!target) { console.error('没有抖音页面'); process.exit(1); }

class Cdp {
  constructor(u) { this.url = u; this.seq = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 25000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const cdp = new Cdp(target.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
const shot = async (name) => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const f = path.resolve('feed', `${name}.png`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
  return f;
};

async function clickText(text) {
  const rect = await ev(`(() => {
    const t = ${JSON.stringify(text)};
    const els = [...document.querySelectorAll('div,li,a')].filter(e => {
      if (e.offsetParent === null) return false;
      const s = (e.textContent || '').trim();
      return s.includes(t) && s.length <= 40;
    });
    if (!els.length) return null;
    // 选面积最大的那个（整行会话项），点它的中心
    els.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height);
    const el = els[0];
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, text: el.textContent.trim().slice(0, 40) };
  })()`);
  if (!rect) return null;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  }
  await sleep(2500);
  return rect;
}

if (cmd === 'list') {
  const txt = await ev('document.body.innerText');
  console.log(txt?.slice(0, 2000));
} else if (cmd === 'open') {
  const r = await clickText(rest[0]);
  console.log('clicked:', JSON.stringify(r));
  await sleep(1500);
  const txt = await ev('document.body.innerText');
  console.log(txt?.slice(0, 3000));
  console.log('shot:', await shot('dm-open'));
} else if (cmd === 'send') {
  const r = await clickText(rest[0]);
  console.log('clicked chat:', JSON.stringify(r));
  await sleep(1200);
  const box = await ev(`(() => {
    const ta = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
    if (!ta) return null;
    const r = ta.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: ta.tagName, ce: ta.getAttribute('contenteditable') };
  })()`);
  if (!box) { console.error('没找到输入框'); process.exit(1); }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  await sleep(400);
  await cdp.send('Input.insertText', { text: rest[1] });
  await sleep(600);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(1200);
  const txt = await ev('document.body.innerText');
  console.log(txt?.slice(0, 2500));
  console.log('shot:', await shot('dm-send'));
} else {
  console.error('用法: list | open <名字> | send <名字> <文本>');
  process.exit(1);
}
cdp.close();
