#!/usr/bin/env node
/**
 * DSH 随身卡 · 新手启动器（本地图形界面）
 *
 * 定位：给第一次用、不想碰命令行的人一个「双击 → 浏览器里点几下」的入口。
 *   - 环境体检（Node / DSH / 默认目录 / 端口）
 *   - 填 API Key（写进 console/panel.config.json，和控制台共用同一份）
 *   - 勾模块（写 portable-strip.txt，再跑一次 repath 真删配置块）
 *   - 一键启动 / 停止 DSH 与本地控制台，实时看日志
 *
 * 设计取舍：
 *   - 只用 Node 内置模块，不需要 npm install（随身卡上没网也能跑）。
 *   - 不做重活：真正常驻的启停逻辑仍归 console/server.mjs，这里只负责
 *     「第一次怎么开始」和「出问题怎么看」。
 *   - 只监听 127.0.0.1，不做鉴权 —— 所以绝不能映射到局域网/公网。
 *
 * 用法：node launcher/server.mjs [--port 3400] [--no-open]
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const IS_WIN = process.platform === 'win32';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const LAUNCHER_PORT = Number(argOf('--port', process.env.LAUNCHER_PORT || 3400));
const NO_OPEN = argv.includes('--no-open');

const DSH_PORT = Number(process.env.DSH_PORT || 3080);
const CONSOLE_PORT = Number(process.env.CONSOLE_PORT || 3300);

const NODE_EXE = process.execPath;
const DSH_BIN_CANDIDATES = [
  process.env.DSH_BIN,
  process.env.DSH_CHECKOUT && path.join(process.env.DSH_CHECKOUT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  path.join(ROOT, 'dsh-workspace', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  path.join(ROOT, '..', 'dsh-workspace', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
].filter(Boolean);

const has = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

const LOCAL_HOME = path.join(ROOT, '.dsh');
const DSH_HOME = isDir(path.join(LOCAL_HOME, 'profiles')) ? LOCAL_HOME : (process.env.DSH_HOME || LOCAL_HOME);
const IS_OWN_STACK = isDir(path.join(LOCAL_HOME, 'profiles'));

const WORKSPACE = isDir(path.join(ROOT, 'workspace')) ? path.join(ROOT, 'workspace') : path.join(ROOT, '..');
const DSH_BIN = DSH_BIN_CANDIDATES.find(has) || DSH_BIN_CANDIDATES[0];

const CONFIG_FILE = path.join(ROOT, 'console', 'panel.config.json');
const STRIP_FILE = path.join(ROOT, 'portable-strip.txt');
const CONSOLE_SERVER = path.join(ROOT, 'console', 'server.mjs');
const REPATH_CANDIDATES = [
  path.join(ROOT, 'portable-repath.mjs'),
  path.join(ROOT, 'portable', 'portable-repath.mjs'),
];
const REPATH = REPATH_CANDIDATES.find(has);

// ---------------------------------------------------------------- 日志环形缓冲
const LOG_LIMIT = 800;
const logs = [];
let logSeq = 0;
function log(line, tag = 'gui') {
  const entry = { i: ++logSeq, t: new Date().toISOString(), tag, line: String(line).replace(/\r?\n$/, '') };
  logs.push(entry);
  if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT);
  return entry;
}

// ---------------------------------------------------------------- 配置读写
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}
function maskKey(v) {
  if (!v) return '';
  const s = String(v);
  return s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

const KEY_DEFS = [
  { key: 'COCO_KEY', label: '视觉 / 多模态 Key', hint: '手机读屏、看截图时用；没有它「手机操控」用不了', base: 'https://api.cocoapi.top/v1' },
  { key: 'COCO_API_KEY', label: '模型通道 Key', hint: 'agent 主模型走这条；面板会拿它填 COCO_API_KEY', base: 'https://api.cocoapi.top/v1' },
  { key: 'COCO233_API_KEY', label: '备用线路 Key', hint: '主线路限流或抽风时的第二选择', base: 'https://api.cocoapi.top/v1' },
  { key: 'OPENAI_API_KEY', label: 'OpenAI 官方 Key', hint: '有官方 key 就填这里；没有留空', base: 'https://api.openai.com/v1' },
];

const MODULE_DEFS = [
  { id: 'qqBridge', group: 'serv', label: 'QQ 机器人桥接', desc: '3100 端口；把它接到你的 QQ 上才会自动回消息' },
  { id: 'snowluma', group: 'serv', label: 'SnowLuma 网关', desc: '5099 端口；QQ 协议网关，桥接靠它说话' },
  { id: 'douyin', group: 'serv', label: '抖音自动化', desc: '接管本机浏览器刷视频 / 发私信，不额外装浏览器' },
  { id: 'phone', group: 'serv', label: '手机遥控', desc: 'ADB + 视觉；关掉后不会再去连手机' },
  { id: 'mcpSnowluma', group: 'mcp', label: 'MCP · QQ 消息', desc: '让 agent 能收发 QQ 消息' },
  { id: 'mcpSnowlumaHost', group: 'mcp', label: 'MCP · QQ 宿主', desc: '让 agent 能启停 SnowLuma 网关' },
  { id: 'mcpWebSearch', group: 'mcp', label: 'MCP · 联网搜索', desc: '让 agent 能搜索网页（走安全中转）' },
  { id: 'mcpSharedMemory', group: 'mcp', label: 'MCP · 共享记忆', desc: '让 agent 读写跨会话记忆文件' },
  { id: 'mcpTtsVoice', group: 'mcp', label: 'MCP · 语音合成', desc: '需要本地语音模型（很大）；随身卡默认不带' },
];
const MCP_IDS = {
  mcpSnowluma: 'mcp-snowluma',
  mcpSnowlumaHost: 'mcp-snowluma-host',
  mcpWebSearch: 'mcp-web-search-safe',
  mcpSharedMemory: 'mcp-shared-memory',
  mcpTtsVoice: 'mcp-tts-voice',
};

function currentModules() {
  const cfg = readConfig();
  const saved = (cfg.settings && cfg.settings.modules) || {};
  const out = {};
  for (const m of MODULE_DEFS) out[m.id] = m.id in saved ? !!saved[m.id] : m.id !== 'mcpTtsVoice';
  return out;
}
function currentKeys() {
  const cfg = readConfig();
  const env = (cfg.settings && cfg.settings.env) || {};
  const out = {};
  for (const k of KEY_DEFS) out[k.key] = { value: env[k.key] || '', masked: maskKey(env[k.key] || ''), set: !!env[k.key] };
  return out;
}

/** 写 strip 清单并跑一次 repath（只有真·随身卡才允许改配置，dev 仓库会被安全闸拦下）。 */
function applyModules(modules) {
  const disabled = [];
  for (const [id, on] of Object.entries(modules)) {
    const mcpId = MCP_IDS[id];
    if (mcpId && !on) disabled.push(mcpId);
  }
  const header = [
    '# 由本地启动器 / 控制台「模块开关」维护：一行一个要关闭的配置块 id 前缀',
    '# 关掉的模块不会出现在 DSH 的工具列表里；改完要重启 DSH 才生效',
  ].join('\n');
  fs.writeFileSync(STRIP_FILE, `${header}\n${disabled.join('\n')}${disabled.length ? '\n' : ''}`, 'utf8');

  if (!IS_OWN_STACK) {
    return { disabled, repath: null, note: '本仓库里没有 .dsh/profiles，已只写清单；在真正的随身卡上运行时会自动改写配置。' };
  }
  if (!REPATH) return { disabled, repath: null, note: '没找到 portable-repath.mjs，跳过改写。' };
  try {
    const r = spawnSyncNode(REPATH, []);
    log(`[repath] exit=${r.code} ${r.out || ''}`.trim(), 'repath');
    return { disabled, repath: { ok: r.code === 0, output: (r.out || '').trim() }, note: '' };
  } catch (e) {
    return { disabled, repath: { ok: false, output: String(e && e.message) }, note: '' };
  }
}

function spawnSyncNode(script, args) {
  // repath 只跑几十毫秒，同步等它更省事（不阻塞太久，也不会和写文件打架）
  return execFileSync(NODE_EXE, [script, ...args], { encoding: 'utf8', timeout: 20000, windowsHide: true });
}

// ---------------------------------------------------------------- 端口 / 进程
function probePort(port, timeout = 900) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(timeout);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
  });
}

const children = new Map(); // name -> { pid, startedAt, proc }

function killTree(pid) {
  if (!pid) return;
  try {
    if (IS_WIN) spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch (e) { log(`结束进程 ${pid} 失败：${e.message}`, 'warn'); }
}

function attachLogs(proc, tag) {
  const onData = (buf) => {
    for (const line of String(buf).split(/\r?\n/)) if (line.trim()) log(line, tag);
  };
  proc.stdout && proc.stdout.on('data', onData);
  proc.stderr && proc.stderr.on('data', onData);
  proc.on('exit', (code) => log(`${tag} 进程已退出（code=${code}）`, 'warn'));
}

function dshUrlTokenMap() {
  // DSH 启动时会把带 token 的地址打到 stdout，从日志里捞最近一条
  for (let i = logs.length - 1; i >= 0; i--) {
    const m = logs[i].line.match(/https?:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/);
    if (m) return { port: Number(m[1]), token: m[2] };
  }
  return null;
}

async function startDsh() {
  if (await probePort(DSH_PORT)) {
    log(`DSH 已经在 ${DSH_PORT} 端口运行，不重复启动`, 'ok');
    return { ok: true, already: true };
  }
  if (!has(DSH_BIN)) return { ok: false, error: `找不到 DSH 本体：${DSH_BIN}` };

  const env = { ...process.env, DSH_HOME, DSH_WORKSPACE: WORKSPACE };
  env.PATH = `${path.join(ROOT, 'node')}${path.delimiter}${env.PATH || ''}`;
  const bridgeDeps = path.join(WORKSPACE, 'qq-bridge', 'node_modules');
  if (has(bridgeDeps)) env.NODE_PATH = bridgeDeps;

  log(`启动 DSH：${DSH_BIN} (DSH_HOME=${DSH_HOME})`, 'dsh');
  const proc = spawn(NODE_EXE, [DSH_BIN, 'web', '--port', String(DSH_PORT), '--host', '127.0.0.1', '--no-open'], {
    cwd: WORKSPACE, env, windowsHide: true,
  });
  attachLogs(proc, 'dsh');
  children.set('dsh', { pid: proc.pid, proc, startedAt: Date.now() });

  const up = await waitPort(DSH_PORT, true, 90000);
  return up ? { ok: true } : { ok: false, error: 'DSH 90 秒内没起来，请看下面的日志' };
}

async function startConsole() {
  if (!has(CONSOLE_SERVER)) return { ok: false, error: `找不到控制台：${CONSOLE_SERVER}` };
  if (await probePort(CONSOLE_PORT)) {
    log(`控制台已经在 ${CONSOLE_PORT} 端口运行`, 'ok');
    return { ok: true, already: true };
  }
  const env = { ...process.env };
  env.PATH = `${path.join(ROOT, 'node')}${path.delimiter}${env.PATH || ''}`;
  log('启动本地控制台（' + CONSOLE_PORT + '）', 'console');
  const proc = spawn(NODE_EXE, [CONSOLE_SERVER, '--port', String(CONSOLE_PORT)], { cwd: ROOT, env, windowsHide: true });
  attachLogs(proc, 'console');
  children.set('console', { pid: proc.pid, proc, startedAt: Date.now() });
  const up = await waitPort(CONSOLE_PORT, true, 30000);
  return up ? { ok: true } : { ok: false, error: '控制台 30 秒内没起来' };
}

function waitPort(port, wantUp, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      const up = await probePort(port, 400);
      if (up === wantUp) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 600);
    };
    tick();
  });
}

async function stopDsh() {
  const live = await probePort(DSH_PORT);
  if (!live) { log('DSH 本来就没在跑', 'ok'); return { ok: true, already: true }; }
  // 只杀本进程拉起来的；外部起的用端口反查代价大，先尝试 graceful
  const rec = children.get('dsh');
  if (rec && rec.pid) killTree(rec.pid);
  children.delete('dsh');
  const down = await waitPort(DSH_PORT, false, 8000);
  return down ? { ok: true } : { ok: false, error: '端口还在监听，可能是别处启动的实例，去任务管理器结束 node.exe' };
}

async function stopConsole() {
  const live = await probePort(CONSOLE_PORT);
  if (!live) { log('控制台本来就没在跑', 'ok'); return { ok: true, already: true }; }
  const rec = children.get('console');
  if (rec && rec.pid) killTree(rec.pid);
  children.delete('console');
  const down = await waitPort(CONSOLE_PORT, false, 8000);
  return down ? { ok: true } : { ok: false, error: '端口还在监听，可能不是本启动器拉起的' };
}

// ---------------------------------------------------------------- 体检
async function runCheck() {
  const items = [];
  const push = (id, label, status, detail, fix) => items.push({ id, label, status, detail, fix: fix || '' });

  const major = Number(process.versions.node.split('.')[0]);
  push('node', 'Node 运行时', major >= 20 ? 'ok' : 'bad',
    `v${process.versions.node}（${NODE_EXE}）`,
    major >= 20 ? '' : 'Node 至少 20。随身卡上自带 node 目录；若没有，去 nodejs.org 装 LTS。');

  push('dsh', 'DSH 本体', has(DSH_BIN) ? 'ok' : 'bad', DSH_BIN, has(DSH_BIN) ? '' : '把 dsh-workspace 放在卡根（或设环境变量 DSH_CHECKOUT）。');

  push('home', 'DSH 配置目录', IS_OWN_STACK ? 'ok' : 'warn',
    IS_OWN_STACK ? DSH_HOME : `${DSH_HOME}（本仓库里没有 .dsh/profiles）`,
    IS_OWN_STACK ? '' : '看起来你在仓库目录里跑，而不是在随身卡上。能用，但改不了配置块。');

  push('workspace', '工作目录', isDir(WORKSPACE) ? 'ok' : 'warn', WORKSPACE, isDir(WORKSPACE) ? '' : '工作目录不存在，agent 没法读写文件。');

  try {
    const probe = path.join(ROOT, '.write-probe');
    fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
    push('write', '可写盘', 'ok', `${ROOT} 可写`, '');
  } catch (e) {
    push('write', '可写盘', 'bad', String(e.message), '卡被写保护 / 只读挂载；或者用管理员身份运行。');
  }

  const dshUp = await probePort(DSH_PORT);
  push('port-dsh', `DSH 端口 ${DSH_PORT}`, dshUp ? 'ok' : 'idle', dshUp ? '已在运行' : '未占用（正常）', '');
  const conUp = await probePort(CONSOLE_PORT);
  push('port-console', `控制台端口 ${CONSOLE_PORT}`, conUp ? 'ok' : 'idle', conUp ? '已在运行' : '未占用（正常）', '');

  const keys = currentKeys();
  const anyKey = KEY_DEFS.some((k) => keys[k.key].set);
  push('key', 'API Key', anyKey ? 'ok' : 'warn',
    anyKey ? KEY_DEFS.filter((k) => keys[k.key].set).map((k) => `${k.label}(${keys[k.key].masked})`).join('、') : '一个都没填',
    anyKey ? '' : '没有 Key 也能启动界面，但 agent 无法调用模型。到「② 填 Key」里填。');

  const ready = items.filter((x) => x.status === 'bad').length === 0;
  return {
    ready, items,
    paths: { root: ROOT, dshBin: DSH_BIN, dshHome: DSH_HOME, workspace: WORKSPACE, node: NODE_EXE, ownStack: IS_OWN_STACK },
    ports: { dsh: DSH_PORT, console: CONSOLE_PORT, launcher: LAUNCHER_PORT },
    url: dshUrlTokenMap(),
  };
}

async function testKey(kind) {
  const def = KEY_DEFS.find((k) => k.key === kind);
  if (!def) return { ok: false, error: '未知的 Key 类型' };
  const val = currentKeys()[kind].value;
  if (!val) return { ok: false, error: '还没填这个 Key' };
  const base = (readConfig().settings && readConfig().settings.apiBase) || def.base;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${val}` }, signal: ctrl.signal,
    });
    const text = await res.text();
    let count = 0;
    try { const j = JSON.parse(text); count = Array.isArray(j.data) ? j.data.length : 0; } catch { /* 非 JSON */ }
    if (res.ok) return { ok: true, detail: `可用（${base}，返回 ${count} 个模型）` };
    return { ok: false, error: `HTTP ${res.status}：${text.slice(0, 160)}` };
  } catch (e) {
    return { ok: false, error: `连不上 ${base}：${e.name === 'AbortError' ? '超时' : e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- HTTP 服务
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': `http://127.0.0.1:${LAUNCHER_PORT}`,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1 << 20) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${LAUNCHER_PORT}`);
  const p = u.pathname;

  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const file = path.join(HERE, 'index.html');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(file));
    }

    if (req.method === 'GET' && p === '/api/check') return sendJson(res, 200, await runCheck());

    if (req.method === 'GET' && p === '/api/config') {
      return sendJson(res, 200, {
        keys: currentKeys(), keyDefs: KEY_DEFS.map((k) => ({ key: k.key, label: k.label, hint: k.hint })),
        modules: currentModules(), moduleDefs: MODULE_DEFS,
        ownStack: IS_OWN_STACK,
      });
    }

    if (req.method === 'POST' && p === '/api/config') {
      const body = await readBody(req);
      const cfg = readConfig();
      cfg.settings = cfg.settings || {};
      if (body.env && typeof body.env === 'object') {
        const env = { ...(cfg.settings.env || {}) };
        for (const [k, v] of Object.entries(body.env)) {
          if (!KEY_DEFS.some((d) => d.key === k)) continue;
          if (v === '' || v == null) delete env[k]; else env[k] = String(v).trim();
        }
        cfg.settings.env = env;
      }
      if (body.modules && typeof body.modules === 'object') {
        cfg.settings.modules = { ...currentModules(), ...body.modules };
      }
      writeConfig(cfg);
      let applied = null;
      if (body.modules) applied = applyModules(currentModules());
      log('配置已保存' + (body.modules ? '（模块开关已应用）' : ''), 'ok');
      return sendJson(res, 200, { ok: true, applied, keys: currentKeys(), modules: currentModules() });
    }

    if (req.method === 'POST' && p === '/api/keytest') {
      const body = await readBody(req);
      const r = await testKey(body.kind);
      log(`测试 ${body.kind}：${r.ok ? '通过 ' + r.detail : '失败 ' + r.error}`, r.ok ? 'ok' : 'warn');
      return sendJson(res, 200, r);
    }

    if (req.method === 'GET' && p === '/api/state') {
      const [dshUp, conUp] = await Promise.all([probePort(DSH_PORT), probePort(CONSOLE_PORT)]);
      const tok = dshUrlTokenMap();
      return sendJson(res, 200, {
        dsh: { up: dshUp, port: DSH_PORT, url: tok ? `http://127.0.0.1:${tok.port}/?token=${tok.token}` : '' },
        console: { up: conUp, port: CONSOLE_PORT, url: conUp ? `http://127.0.0.1:${CONSOLE_PORT}/` : '' },
        children: [...children.entries()].map(([k, v]) => ({ name: k, pid: v.pid, startedAt: v.startedAt })),
      });
    }

    if (req.method === 'POST' && p === '/api/start') {
      const body = await readBody(req);
      const task = body.target || 'all';
      if (task === 'dsh') return sendJson(res, 200, await startDsh());
      if (task === 'console') return sendJson(res, 200, await startConsole());
      const d = await startDsh();
      const c = await startConsole();
      return sendJson(res, 200, { ok: d.ok && c.ok, dsh: d, console: c });
    }

    if (req.method === 'POST' && p === '/api/stop') {
      const body = await readBody(req);
      const task = body.target || 'all';
      if (task === 'dsh') return sendJson(res, 200, await stopDsh());
      if (task === 'console') return sendJson(res, 200, await stopConsole());
      const d = await stopDsh();
      const c = await stopConsole();
      return sendJson(res, 200, { ok: d.ok && c.ok, dsh: d, console: c });
    }

    if (req.method === 'GET' && p === '/api/logs') {
      const since = Number(u.searchParams.get('since') || 0);
      const lines = logs.filter((l) => l.i > since);
      return sendJson(res, 200, { lines, next: since + lines.length, seq: logSeq });
    }

    if (req.method === 'GET' && p === '/api/open') {
      const target = u.searchParams.get('target') || 'dsh';
      const tok = dshUrlTokenMap();
      const url = target === 'console' ? `http://127.0.0.1:${CONSOLE_PORT}/` : (tok ? `http://127.0.0.1:${tok.port}/?token=${tok.token}` : `http://127.0.0.1:${DSH_PORT}/`);
      openBrowser(url);
      return sendJson(res, 200, { ok: true, url });
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (e) {
    log(`接口出错 ${p}: ${e && e.message}`, 'warn');
    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

function openBrowser(url) {
  try {
    if (IS_WIN) spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', windowsHide: true, detached: true }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  } catch { /* 打不开就算了，界面上也给了地址 */ }
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n[!] 端口 ${LAUNCHER_PORT} 已被占用。换个端口：node launcher/server.mjs --port 3401\n`);
  } else console.error(e);
  process.exit(1);
});

server.listen(LAUNCHER_PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${LAUNCHER_PORT}/`;
  log(`启动器已就绪：${url}`, 'ok');
  console.log(`
  ┌──────────────────────────────────────────────┐
  │  DSH 随身卡 · 新手启动器                     │
  │  ${url.padEnd(42)}│
  │  关掉这个窗口 = 关闭启动器（不会停 DSH）     │
  └──────────────────────────────────────────────┘
`);
  if (!NO_OPEN) openBrowser(url);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('启动器退出（已启动的 DSH / 控制台继续运行）', 'warn');
    process.exit(0);
  });
}