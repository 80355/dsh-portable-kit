// 看完自动发私信：盯住自主观看状态，每轮结束后把刚看过的作品私信发给指定好友。
// 用法：node auto-share-watch.mjs [--to 某位好友] [--interval 20000] [--once] [--dry] [--log 文件]
// 说明：每轮只发一条（回执里已发过的不重发）；影像浏览器被插件占用时不会插手。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, def = '') => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
const to = arg('to', '');
const interval = Number(arg('interval', '20000'));
const once = argv.includes('--once');
const dry = argv.includes('--dry');
const logFile = arg('log', path.join(here, 'auto-share-watch.log'));

// 便携化：DSH_HOME 由启动脚本设置（可移动卡/别的电脑），否则回落到本机默认位置
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const STATE = path.join(DSH_HOME, 'profiles/web/node_modules/dsh-douyin-browser-local/state/watch-state.json');
const NODE = process.execPath;
const log = (msg) => {
  const line = `[${new Date(Date.now() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19)}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch {}
};

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; } };

// 单实例保护：已有活着的水手就直接退出，避免启动全部.bat 反复点导致重复发私信
const PID_FILE = path.join(here, 'auto-share-watch.pid');
try {
  const old = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
  if (old && old !== process.pid) {
    try { process.kill(old, 0); console.log(`已有实例 pid=${old} 在运行，退出`); process.exit(0); } catch {}
  }
} catch {}
try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch {}

let wasRunning = false;
let lastFiredKey = '';
let busy = false;

const fire = () => {
  if (busy) return;
  busy = true;
  try {
    const args = [path.join(here, 'share-latest.mjs'), '--to', to, ...(dry ? ['--dry-run'] : [])];
    const res = spawnSync(NODE, args, { encoding: 'utf8', timeout: 180_000 });
    const out = `${res.stdout || ''}${res.stderr || ''}`.trim().split('\n').slice(-3).join(' | ');
    log(`${dry ? '[dry] ' : ''}分享结果: ${out.slice(0, 400)}`);
  } catch (error) {
    log(`分享失败: ${error.message}`);
  } finally {
    busy = false;
  }
};

const tick = () => {
  const state = readState();
  if (!state) return;
  const status = String(state.status || '');
  const running = status === 'running';
  const key = `${state.sessionId || ''}:${state.updatedAt || ''}:${status}`;
  if (wasRunning && !running) {
    // 一轮结束：等 5 秒让插件收尾，再发（同一轮只发一次）
    const fireKey = `${state.sessionId || ''}:${state.updatedAt || ''}`;
    if (fireKey !== lastFiredKey) {
      lastFiredKey = fireKey;
      log(`检测到一轮结束（status=${status}，error=${state.lastError || '无'}），准备分享最近看过的作品`);
      setTimeout(fire, 5000);
    }
  }
  wasRunning = running;
  void key;
};

log(`启动 auto-share-watch（to=${to}, interval=${interval}ms${dry ? ', DRY' : ''}）`);
if (once) { fire(); process.exit(0); }
tick();
setInterval(tick, Math.max(5000, interval));
