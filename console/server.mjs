#!/usr/bin/env node
/**
 * DeepSeek × QQ 控制台 —— 本地管理面板服务
 *
 * 零外部依赖（只用 node: 内置模块），监听 127.0.0.1:3300（被占用时退到 3310）。
 * 功能：
 *   GET  /                     控制面板页面（index.html）
 *   GET  /api/status           各服务状态（DSH / SnowLuma / QQ-Bridge / 机器人 QQ / 端口）
 *   GET  /api/logs?source=..   读取日志尾部（bridge | snowluma）
 *   GET  /api/processes        相关 node.exe / 守护进程列表
 *   POST /api/action           启动 / 停止 / 重启（停止类必须带 confirm:true）
 *
 * 安全约束：绝不操作 3080（DSH Web），只管理 SnowLuma(5099) 与 QQ-Bridge(3100)。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const CONSOLE_DIR = path.dirname(__filename);
const WORKSPACE = path.resolve(CONSOLE_DIR, '..');
const LOG_DIR = path.join(CONSOLE_DIR, 'logs');
const STATE_DIR = path.join(CONSOLE_DIR, 'state');
const PANEL_LOG = path.join(LOG_DIR, 'panel.log');
const GUARD_PID_FILE = path.join(STATE_DIR, 'bridge-guard.pid');
const HTML_PATH = path.join(CONSOLE_DIR, 'index.html');

const NODE_EXE =
  process.env.DSH_QQ_CONSOLE_NODE ||
  process.execPath; // 默认用跑控制台自己的那个 node（便携栈里就是卡上的 node）
const NODE_DIR = path.dirname(NODE_EXE);

const SNOWLUMA_DIR = path.join(WORKSPACE, 'SnowLuma');
const SNOWLUMA_NODE = path.join(SNOWLUMA_DIR, 'node.exe');
const SNOWLUMA_LOG = path.join(SNOWLUMA_DIR, 'logs', 'console.log');
const SNOWLUMA_URL = 'http://127.0.0.1:5099';

const BRIDGE_DIR = path.join(WORKSPACE, 'qq-bridge');
const BRIDGE_STATE_DIR = path.join(BRIDGE_DIR, 'state');
const BRIDGE_LOG = path.join(BRIDGE_STATE_DIR, 'bridge.log');
const BRIDGE_TOKEN_FILE = path.join(BRIDGE_STATE_DIR, 'console-token');
const BRIDGE_LOCK_FILE = path.join(BRIDGE_STATE_DIR, 'bridge.lock');
const BRIDGE_CONFIG = path.join(BRIDGE_DIR, 'config.json');
const BRIDGE_URL = 'http://127.0.0.1:3100';
const PANEL_CONFIG_FILE = path.join(CONSOLE_DIR, 'panel.config.json');
// 模块开关写进卡根的声明式裁剪清单，再由 portable-repath.mjs 落到 DSH 配置里
const STRIP_FILE = path.join(WORKSPACE, 'portable-strip.txt');
const REPATH_CANDIDATES = [
  path.join(WORKSPACE, 'portable-repath.mjs'),
  path.join(WORKSPACE, 'portable', 'portable-repath.mjs'),
];
// QQ 客户端默认路径（可在 console/panel.config.json 的 qqExe 覆盖）
const DEFAULT_QQ_EXE = process.env.QQ_EXE || '';

const DSH_URL = 'http://127.0.0.1:3080';
const DSH_DIR = process.env.DSH_CHECKOUT || path.join(WORKSPACE, '..', 'dsh-workspace');
const DSH_START_BAT = path.join(DSH_DIR, 'start-dsh.bat');
const DSH_RESTART_LOG = path.join(LOG_DIR, 'dsh-restart.log');
const ONEBOT_HTTP = 'http://127.0.0.1:3000';

const PORTS = { dsh: 3080, snowluma: 5099, onebotHttp: 3000, onebotWs: 3001, bridge: 3100, gptSovits: 9880 };

const GPT_DIR = path.join(WORKSPACE, 'gpt-sovits');
const GPT_START_CMD = path.join(GPT_DIR, 'start_api.cmd');
const GPT_VOICE_ENGINE = path.join(GPT_DIR, 'voice-engine.json');
const GPT_URL = `http://127.0.0.1:${PORTS.gptSovits}/tts`;
// 任何情况下都不允许操作这些端口。
// 唯一例外：用户显式点击「重启 DSH」按钮（restart-dsh），且只有该动作可以结束 3080 的 owner。
const PROTECTED_PORTS = new Set([PORTS.dsh]);

const CONFIRM_ACTIONS = new Set([
  'stop-bridge',
  'stop-snowluma',
  'restart-bridge',
  'restart-snowluma',
  'restart-dsh',
  'stop-gpt-sovits',
]);
const ACTION_LABELS = {
  'start-all': '一键启动',
  'start-snowluma': '启动 SnowLuma',
  'start-bridge': '启动 QQ 桥接',
  'stop-bridge': '停止 QQ 桥接',
  'stop-snowluma': '停止 SnowLuma',
  'restart-bridge': '重启 QQ 桥接',
  'restart-dsh': '重启 DSH',
  'start-gpt-sovits': '启动 GPT-SoVITS API',
  'stop-gpt-sovits': '停止 GPT-SoVITS API',
};

// 唤醒 QQ 会话时投递给 DSH agent 的固定提醒（restart-dsh 成功后自动发一次）
const NUDGE_MESSAGE =
  '请先 qq_get_unread_messages 查看未读并尽快回复对方；如果之前遇到"发送频率超限"，现在上限已放宽，正常回复即可。管理员私聊里不要再用超过 60 秒的 qq_wait_for_messages。';

let PANEL_PORT = 3300;
const STARTED_AT = Date.now();

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(PANEL_LOG, line, 'utf8');
  } catch {
    /* 日志失败不能影响主流程 */
  }
  try {
    process.stdout.write(line);
  } catch {
    /* 无控制台时忽略 */
  }
}

/** 执行外部命令，永不抛异常、永不挂住。 */
function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    let child;
    try {
      child = execFile(
        file,
        args,
        {
          windowsHide: true,
          timeout: opts.timeout || 8000,
          maxBuffer: opts.maxBuffer || 8 * 1024 * 1024,
          encoding: 'utf8',
        },
        (err, stdout, stderr) => {
          finish({
            ok: !err,
            code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
            stdout: stdout || '',
            stderr: stderr || '',
            error: err ? String(err.message || err) : '',
          });
        },
      );
    } catch (err) {
      finish({ ok: false, code: 1, stdout: '', stderr: '', error: String(err) });
      return;
    }
    if (child && typeof child.on === 'function') {
      child.on('error', (err) => {
        finish({ ok: false, code: 1, stdout: '', stderr: '', error: String(err) });
      });
    }
  });
}

/** TCP 端口连通性探测（用于端口是否在监听）。 */
function tcpProbe(port, timeout = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const sock = net.connect({ host: '127.0.0.1', port });
    const finish = (v) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/** HTTP(S) 服务存活探测：任何 HTTP 响应都算在线。 */
async function httpUp(url, timeout = 1800) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return { up: true, status: res.status };
  } catch {
    return { up: false, status: null };
  }
}

/** 带超时的 JSON GET（请求头可带 token）。 */
async function getJson(url, { headers = {}, timeout = 2000 } = {}) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: { accept: 'application/json', ...headers },
    });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    const data = await res.json();
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, status: null, data: null, error: String(err) };
  }
}

/** 读取文本文件尾部若干行（UTF-8，最多读 256KB）。 */
async function readTailLines(file, maxLines = 200, maxBytes = 256 * 1024) {
  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
    const st = await fh.stat();
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    if (len > 0) await fh.read(buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const i = text.indexOf('\n');
      if (i >= 0) text = text.slice(i + 1);
    }
    text = text.replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/);
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return { lines: lines.slice(-maxLines), size: st.size, mtime: st.mtimeMs, missing: false };
  } catch {
    return { lines: [], size: 0, mtime: 0, missing: true };
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/** netstat -ano 解析出所有 LISTENING 端口 -> PID。 */
let _portCache = { at: 0, map: new Map() };
async function listeningPorts() {
  if (Date.now() - _portCache.at < 1500) return _portCache.map;
  const map = new Map();
  const r = await run('netstat.exe', ['-ano'], { timeout: 5000 });
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+\S*?:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (m) map.set(Number(m[1]), Number(m[2]));
  }
  _portCache = { at: Date.now(), map };
  return map;
}

/** 相关进程列表（node.exe + 桥接守护 cmd.exe），带 4 秒缓存。 */
const PS_LIST =
  '$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='cmd.exe'\" | " +
  'Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 2';

function classifyProcess(name, cmd) {
  const c = String(cmd || '');
  if (!c) return null;
  if (name === 'cmd.exe') {
    if (/(start\.bat|run-bridge\.bat)/i.test(c) && /qq-bridge/i.test(c)) return 'bridge-guard';
    if (/run-snowluma/i.test(c)) return 'snowluma-guard';
    return null;
  }
  if (name !== 'node.exe') return null;
  // DSH 的临时子进程 runner 会把整段 PowerShell 脚本写进命令行，先排除，避免误判成服务
  if (/dsh-subprocess-local[\\/]+lib[\\/]+runner\.js/i.test(c)) return null;
  if (/console[\\/]+server\.mjs/i.test(c)) return 'panel';
  if (/mcp-[\w-]+\.js/i.test(c)) return 'mcp';
  if (/(^|[\\/\s])src[\\/]bridge\.js\b/i.test(c) || /[\\/]bridge\.js\b/i.test(c)) return 'bridge';
  if (/SnowLuma[\\/]+index\.mjs|[\\/\\\s]index\.mjs\b/i.test(c)) return 'snowluma';
  if (/(@deepseek-ai[\\/]+dsh|dsh[\\/]+lib[\\/]+bin\.js)/i.test(c)) return 'dsh';
  return null;
}

let _procCache = { at: 0, list: [] };
async function listProcesses(force = false) {
  if (!force && Date.now() - _procCache.at < 4000) return _procCache.list;
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_LIST], {
    timeout: 9000,
  });
  let raw = [];
  if (r.ok && r.stdout.trim()) {
    try {
      const parsed = JSON.parse(r.stdout.trim());
      raw = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      raw = [];
    }
  }
  const list = [];
  for (const p of raw) {
    if (!p || !p.ProcessId) continue;
    const kind = classifyProcess(p.Name, p.CommandLine);
    if (!kind) continue;
    list.push({
      pid: Number(p.ProcessId),
      ppid: Number(p.ParentProcessId || 0),
      name: p.Name,
      kind,
      cmdline: String(p.CommandLine || '').trim(),
    });
  }
  list.sort((a, b) => a.pid - b.pid);
  _procCache = { at: Date.now(), list };
  return list;
}

async function readTextFile(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** 读状态目录里记录的桥接守护 PID（startBridge 启动时写入）。 */
async function readGuardPid() {
  try {
    const t = await readTextFile(GUARD_PID_FILE);
    if (!t) return null;
    const j = JSON.parse(t);
    const n = Number(j.pid);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** 查询单个进程的命令行（用于确认记录下来的守护 PID 还是不是一个 start.bat）。 */
async function processCmdline(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return '';
  const script =
    '$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${n}" -ErrorAction SilentlyContinue; if($p){$p.CommandLine}`;
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 6000,
  });
  return r.ok ? r.stdout.trim() : '';
}

/** 查询单个进程的 name / cmdline / ppid（重启 DSH 前确认端口 owner 身份用）。 */
async function processInfo(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return { ok: false };
  const script =
    '$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${n}" -ErrorAction SilentlyContinue; ` +
    'if($p){[pscustomobject]@{name=$p.Name;cmdline=$p.CommandLine;ppid=$p.ParentProcessId}|ConvertTo-Json -Compress}';
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 6000,
  });
  if (!r.ok || !r.stdout.trim()) return { ok: false };
  try {
    const j = JSON.parse(r.stdout.trim());
    return { ok: true, name: j.name || '', cmdline: j.cmdline || '', ppid: Number(j.ppid) || 0 };
  } catch {
    return { ok: false };
  }
}

async function clearGuardPidFile() {
  try {
    if (fs.existsSync(GUARD_PID_FILE)) await fsp.unlink(GUARD_PID_FILE);
  } catch {
    /* ignore */
  }
}

/** 控制台 token（桥接的 /api/status 需要）。 */
async function bridgeConsoleToken() {
  const t = await readTextFile(BRIDGE_TOKEN_FILE);
  return t ? t.trim() : '';
}

/**
 * 面板「登录密钥」卡片用的数据：全部动态读取本机文件，读不到就给空串 + error，绝不 500。
 * 返回 { snowluma:{url,user,password,error}, bridge:{url,token,error,source},
 *        onebot:{httpUrl,wsUrl,accessToken,error}, note }
 */
async function buildCredentials() {
  const out = {
    snowluma: { url: SNOWLUMA_URL, user: '', password: '', error: '' },
    bridge: { url: BRIDGE_URL, token: '', error: '', source: '' },
    onebot: { httpUrl: ONEBOT_HTTP, wsUrl: 'ws://127.0.0.1:3001', accessToken: '', error: '' },
    note: '仅本机回环可见',
  };

  // SnowLuma 网关登录：console/panel.config.json
  try {
    const text = await readTextFile(PANEL_CONFIG_FILE);
    if (!text) throw new Error(`找不到 console/panel.config.json`);
    const cfg = JSON.parse(text.replace(/^\uFEFF/, ''));
    const sl = (cfg && cfg.snowluma) || {};
    out.snowluma.user = String(sl.user || '');
    out.snowluma.password = String(sl.password || '');
    if (!out.snowluma.password) out.snowluma.error = 'panel.config.json 里没有 snowluma.password';
  } catch (err) {
    out.snowluma.error = String(err && err.message ? err.message : err);
  }

  // 桥接控制台令牌 & OneBot 连接信息：qq-bridge/config.json + state/console-token
  let consoleTokenFromConfig = '';
  try {
    const text = await readTextFile(BRIDGE_CONFIG);
    if (!text) throw new Error('找不到 qq-bridge/config.json');
    const cfg = JSON.parse(text.replace(/^\uFEFF/, ''));
    const sl = (cfg && cfg.snowluma) || {};
    if (sl.httpUrl) out.onebot.httpUrl = String(sl.httpUrl);
    if (sl.wsUrl) out.onebot.wsUrl = String(sl.wsUrl);
    out.onebot.accessToken = String(sl.accessToken || '');
    if (!out.onebot.accessToken) out.onebot.error = 'config.json 里没有 snowluma.accessToken';
    consoleTokenFromConfig = String((cfg && cfg.consoleToken) || '').trim();
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    out.onebot.error = out.onebot.error || msg;
  }

  let consoleTokenFromState = '';
  try {
    const tok = await readTextFile(BRIDGE_TOKEN_FILE);
    if (tok) consoleTokenFromState = tok.trim();
  } catch {
    /* ignore */
  }
  // config.json 的 consoleToken 非空时优先，否则用 state/console-token
  if (consoleTokenFromConfig) {
    out.bridge.token = consoleTokenFromConfig;
    out.bridge.source = 'qq-bridge/config.json → consoleToken';
  } else if (consoleTokenFromState) {
    out.bridge.token = consoleTokenFromState;
    out.bridge.source = 'qq-bridge/state/console-token';
  } else {
    out.bridge.error = 'qq-bridge/config.json 的 consoleToken 为空，且读不到 state/console-token';
  }
  if (out.bridge.error && !out.bridge.token) {
    out.bridge.error = out.bridge.error || '桥接控制台令牌读取失败';
  }
  return out;
}

/** SnowLuma OneBot HTTP token：从 qq-bridge/config.json 读。 */
async function onebotToken() {
  const text = await readTextFile(BRIDGE_CONFIG);
  if (!text) return '';
  try {
    const cfg = JSON.parse(text.replace(/^\uFEFF/, ''));
    return String((cfg && cfg.snowluma && cfg.snowluma.accessToken) || '');
  } catch {
    return '';
  }
}

async function onebotLoginInfo(token) {
  try {
    const res = await fetch(`${ONEBOT_HTTP}/get_login_info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{}',
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const j = await res.json();
    const d = (j && (j.data || j)) || {};
    if (d.user_id) return { ok: true, user_id: d.user_id, nickname: d.nickname || '' };
    return { ok: false, error: '返回中没有 user_id' };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/* ------------------------------------------------------------------ */
/* SnowLuma 登录 + QQ 进程注入（重启电脑后一键恢复的关键能力）          */
/* ------------------------------------------------------------------ */

/** 读取 console/panel.config.json（SnowLuma 账号密码、机器人 QQ）。 */
async function loadPanelConfig() {
  const text = await readTextFile(PANEL_CONFIG_FILE);
  if (!text) return null;
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

let _slSession = { token: null, at: 0 };

/* ------------------------------------------------------------------ */
/* 模块开关 + API Key（图形化配置）                                     */
/* ------------------------------------------------------------------ */

// 默认全开；语音模块默认关（卡上不带语音，见 docs/便携卡使用说明.md）
const DEFAULT_MODULES = {
  qqBridge: true,
  snowluma: true,
  douyin: true,
  phone: true,
  mcpSnowluma: true,
  mcpSnowlumaHost: true,
  mcpWebSearch: true,
  mcpSharedMemory: true,
  mcpTtsVoice: false,
};

// 模块 key → cordis.patch.yml 里的 MCP 条目 id 前缀
const MCP_MODULE_IDS = {
  mcpSnowluma: 'mcp-snowluma',
  mcpSnowlumaHost: 'mcp-snowluma-host',
  mcpWebSearch: 'mcp-web-search-safe',
  mcpSharedMemory: 'mcp-shared-memory',
  mcpTtsVoice: 'mcp-tts-voice',
};

// 控制台面板上直接暴露的 Key（值只写本机 panel.config.json，不写进仓库）
const KNOWN_KEYS = [
  { key: 'COCO_KEY', label: '视觉 / 多模态 API Key', hint: '手机操控看屏幕、图片复核用；兼容 OpenAI 协议的 key 都行' },
  { key: 'OPENAI_API_KEY', label: 'OpenAI API Key', hint: '可留空；填了会作为视觉/模型的兜底 key' },
  { key: 'COCO_API_KEY', label: '模型通道 Key（COCO）', hint: 'DSH 走中转时的模型 key；留空则用 DSH 自己的凭据文件' },
  { key: 'COCO233_API_KEY', label: '模型通道 Key（备用线路）', hint: '可选，第二条中转线路' },
];

const SETTINGS_KEYS = KNOWN_KEYS.map((k) => k.key);

async function loadSettings() {
  const cfg = (await loadPanelConfig()) || {};
  const s = cfg.settings || {};
  return {
    modules: { ...DEFAULT_MODULES, ...(s.modules || {}) },
    env: { ...(s.env || {}) },
  };
}

/** 合并写入 panel.config.json 的 settings 段（不动其它已有字段）。 */
async function saveSettings(patch) {
  const cfg = (await loadPanelConfig()) || {};
  const s = cfg.settings || {};
  const modules = { ...DEFAULT_MODULES, ...(s.modules || {}), ...((patch && patch.modules) || {}) };
  const env = { ...(s.env || {}), ...((patch && patch.env) || {}) };
  for (const k of Object.keys(env)) {
    const v = env[k];
    if (v === null || v === undefined || String(v).trim() === '') delete env[k];
    else env[k] = String(v).trim();
  }
  cfg.settings = { modules, env };
  await fsp.mkdir(CONSOLE_DIR, { recursive: true });
  await fsp.writeFile(PANEL_CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return cfg.settings;
}

function maskKey(value) {
  if (!value) return null;
  const s = String(value);
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** 子进程环境：process.env + 面板里配的 Key（面板优先）。 */
async function panelEnv() {
  const s = await loadSettings();
  const env = { ...process.env };
  for (const [k, v] of Object.entries(s.env)) if (v) env[k] = v;
  // 只填了 COCO_KEY 时也当作模型通道 key 的低优先兜底
  if (!env.COCO_API_KEY && env.COCO_KEY) env.COCO_API_KEY = env.COCO_KEY;
  return env;
}

/**
 * 把模块开关落到卡根的 portable-strip.txt，并跑一次 portable-repath.mjs。
 * 关掉的 MCP 模块会从 DSH 配置里整段摘掉（重启 DSH 后工具列表里就没有了）。
 */
async function applyModuleSwitches(modules) {
  const disabled = Object.entries(MCP_MODULE_IDS)
    .filter(([mk]) => !modules[mk])
    .map(([, id]) => id);
  const text = [
    '# 由本地控制台「模块开关」维护：一行一个要关闭的配置块 id 前缀',
    '# 关掉的模块不会出现在 DSH 的工具列表里；改完要重启 DSH 才生效',
    ...disabled,
  ].join('\n') + '\n';

  let old = null;
  try {
    old = await fsp.readFile(STRIP_FILE, 'utf8');
  } catch {
    old = null;
  }
  const changed = old !== text;
  if (changed) await fsp.writeFile(STRIP_FILE, text, 'utf8');

  // 只有本控制台所在的栈自己有 .dsh/profiles 时才允许改写配置，
  // 否则（例如在源码仓里直接跑控制台）会误改别的安装。
  const ownHome = path.join(WORKSPACE, '.dsh', 'profiles');
  if (!fs.existsSync(ownHome)) {
    return { changed, disabled, repath: null, note: '本栈没有 .dsh/profiles，已跳过改写；在卡上运行时会自动生效' };
  }
  const script = REPATH_CANDIDATES.find((p) => fs.existsSync(p));
  if (!script) {
    return { changed, disabled, repath: null, note: '没找到 portable-repath.mjs，改动会在下次启动时由 start-dsh.bat 应用' };
  }
  const r = await run(NODE_EXE, [script], { cwd: WORKSPACE, timeoutMs: 30000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { changed, disabled, repath: { ok: r.code === 0, output: out.slice(0, 800) } };
}

/** 用 panel.config.json 的账号密码登录 SnowLuma，拿 Bearer token。 */
async function snowlumaLogin(force = false) {
  if (!force && _slSession.token && Date.now() - _slSession.at < 5 * 60 * 1000) {
    return { ok: true, token: _slSession.token, cached: true };
  }
  const cfg = await loadPanelConfig();
  const user = (cfg && cfg.snowluma && cfg.snowluma.user) || 'admin';
  const password = (cfg && cfg.snowluma && cfg.snowluma.password) || '';
  if (!password) {
    return { ok: false, detail: 'panel.config.json 里没有 snowluma.password', hint: '控制台配置缺少 SnowLuma 密码' };
  }
  try {
    const res = await fetch(`${SNOWLUMA_URL}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user, password }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j || j.success !== true || !j.token) {
      return {
        ok: false,
        detail: `登录失败（HTTP ${res.status}）`,
        hint: 'SnowLuma 未启动或密码不对',
      };
    }
    _slSession = { token: j.token, at: Date.now() };
    return { ok: true, token: j.token, mustChangePassword: !!j.mustChangePassword };
  } catch (err) {
    return { ok: false, detail: String(err), hint: 'SnowLuma 未启动或密码不对' };
  }
}

/** 调 SnowLuma 的 HTTP API（自动带 token，401 时重登一次）。 */
async function snowlumaApi(pathname, { method = 'GET', timeout = 8000, retry = true } = {}) {
  const login = await snowlumaLogin();
  if (!login.ok) return { ok: false, loginFailed: true, hint: login.hint, detail: login.detail };
  try {
    const res = await fetch(`${SNOWLUMA_URL}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${login.token}` },
      signal: AbortSignal.timeout(timeout),
    });
    if (res.status === 401 && retry) {
      const relogin = await snowlumaLogin(true);
      if (relogin.ok) return snowlumaApi(pathname, { method, timeout, retry: false });
      return { ok: false, status: 401, hint: 'SnowLuma 登录已失效，且重新登录失败' };
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: null, detail: String(err) };
  }
}

/**
 * 注入状态快照（内存里的最近一次结果，/api/status 直接读它，不发网络请求）。
 * ok / running / pid / injected / uin / nickname / note / hint / at
 */
let _injection = {
  at: null,
  ok: null,
  running: false,
  pid: null,
  injected: null,
  uin: null,
  nickname: null,
  note: '尚未尝试注入',
  hint: null,
};
let _injectPromise = null;

function injectionView() {
  const at = _injection.at ? Date.parse(_injection.at) : 0;
  return { ..._injection, ageMs: at ? Date.now() - at : null };
}

function setInjection(patch) {
  _injection = { ..._injection, ...patch };
}

/** 轮询 SnowLuma 的 QQ 列表，直到出现目标 QQ（或任意 uin）。 */
async function pollQqList(botQQ, deadlineMs, shouldStopWaiting) {
  const startedAt = Date.now();
  let lastList = [];
  while (Date.now() - startedAt < deadlineMs) {
    const q = await snowlumaApi('/api/qq-list', { timeout: 5000 });
    if (q.ok && q.data && Array.isArray(q.data.list)) {
      lastList = q.data.list;
      const target = botQQ
        ? lastList.find((x) => String(x.uin) === String(botQQ))
        : lastList[0] || null;
      if (target) return { target, list: lastList };
      if (shouldStopWaiting && shouldStopWaiting()) return { target: null, list: lastList };
    } else if (!q.loginFailed && q.status === null && Date.now() - startedAt > 15000) {
      // SnowLuma 连不上了，提前结束，别把 60 秒耗完
      return { target: null, list: lastList, error: q.detail };
    }
    await sleep(1500);
  }
  return { target: null, list: lastList };
}

/**
 * 自动注入 QQ 进程（只调 SnowLuma 的 load 接口，绝不 stop/kill QQ）。
 * 返回 { ok, pid, injected, uin, nickname, loggedInNote, hint? }
 */
async function doInjectQQ() {
  const startedAt = new Date();
  setInjection({ running: true, at: startedAt.toISOString(), ok: null, hint: null, note: '正在注入…' });
  const done = (patch, note) => {
    setInjection({ ...patch, running: false, at: new Date().toISOString(), note });
    return { ...patch, note };
  };

  if (!(await tcpProbe(PORTS.snowluma, 1500))) {
    return done({ ok: false, hint: 'SnowLuma 未启动或密码不对' }, 'SnowLuma 未运行');
  }
  const cfg = await loadPanelConfig();
  if (!cfg) {
    return done({ ok: false, hint: '缺少 console/panel.config.json（里面放 SnowLuma 账号密码）' }, '控制台配置缺失');
  }
  const botQQ = cfg.botQQ ? String(cfg.botQQ) : '';

  const procsRes = await snowlumaApi('/api/processes', { timeout: 8000 });
  if (!procsRes.ok) {
    return done(
      { ok: false, loggedInNote: null, hint: 'SnowLuma 未启动或密码不对' },
      `读取 SnowLuma 进程列表失败${procsRes.detail ? '：' + procsRes.detail : ''}`,
    );
  }
  const list = procsRes.data && Array.isArray(procsRes.data.list) ? procsRes.data.list : [];
  const qqProc = list.find((p) => String(p && p.name).toLowerCase() === 'qq.exe' && Number(p && p.pid) > 0);
  if (!qqProc) {
    return done({ ok: false, hint: 'QQ 没启动' }, 'SnowLuma 里没有找到 QQ.exe 进程');
  }
  const pid = Number(qqProc.pid);
  const alreadyInjected = qqProc.injected === true;
  let injected = alreadyInjected;
  let loggedIn = qqProc.loggedIn === true;
  const notes = [];
  if (alreadyInjected) {
    notes.push('QQ 进程已注入，跳过 load');
  } else {
    const loadRes = await snowlumaApi(`/api/processes/${pid}/load`, { method: 'POST', timeout: 20000 });
    if (!loadRes.ok) {
      const detail = loadRes.detail || (loadRes.status ? `HTTP ${loadRes.status}` : '未知错误');
      return done(
        { ok: false, pid, injected: false, loggedInNote: null, hint: `注入失败：${detail}` },
        `已找到 QQ.exe（PID ${pid}），但调用 load 注入失败`,
      );
    }
    notes.push('已调用 load 注入接口');
    injected = true;
    // 刷新一次进程信息，拿到 loggedIn/uin
    const re = await snowlumaApi('/api/processes', { timeout: 8000 });
    if (re.ok && re.data && Array.isArray(re.data.list)) {
      const p2 = re.data.list.find((p) => Number(p && p.pid) === pid);
      if (p2) loggedIn = p2.loggedIn === true;
    }
  }

  // 轮询 qq-list，最多 60 秒
  const pollStart = Date.now();
  const softDeadline = alreadyInjected ? 12000 : 25000;
  const polled = await pollQqList(botQQ, 60000, () => {
    // QQ 没登录时，没人扫码就不会变，别一直等到 60 秒
    return !loggedIn && Date.now() - pollStart > softDeadline;
  });
  const target = polled.target;
  if (target) {
    const uin = target.uin ? String(target.uin) : null;
    const nickname = target.nickname || null;
    const matchBot = botQQ ? String(uin) === botQQ : true;
    const loggedInNote = `QQ 已注入并读取到账号 uin ${uin}${nickname ? `（${nickname}）` : ''}${
      matchBot ? '' : `，注意不是配置里的机器人 QQ ${botQQ}`
    }`;
    return done(
      { ok: true, pid, injected: true, uin, nickname, loggedInNote, hint: null },
      'QQ 注入完成',
    );
  }
  if (!loggedIn) {
    return done(
      {
        ok: false,
        pid,
        injected,
        uin: null,
        nickname: null,
        loggedInNote: 'QQ 进程已注入，但账号未登录',
        hint: `QQ 未登录，请在 SnowLuma 面板里扫码登录小号 ${botQQ || ''}`.trim(),
      },
      'QQ 未登录，需要扫码',
    );
  }
  return done(
    {
      ok: false,
      pid,
      injected,
      uin: null,
      nickname: null,
      loggedInNote: 'QQ 已登录，但暂未从 qq-list 读到 uin',
      hint: 'QQ 已登录但暂时读不到账号列表，请稍后点「重新注入 QQ」或在 SnowLuma 面板确认',
    },
    'qq-list 为空',
  );
}

/** 带并发保护的注入入口。 */
function injectQQ() {
  if (_injectPromise) return _injectPromise;
  _injectPromise = doInjectQQ()
    .catch((err) => {
      const msg = String(err && err.message ? err.message : err);
      setInjection({ ok: false, running: false, at: new Date().toISOString(), hint: `注入异常：${msg}`, note: '注入异常' });
      return { ok: false, hint: `注入异常：${msg}` };
    })
    .finally(() => {
      _injectPromise = null;
    });
  return _injectPromise;
}

/* ------------------------------------------------------------------ */
/* 状态汇总                                                            */
/* ------------------------------------------------------------------ */

let _statusCache = { at: 0, data: null };
async function buildStatus() {
  if (Date.now() - _statusCache.at < 900 && _statusCache.data) return _statusCache.data;

  const [dshProbe, slProbe, obProbe, obWsUp, brProbe, gptProbe] = await Promise.all([
    httpUp(`${DSH_URL}/`, 1800),
    httpUp(`${SNOWLUMA_URL}/`, 1800),
    tcpProbe(PORTS.onebotHttp, 1200),
    tcpProbe(PORTS.onebotWs, 1200),
    tcpProbe(PORTS.bridge, 1200),
    tcpProbe(PORTS.gptSovits, 1200),
  ]);

  const bridge = {
    up: brProbe,
    url: BRIDGE_URL,
    mode: null,
    role: null,
    roleMode: null,
    dshReady: null,
    ownerQQ: null,
    allowGroups: [],
    allowPrivate: [],
    allowAllWhenEmpty: null,
    socialV2Paused: null,
    snowluma: {
      connected: false,
      accountOnline: false,
      good: false,
      lastPacketAgoMs: null,
      lastPacketKind: null,
      silent: null,
      degraded: null,
      hint: null,
    },
    error: null,
  };
  if (brProbe) {
    const token = await bridgeConsoleToken();
    const r = await getJson(`${BRIDGE_URL}/api/status`, {
      headers: token ? { 'x-console-token': token } : {},
      timeout: 2000,
    });
    if (r.ok && r.data) {
      const d = r.data;
      bridge.mode = d.mode ?? null;
      bridge.role = d.role ?? null;
      bridge.roleMode = d.roleMode ?? null;
      bridge.dshReady = typeof d.dshReady === 'boolean' ? d.dshReady : null;
      bridge.ownerQQ = d.ownerQQ ?? null;
      bridge.allowGroups = Array.isArray(d.allowGroups) ? d.allowGroups : [];
      bridge.allowPrivate = Array.isArray(d.allowPrivate) ? d.allowPrivate : [];
      bridge.socialV2Paused = d.socialV2Paused ?? null;
      const sl = d.snowluma || {};
      bridge.snowluma = {
        connected: !!sl.connected,
        accountOnline: !!sl.accountOnline,
        good: !!sl.good,
        lastPacketAgoMs: typeof sl.lastPacketAgoMs === 'number' ? sl.lastPacketAgoMs : null,
        lastPacketKind: sl.lastPacketKind ?? null,
        silent: sl.silent ?? null,
        degraded: sl.degraded ?? null,
        hint: sl.hint ?? null,
      };
    } else {
      bridge.error = r.error || (r.status ? `HTTP ${r.status}（控制台 token 可能已变化）` : '无法读取桥接状态');
    }
  }

  // 白名单语义：allowAllWhenEmpty=true 且列表为空 = 全部；只读 config.json，不碰桥接进程
  try {
    const bcfgText = await readTextFile(BRIDGE_CONFIG);
    if (bcfgText) {
      const bcfg = JSON.parse(bcfgText.replace(/^\uFEFF/, ''));
      bridge.allowAllWhenEmpty = typeof bcfg.allowAllWhenEmpty === 'boolean' ? bcfg.allowAllWhenEmpty : null;
    }
  } catch {
    bridge.allowAllWhenEmpty = null;
  }

  let qq = null;
  if (obProbe) {
    const token = await onebotToken();
    const li = await onebotLoginInfo(token);
    qq = li.ok
      ? { user_id: li.user_id, nickname: li.nickname, online: true }
      : { user_id: null, nickname: null, online: false, error: li.error || '获取登录信息失败' };
  } else {
    qq = { user_id: null, nickname: null, online: false, error: 'OneBot HTTP(3000) 未监听' };
  }

  // GPT-SoVITS 语音引擎：端口是否监听 + voice-engine.json 的 enabled/label（动态读，不写死）
  let gptEngineCfg = null;
  let gptEngineError = null;
  try {
    gptEngineCfg = await loadVoiceEngineConfig();
    if (!gptEngineCfg) gptEngineError = `读不到或无法解析 ${GPT_VOICE_ENGINE}`;
  } catch (err) {
    gptEngineError = String(err && err.message ? err.message : err);
  }
  const gptSovits = {
    up: gptProbe,
    port: PORTS.gptSovits,
    engine: gptEngineCfg
      ? gptEngineCfg.enabled === true
        ? 'gpt-sovits'
        : gptEngineCfg.enabled === false
          ? 'edge-tts'
          : null
      : null,
    label: gptEngineCfg && typeof gptEngineCfg.label === 'string' ? gptEngineCfg.label : null,
    voiceEngineFile: GPT_VOICE_ENGINE,
    enabled: gptEngineCfg && typeof gptEngineCfg.enabled === 'boolean' ? gptEngineCfg.enabled : null,
    url: (gptEngineCfg && gptEngineCfg.url) || GPT_URL,
    error: gptEngineError,
  };

  // QQ 客户端进程（一键启动第 1 步会确保它在跑）
  let qqClientProcs = [];
  try {
    qqClientProcs = await qqClientProcesses();
  } catch {
    qqClientProcs = [];
  }
  const qqExe = await qqExePath();
  const qqClient = {
    up: qqClientProcs.length > 0,
    exePath: qqExe,
    exeExists: fs.existsSync(qqExe),
    count: qqClientProcs.length,
    pids: qqClientProcs.map((p) => p.pid),
    error: null,
  };

  const data = {
    panel: { name: 'deepseek-qq-console', port: PANEL_PORT, pid: process.pid, uptimeMs: Date.now() - STARTED_AT },
    now: new Date().toISOString(),
    dsh: { up: dshProbe.up, url: DSH_URL, protected: true },
    snowluma: {
      up: slProbe.up,
      url: SNOWLUMA_URL,
      qq,
      onebot: { http: obProbe, ws: obWsUp },
      logFile: SNOWLUMA_LOG,
      injection: injectionView(),
    },
    bridge,
    qqClient,
    gptSovits,
    ports: {
      panel: { port: PANEL_PORT, up: true },
      dsh: { port: PORTS.dsh, up: dshProbe.up },
      snowluma: { port: PORTS.snowluma, up: slProbe.up },
      onebotHttp: { port: PORTS.onebotHttp, up: obProbe },
      onebotWs: { port: PORTS.onebotWs, up: obWsUp },
      bridge: { port: PORTS.bridge, up: brProbe },
      gptSovits: { port: PORTS.gptSovits, up: gptProbe },
    },
    voice: { ready: !!gptProbe, note: '语音由桥接侧统一调度：GPT-SoVITS 优先，失败自动退回 Edge-TTS' },
  };
  // 面板刚启动、还没尝试过注入时，后台静默同步一次真实状态：
  // 已注入则只读 processes/qq-list（不会再调 load），让卡片不会误显示“未注入（尚未尝试）”。
  if (slProbe.up && _injection.ok === null && !_injection.running && !_injectPromise) {
    setTimeout(() => {
      injectQQ().catch(() => {});
    }, 50);
  }
  _statusCache = { at: Date.now(), data };
  return data;
}

/* ------------------------------------------------------------------ */
/* 进程 / 端口操作                                                      */
/* ------------------------------------------------------------------ */

async function killPid(pid, { tree = true } = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, detail: `无效 PID: ${pid}` };
  if (n === process.pid) return { ok: false, detail: '拒绝结束控制台自身进程' };
  const args = ['/PID', String(n)];
  if (tree) args.push('/T');
  args.push('/F');
  const r = await run('taskkill.exe', args, { timeout: 8000 });
  const msg = `${r.stdout}${r.stderr}`.trim();
  return { ok: r.ok, detail: msg || (r.ok ? `已结束 PID ${n}` : `结束 PID ${n} 失败`) };
}

async function waitPort(port, shouldBeUp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const up = await tcpProbe(port, 1000);
    if (up === shouldBeUp) return true;
    await sleep(350);
  } while (Date.now() < deadline);
  return (await tcpProbe(port, 1000)) === shouldBeUp;
}

function spawnDetached(file, args, { cwd, logName, env } = {}) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, logName || 'launch.log');
  const fd = fs.openSync(logFile, 'a');
  try {
    fs.writeSync(fd, `\n===== ${new Date().toISOString()} 启动: ${file} ${args.join(' ')}\n`);
    const child = spawn(file, args, {
      cwd,
      env: env || process.env,
      windowsHide: true,
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
    return { ok: true, pid: child.pid, logFile };
  } finally {
    // fd 会被子进程继承，父进程这一侧可以关闭
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

/* ---------------------------- GPT-SoVITS 语音引擎 ---------------------------- */

/** 读取 gpt-sovits/voice-engine.json（不存在/损坏返回 null）。 */
async function loadVoiceEngineConfig() {
  try {
    const text = await readTextFile(GPT_VOICE_ENGINE);
    if (!text) return null;
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** 找出 GPT-SoVITS API 相关进程（python api_v2.py 及包着它的 start_api.cmd 的 cmd）。 */
async function gptSovitsProcesses() {
  const script =
    '$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
    "Get-CimInstance Win32_Process -Filter \"Name='python.exe' OR Name='cmd.exe'\" | " +
    "Where-Object { $_.CommandLine -match 'api_v2\\.py|start_api\\.cmd' } | " +
    'Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 2';
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 8000,
  });
  if (!r.ok || !r.stdout.trim()) return [];
  let raw = [];
  try {
    const parsed = JSON.parse(r.stdout.trim());
    raw = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
  return raw
    .filter((p) => p && Number(p.ProcessId) > 0)
    .map((p) => ({
      pid: Number(p.ProcessId),
      name: String(p.Name || ''),
      kind: String(p.Name).toLowerCase() === 'python.exe' ? 'api' : 'wrapper',
      cmdline: String(p.CommandLine || '').trim(),
    }));
}

/** 启动 GPT-SoVITS API：9880 未监听时隐藏启动 start_api.cmd，等端口就绪（≤90s）。 */
async function startGptSovits() {
  if (await tcpProbe(PORTS.gptSovits, 1200)) {
    const owners = await listeningPorts();
    const pid = owners.get(PORTS.gptSovits) || null;
    return {
      ok: true,
      alreadyRunning: true,
      pid,
      detail: `GPT-SoVITS API 已在运行（端口 9880${pid ? `，PID ${pid}` : ''}），无需重复启动`,
    };
  }
  const procs = await gptSovitsProcesses();
  if (procs.length) {
    // 端口还没开但进程已经在加载模型：不要重复启动，等它就绪
    const up = await waitPort(PORTS.gptSovits, true, 90000);
    const pid = up ? (await listeningPorts()).get(PORTS.gptSovits) || null : null;
    _statusCache.at = 0;
    if (up) {
      return {
        ok: true,
        alreadyRunning: true,
        pid,
        detail: `GPT-SoVITS API 正在启动中，端口已就绪（未重复启动${pid ? `，PID ${pid}` : ''}）`,
      };
    }
    return {
      ok: false,
      pid,
      detail: `检测到 GPT-SoVITS 进程（PID ${procs.map((p) => p.pid).join(',')}），但 90 秒内端口 9880 未就绪（模型还在加载？），请稍后刷新`,
    };
  }
  if (!fs.existsSync(GPT_START_CMD)) {
    return { ok: false, detail: `找不到 GPT-SoVITS 启动脚本：${GPT_START_CMD}` };
  }
  try {
    spawnDetached('cmd.exe', ['/d', '/c', 'start_api.cmd'], {
      cwd: GPT_DIR,
      logName: 'launch-gpt-sovits.log',
    });
  } catch (err) {
    return { ok: false, detail: `启动 GPT-SoVITS 失败：${String(err)}` };
  }
  const up = await waitPort(PORTS.gptSovits, true, 90000);
  _statusCache.at = 0;
  if (up) {
    const pid = (await listeningPorts()).get(PORTS.gptSovits) || null;
    return { ok: true, pid, detail: `GPT-SoVITS API 已启动（端口 9880${pid ? `，PID ${pid}` : ''}）` };
  }
  return {
    ok: false,
    detail: '启动命令已发出，但 90 秒内端口 9880 未就绪（CPU 加载模型可能较慢），请查看 console/logs/launch-gpt-sovits.log',
  };
}

/** 停止 GPT-SoVITS API：先请求 /control?command=exit 正常退出，超时再结束 9880 owner。 */
async function stopGptSovits() {
  const listening = await tcpProbe(PORTS.gptSovits, 1200);
  const procs = await gptSovitsProcesses();
  if (!listening && procs.length === 0) {
    _statusCache.at = 0;
    return { ok: true, detail: 'GPT-SoVITS API 本来就没有在运行' };
  }
  let exitTried = false;
  if (listening) {
    exitTried = true;
    try {
      await fetch(`http://127.0.0.1:${PORTS.gptSovits}/control?command=exit`, {
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      /* 退出接口不一定有响应，失败就走 kill */
    }
    if (await waitPort(PORTS.gptSovits, false, 12000)) {
      _statusCache.at = 0;
      return { ok: true, exitTried, detail: 'GPT-SoVITS API 已通过 /control?command=exit 正常退出（端口 9880 已释放）' };
    }
  }
  // 超时（或本来就没监听但进程还在）→ 结束进程
  const owners = await listeningPorts();
  const targets = new Set();
  const owner = owners.get(PORTS.gptSovits) || null;
  if (owner) targets.add(owner);
  for (const p of procs) targets.add(p.pid);
  if (targets.size === 0) {
    _statusCache.at = 0;
    return { ok: true, exitTried, detail: 'GPT-SoVITS API 未在运行' };
  }
  const killed = [];
  for (const pid of targets) {
    const r = await killPid(pid, { tree: true });
    killed.push({ pid, ok: r.ok, detail: r.detail });
  }
  const down = await waitPort(PORTS.gptSovits, false, 15000);
  _statusCache.at = 0;
  _procCache.at = 0;
  if (down) {
    const pids = killed.filter((k) => k.ok).map((k) => k.pid);
    return {
      ok: true,
      exitTried,
      detail: `GPT-SoVITS API 已停止${pids.length ? `（结束 PID ${pids.join(',')}）` : ''}`,
    };
  }
  return {
    ok: false,
    exitTried,
    detail: `已尝试结束进程，但端口 9880 仍在监听：${killed.map((k) => `${k.pid}:${k.ok ? 'ok' : k.detail}`).join(' | ')}`,
  };
}

/**
 * 语音暖场：向 /tts POST 一句 5 字内的短句（生成到内存后丢弃），让模型热起来，避免用户首句等 65 秒。
 * 请求在后台继续跑；这里最多等 waitMs，超时就先返回“暖场中”。
 */
async function warmupGptSovits(waitMs = 15000) {
  const cfg = (await loadVoiceEngineConfig()) || {};
  if (cfg.enabled === false) {
    return { ok: false, skipped: true, detail: 'voice-engine.json 里 enabled=false，跳过暖场' };
  }
  const refAudio = String(cfg.refAudio || '');
  if (!refAudio) {
    return { ok: false, skipped: true, detail: 'voice-engine.json 缺少 refAudio，跳过暖场' };
  }
  const payload = {
    text: '你好呀', // 3 个字，短句暖场
    text_lang: 'zh',
    ref_audio_path: refAudio,
    prompt_text: String(cfg.promptText || ''),
    prompt_lang: String(cfg.promptLang || 'zh'),
    media_type: 'wav',
    streaming_mode: false,
    text_split_method: String(cfg.splitMethod || 'cut0'),
    top_k: 15,
    top_p: 1,
    temperature: 1,
    speed_factor: Number(cfg.speedFactor ?? 1),
    repetition_penalty: 1.35,
  };
  const startedAt = Date.now();
  const request = fetch(String(cfg.url || GPT_URL), {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180000),
  })
    .then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 160)}` };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return { ok: buf.length > 1000, bytes: buf.length };
    })
    .catch((err) => ({ ok: false, error: String(err && err.message ? err.message : err) }));

  const raced = await Promise.race([
    request,
    sleep(waitMs).then(() => ({ background: true })),
  ]);
  if (raced.background) {
    request
      .then((r) => logLine(`GPT-SoVITS 暖场后台完成：${JSON.stringify(r)}`))
      .catch(() => {});
    return {
      ok: false,
      timedOut: true,
      detail: `暖场已触发，${Math.round(waitMs / 1000)} 秒内未完成，仍在后台继续（首句可能稍慢）`,
    };
  }
  const elapsedMs = Date.now() - startedAt;
  if (raced.ok) {
    return {
      ok: true,
      bytes: raced.bytes,
      elapsedMs,
      detail: `语音暖场完成（${(elapsedMs / 1000).toFixed(1)} 秒，模型已热）`,
    };
  }
  return { ok: false, elapsedMs, detail: `暖场失败：${raced.error || '合成未成功'}（不影响其它服务）` };
}

/* ---------------------------- 启动 / 停止 ---------------------------- */

async function startSnowluma() {
  if (await tcpProbe(PORTS.snowluma, 1200)) {
    return { ok: true, detail: 'SnowLuma 已在运行（端口 5099），无需重复启动' };
  }
  const procs = await listProcesses(true);
  const existing = procs.filter((p) => p.kind === 'snowluma');
  if (existing.length) {
    const up = await waitPort(PORTS.snowluma, true, 10000);
    if (up) return { ok: true, detail: 'SnowLuma 已在运行（端口 5099），无需重复启动' };
    return {
      ok: false,
      detail: `检测到 SnowLuma 进程（PID ${existing.map((p) => p.pid).join(',')}）但端口 5099 尚未就绪，请稍等几秒再刷新；为避免双实例未重复启动。`,
    };
  }
  if (!fs.existsSync(SNOWLUMA_NODE)) {
    return { ok: false, detail: `找不到 SnowLuma 自带的 node.exe：${SNOWLUMA_NODE}` };
  }
  let launched;
  try {
    launched = spawnDetached(SNOWLUMA_NODE, ['index.mjs'], {
      cwd: SNOWLUMA_DIR,
      logName: 'launch-snowluma.log',
      env: await panelEnv(),
    });
  } catch (err) {
    return { ok: false, detail: `启动 SnowLuma 失败：${String(err)}` };
  }
  const up = await waitPort(PORTS.snowluma, true, 30000);
  if (up) return { ok: true, detail: `SnowLuma 已启动（端口 5099，启动进程 PID ${launched.pid}）` };
  return {
    ok: false,
    detail: `SnowLuma 启动命令已发出（PID ${launched.pid}），但 30 秒内端口 5099 未就绪，请查看 console/logs/launch-snowluma.log`,
  };
}

async function stopSnowluma() {
  const owners = await listeningPorts();
  const owner = owners.get(PORTS.snowluma);
  const procs = await listProcesses(true);
  const targets = new Set();
  if (owner) targets.add(owner);
  for (const p of procs) if (p.kind === 'snowluma') targets.add(p.pid);
  if (targets.size === 0) {
    return { ok: true, detail: 'SnowLuma 本来就没有在运行' };
  }
  const killed = [];
  for (const pid of targets) {
    const r = await killPid(pid, { tree: true });
    killed.push({ pid, ok: r.ok, detail: r.detail });
  }
  const down = await waitPort(PORTS.snowluma, false, 12000);
  const okItems = killed.filter((k) => k.ok);
  const detail = down
    ? `SnowLuma 已停止（PID ${okItems.map((k) => k.pid).join(',') || targets.size }）`
    : `已发送结束命令，但端口 5099 仍在监听，请手动检查：${killed.map((k) => `${k.pid}:${k.detail}`).join(' | ')}`;
  _statusCache.at = 0;
  _procCache.at = 0;
  return { ok: down, detail };
}

async function startBridge() {
  if (await tcpProbe(PORTS.bridge, 1200)) {
    return { ok: true, detail: 'QQ 桥接已在运行（端口 3100），无需重复启动' };
  }
  const procs = await listProcesses(true);
  const existing = procs.filter((p) => p.kind === 'bridge' || p.kind === 'bridge-guard');
  if (existing.length) {
    const up = await waitPort(PORTS.bridge, true, 12000);
    if (up) return { ok: true, detail: 'QQ 桥接已在运行（端口 3100），无需重复启动' };
    return {
      ok: false,
      detail: `检测到桥接相关进程（PID ${existing.map((p) => p.pid).join(',')}）但端口 3100 未就绪，请稍等几秒刷新；为避免双实例未重复启动。`,
    };
  }
  // 清理残留锁文件（确认没有桥接进程时才删）
  if (fs.existsSync(BRIDGE_LOCK_FILE)) {
    try {
      await fsp.unlink(BRIDGE_LOCK_FILE);
      logLine('start-bridge: 已清理残留 state/bridge.lock');
    } catch {
      /* ignore */
    }
  }
  const env = { ...(await panelEnv()), PATH: `${NODE_DIR};${process.env.PATH || ''}` };
  // 注意：这里故意不加内层引号——Node 在 Windows 上会把带空格的参数整体加引号，
  // cmd /c 能正确剥掉外层引号；一旦内层再嵌 \"，cmd 解析会失败（实测起不来）。
  // 工作区路径确实不含空格；同时把守护 PID 记到 state/bridge-guard.pid 作为兜底。
  const cdPart = /\s/.test(BRIDGE_DIR) ? null : `cd /d ${BRIDGE_DIR} && start.bat`;
  let launched;
  try {
    launched = spawnDetached('cmd.exe', ['/d', '/c', cdPart || 'start.bat'], {
      cwd: BRIDGE_DIR,
      logName: 'launch-bridge.log',
      env,
    });
  } catch (err) {
    return { ok: false, detail: `启动 QQ 桥接失败：${String(err)}` };
  }
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(GUARD_PID_FILE, JSON.stringify({ pid: launched.pid, at: new Date().toISOString() }), 'utf8');
  } catch {
    /* 记录失败不影响启动 */
  }
  const up = await waitPort(PORTS.bridge, true, 30000);
  _statusCache.at = 0;
  _procCache.at = 0;
  if (up) return { ok: true, detail: `QQ 桥接已启动（端口 3100，守护进程 PID ${launched.pid}）` };
  return {
    ok: false,
    detail: `启动命令已发出（PID ${launched.pid}），但 30 秒内端口 3100 未就绪，请查看 console/logs/launch-bridge.log 与 qq-bridge/state/bridge.log`,
  };
}

async function stopBridge() {
  const killed = [];
  // 1) 先杀守护 cmd.exe（start.bat / run-bridge.bat），否则它会在 5 秒后把桥接重新拉起来
  const procs = await listProcesses(true);
  const guardPids = new Set(procs.filter((p) => p.kind === 'bridge-guard').map((p) => p.pid));
  // 兜底：桥接 node 的父进程如果是 cmd.exe，那就是守护窗口，一并结束
  const cmdPids = new Set(procs.filter((p) => p.name === 'cmd.exe').map((p) => p.pid));
  for (const p of procs) {
    if (p.kind === 'bridge' && cmdPids.has(p.ppid)) guardPids.add(p.ppid);
  }
  // 再兜底：startBridge 启动时记录下来的守护 PID（命令行可能不带仓库路径）
  const storedGuard = await readGuardPid();
  if (storedGuard && !guardPids.has(storedGuard)) {
    const cl = await processCmdline(storedGuard);
    if (cl && /(start\.bat|run-bridge)/i.test(cl)) guardPids.add(storedGuard);
  }
  for (const pid of guardPids) {
    const r = await killPid(pid, { tree: true });
    killed.push({ pid, kind: 'guard', ...r });
  }
  // 2) 杀端口 3100 的占用者
  const owners = await listeningPorts();
  const owner = owners.get(PORTS.bridge);
  if (owner) {
    const r = await killPid(owner, { tree: true });
    killed.push({ pid: owner, kind: 'port', ...r });
  }
  // 3) 兜底：清理残留的 src/bridge.js 进程
  const after = await listProcesses(true);
  for (const p of after) {
    if (p.kind === 'bridge') {
      const r = await killPid(p.pid, { tree: true });
      killed.push({ pid: p.pid, kind: 'bridge', ...r });
    }
  }

  if (killed.length === 0) {
    // 没有进程也没有监听：顺手删掉残留锁与守护 PID 记录
    await clearGuardPidFile();
    try {
      if (fs.existsSync(BRIDGE_LOCK_FILE)) await fsp.unlink(BRIDGE_LOCK_FILE);
    } catch {
      /* ignore */
    }
    _statusCache.at = 0;
    _procCache.at = 0;
    return { ok: true, detail: 'QQ 桥接本来就没有在运行' };
  }

  const down = await waitPort(PORTS.bridge, false, 15000);
  _statusCache.at = 0;
  _procCache.at = 0;
  if (!down) {
    return {
      ok: false,
      detail: `已尝试结束进程，但端口 3100 仍在监听。结果：${killed.map((k) => `${k.pid}(${k.kind}):${k.ok ? 'ok' : k.detail}`).join(' | ')}`,
    };
  }
  // 端口已释放，删掉锁文件避免下次启动被判“已在运行”
  let lockNote = '';
  try {
    if (fs.existsSync(BRIDGE_LOCK_FILE)) {
      await fsp.unlink(BRIDGE_LOCK_FILE);
      lockNote = '，已清理 bridge.lock';
    }
  } catch {
    lockNote = '（bridge.lock 清理失败，可手动删除）';
  }
  const pids = killed.filter((k) => k.ok).map((k) => k.pid);
  await clearGuardPidFile();
  return {
    ok: true,
    detail: `QQ 桥接已停止${pids.length ? `（PID ${pids.join(',')}）` : ''}${lockNote}`,
  };
}

/** 读取桥接 /api/status 的关键字段（用于确认 WS 是否重新连上 SnowLuma）。 */
async function bridgeStatusSnapshot() {
  const token = await bridgeConsoleToken();
  const r = await getJson(`${BRIDGE_URL}/api/status`, {
    headers: token ? { 'x-console-token': token } : {},
    timeout: 2500,
  });
  if (!r.ok || !r.data) return { ok: false, connected: false };
  const sl = r.data.snowluma || {};
  return {
    ok: true,
    connected: !!sl.connected,
    accountOnline: !!sl.accountOnline,
    good: !!sl.good,
    lastPacketAgoMs: typeof sl.lastPacketAgoMs === 'number' ? sl.lastPacketAgoMs : null,
    mode: r.data.mode ?? null,
    role: r.data.role ?? null,
    dshReady: typeof r.data.dshReady === 'boolean' ? r.data.dshReady : null,
  };
}

/** 等桥接的 DSH 通道就绪（DSH 重启后需要一点时间重连），最多 timeoutMs。 */
async function waitBridgeDshReady(timeoutMs = 20000) {
  const startedAt = Date.now();
  let last = { ok: false, dshReady: null };
  while (Date.now() - startedAt < timeoutMs) {
    last = await bridgeStatusSnapshot();
    if (last.ok && last.dshReady === true) return { ready: true, waitedMs: Date.now() - startedAt };
    await sleep(700);
  }
  return { ready: false, waitedMs: Date.now() - startedAt, last };
}

/**
 * 唤醒所有 QQ 会话处理未读：
 * 读桥接 /api/sessions 拿会话 key，然后对每个 key 调 /api/console/notify-ai 投递固定提醒。
 * 桥接没起时返回 ok:false + hint（调用方永远回 200，不 500）。
 */
async function nudgeSessions() {
  if (!(await tcpProbe(PORTS.bridge, 1200))) {
    return {
      ok: false,
      results: [],
      hint: 'QQ 桥接未运行，无法唤醒会话（可先点「一键启动」或「启动桥接」）',
    };
  }
  const token = await bridgeConsoleToken();
  const authHeaders = token ? { 'x-console-token': token } : {};

  let sessRes;
  try {
    sessRes = await getJson(`${BRIDGE_URL}/api/sessions`, { headers: authHeaders, timeout: 6000 });
  } catch (err) {
    return { ok: false, results: [], hint: `读取桥接会话列表失败：${String(err && err.message ? err.message : err)}` };
  }
  if (!sessRes.ok || !sessRes.data) {
    return {
      ok: false,
      results: [],
      hint:
        sessRes.status === 401 || sessRes.status === 403
          ? '读取桥接会话列表被拒（控制台令牌可能已变化）'
          : `读取桥接会话列表失败（HTTP ${sessRes.status ?? '无响应'}）`,
    };
  }
  const sessions = Array.isArray(sessRes.data.sessions) ? sessRes.data.sessions : [];
  const keys = [...new Set(sessions.map((s) => String((s && s.key) || '').trim()).filter(Boolean))];
  if (keys.length === 0) {
    return { ok: true, results: [], count: 0, delivered: 0, hint: '当前没有活跃会话，无需唤醒' };
  }

  const results = [];
  for (const key of keys) {
    try {
      const res = await fetch(`${BRIDGE_URL}/api/console/notify-ai`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({ key, message: NUDGE_MESSAGE }),
        signal: AbortSignal.timeout(15000),
      });
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      const ok = res.ok && (!body || body.ok !== false);
      results.push({
        key,
        status: res.status,
        ok,
        error: ok ? null : (body && body.error) || `HTTP ${res.status}`,
      });
    } catch (err) {
      results.push({ key, status: 0, ok: false, error: String(err && err.message ? err.message : err) });
    }
  }
  const delivered = results.filter((r) => r.ok).length;
  return {
    ok: delivered > 0,
    results,
    count: keys.length,
    delivered,
    hint: delivered > 0 ? null : '桥接有响应但投递失败，请查看桥接日志或稍后重试',
  };
}

/** 轮询桥接状态，直到 snowluma.connected=true 或超时。 */
async function waitBridgeConnected(timeoutMs = 30000) {
  const startedAt = Date.now();
  let last = { ok: false, connected: false };
  while (Date.now() - startedAt < timeoutMs) {
    last = await bridgeStatusSnapshot();
    if (last.ok && last.connected) return { ...last, waitedMs: Date.now() - startedAt };
    await sleep(700);
  }
  return { ...last, connected: false, waitedMs: Date.now() - startedAt };
}

/**
 * SnowLuma 恢复后重建桥接连接：
 * 桥接没在跑就直接启动；在跑就 stop+start；然后等 /api/status 里 snowluma.connected=true（最多 30 秒）。
 * 实测 SnowLuma 重启后桥接自己只在最初试一次重连就停了，所以必须主动踢一下。
 */
async function reconnectBridge(timeoutMs = 30000) {
  const steps = [];
  const bridgeUp = await tcpProbe(PORTS.bridge, 1200);
  if (bridgeUp) {
    const stopped = await stopBridge();
    steps.push({ name: '停止桥接', ok: stopped.ok, detail: stopped.detail });
    if (!stopped.ok) {
      return { ok: false, connected: false, detail: `桥接停止失败，无法重建连接：${stopped.detail}`, steps };
    }
    await sleep(600);
  } else {
    steps.push({ name: '停止桥接', ok: true, detail: '桥接原本未运行，跳过停止，直接启动' });
  }
  const started = await startBridge();
  steps.push({ name: '启动桥接', ok: started.ok, detail: started.detail });
  if (!started.ok) return { ok: false, connected: false, detail: started.detail, steps };

  const conn = await waitBridgeConnected(timeoutMs);
  steps.push({
    name: '等待 WS 重连',
    ok: !!conn.connected,
    detail: conn.connected
      ? `桥接已重新连上 SnowLuma（connected=true，用时约 ${Math.max(1, Math.round(conn.waitedMs / 1000))} 秒）`
      : '等待 30 秒 snowluma.connected 仍为 false',
  });
  return {
    ok: !!conn.connected,
    connected: !!conn.connected,
    accountOnline: conn.accountOnline ?? null,
    good: conn.good ?? null,
    lastPacketAgoMs: conn.lastPacketAgoMs ?? null,
    mode: conn.mode ?? null,
    role: conn.role ?? null,
    detail: conn.connected
      ? '桥接已重启以重建连接，已重新连上 SnowLuma（connected=true）'
      : '桥接已重启以重建连接，但 30 秒内 snowluma.connected 仍为 false，可点「重启桥接」再试',
    steps,
  };
}

async function restartBridge(confirm) {
  if (!confirm) return { ok: false, detail: '重启需要确认参数 confirm:true', needConfirm: true };
  const stopped = await stopBridge();
  const steps = [{ name: '停止桥接', ...stopped }];
  if (!stopped.ok) return { ok: false, detail: `重启中止：${stopped.detail}`, steps };
  await sleep(800);
  const started = await startBridge();
  steps.push({ name: '启动桥接', ...started });
  return {
    ok: stopped.ok && started.ok,
    detail: `${stopped.detail}；${started.detail}`,
    steps,
  };
}

async function restartSnowluma(confirm) {
  if (!confirm) return { ok: false, detail: '重启需要确认参数 confirm:true', needConfirm: true };
  const stopped = await stopSnowluma();
  const steps = [{ name: '停止 SnowLuma', ...stopped }];
  if (!stopped.ok) return { ok: false, detail: `重启中止：${stopped.detail}`, steps };
  await sleep(1000);
  const started = await startSnowluma();
  steps.push({ name: '启动 SnowLuma', ...started });
  return { ok: stopped.ok && started.ok, detail: `${stopped.detail}；${started.detail}`, steps };
}

/**
 * 重启 DSH（仅由用户显式点击「重启 DSH」按钮触发，必须带 confirm）。
 * 这是唯一允许结束 3080 端口 owner 的路径，其它动作仍然绝不触碰 3080。
 */
async function restartDsh(confirm) {
  if (!confirm) return { ok: false, detail: '重启 DSH 需要确认参数 confirm:true', needConfirm: true };
  const steps = [];

  // 1) 找 3080 owner，确认身份后才结束（绝不动非 node.exe / 非 DSH 的进程）
  let owners = await listeningPorts();
  const oldPid = owners.get(PORTS.dsh) || null;
  if (oldPid) {
    const info = await processInfo(oldPid);
    if (!info.ok || !info.name) {
      return { ok: false, detail: `无法确认 3080 端口占用者（PID ${oldPid}）的身份，已中止，未结束任何进程`, steps };
    }
    if (String(info.name).toLowerCase() !== 'node.exe') {
      return {
        ok: false,
        detail: `3080 端口被 ${info.name}（PID ${oldPid}）占用，不是 DSH 的 node.exe，已中止，未结束任何进程`,
        steps,
      };
    }
    if (!/dsh/i.test(info.cmdline || '')) {
      return {
        ok: false,
        detail: `3080 端口 owner（PID ${oldPid}，node.exe）命令行不像 DSH，已中止：${info.cmdline.slice(0, 160)}`,
        steps,
      };
    }
    const killed = await killPid(oldPid, { tree: true });
    steps.push({ name: '停止旧 DSH', ok: killed.ok, pid: oldPid, detail: killed.detail });
    if (!killed.ok) {
      return { ok: false, detail: `结束旧 DSH（PID ${oldPid}）失败：${killed.detail}`, steps };
    }
    const released = await waitPort(PORTS.dsh, false, 15000);
    steps.push({ name: '等待 3080 释放', ok: released, detail: released ? '端口已释放' : '端口仍在监听' });
    if (!released) {
      return { ok: false, detail: '旧 DSH 已结束，但 3080 端口 15 秒内未释放，重启中止（未启动新实例）', steps };
    }
  } else {
    steps.push({ name: '停止旧 DSH', ok: true, pid: null, detail: 'DSH 当前未运行，直接启动' });
  }

  // 2) 后台 detached 启动 start-dsh.bat（stdio 收进自己的日志，便于抓取新地址）
  if (!fs.existsSync(DSH_START_BAT)) {
    return { ok: false, detail: `找不到启动脚本：${DSH_START_BAT}`, steps };
  }
  let launched;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const fd = fs.openSync(DSH_RESTART_LOG, 'a');
    try {
      fs.writeSync(fd, `\n===== ${new Date().toISOString()} 面板重启 DSH =====\n`);
      const child = spawn('cmd.exe', ['/d', '/c', 'start-dsh.bat'], {
        cwd: DSH_DIR,
        env: { ...(await panelEnv()), PATH: `${NODE_DIR};${process.env.PATH || ''}` },
        windowsHide: true,
        detached: true,
        stdio: ['ignore', fd, fd],
      });
      child.unref();
      launched = { pid: child.pid };
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    return { ok: false, detail: `启动 start-dsh.bat 失败：${String(err)}`, steps };
  }
  steps.push({ name: '启动 DSH', ok: true, pid: launched.pid, detail: `已后台启动 start-dsh.bat（PID ${launched.pid}）` });

  // 3) 等 3080 重新监听（最多 60 秒）
  const up = await waitPort(PORTS.dsh, true, 60000);
  if (!up) {
    _statusCache.at = 0;
    _procCache.at = 0;
    return {
      ok: false,
      detail: '已执行重启，但 60 秒内 3080 未恢复监听。请查看 console/logs/dsh-restart.log 或 dsh-workspace 控制台窗口',
      steps,
      launchedPid: launched.pid,
    };
  }

  // 4) 从 start-dsh 输出里抓新地址（带 token）；抓不到就只报端口
  await sleep(900);
  let newUrl = null;
  const tail = await readTailLines(DSH_RESTART_LOG, 80, 192 * 1024);
  for (const line of tail.lines) {
    const m = line.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+(?:\/[^\s"'<>]*)?/);
    if (m) newUrl = m[0];
  }
  owners = await listeningPorts();
  const newPid = owners.get(PORTS.dsh) || null;
  if (!newUrl) newUrl = `http://127.0.0.1:${PORTS.dsh}/`;
  _statusCache.at = 0;
  _procCache.at = 0;
  const tokenNote = /[?&]token=/.test(newUrl) ? '（新地址含登录 token，浏览器已自动用新地址打开）' : '';

  // 5) 自动唤醒 QQ 会话处理未读：重启 DSH 后容易“消息卡住没人回”，这里主动踢一下
  let nudge = { ok: false, hint: '桥接未运行，未执行唤醒' };
  try {
    if (await tcpProbe(PORTS.bridge, 1200)) {
      const ready = await waitBridgeDshReady(20000);
      nudge = await nudgeSessions();
      nudge.bridgeDshReady = ready.ready;
      if (!ready.ready) nudge.hint = nudge.hint || '桥接的 DSH 通道 20 秒内未就绪，唤醒可能未生效';
    }
  } catch (err) {
    nudge = { ok: false, hint: `自动唤醒异常：${String(err && err.message ? err.message : err)}` };
  }
  const nudgeDetail = nudge.ok
    ? `已唤醒 QQ 会话处理未读（成功 ${nudge.delivered}/${nudge.count}）`
    : `自动唤醒 QQ 会话未成功：${nudge.hint || '未知原因'}`;
  steps.push({ name: '唤醒 QQ 会话', ok: !!nudge.ok, detail: nudgeDetail });

  return {
    ok: true,
    newUrl,
    port: PORTS.dsh,
    pid: newPid,
    nudge,
    detail: `DSH 已重启，端口 ${PORTS.dsh} 已恢复监听${tokenNote}；新地址：${newUrl}；桥接与 SnowLuma 不受影响；${nudgeDetail}`,
    steps,
  };
}

/* ---------------------------- QQ 客户端 ---------------------------- */

let _qqCache = { at: 0, list: [] };

/** QQ 客户端 exe 路径：优先 console/panel.config.json 的 qqExe，缺省 DEFAULT_QQ_EXE。 */
async function qqExePath() {
  try {
    const cfg = await loadPanelConfig();
    const p = cfg && typeof cfg.qqExe === 'string' && cfg.qqExe.trim() ? cfg.qqExe.trim() : '';
    if (p) return p;
  } catch {
    /* ignore */
  }
  return DEFAULT_QQ_EXE;
}

/** 列出 QQ.exe 进程（4 秒缓存，避免 /api/status 频繁拉起 PowerShell）。 */
async function qqClientProcesses(force = false) {
  if (!force && Date.now() - _qqCache.at < 4000) return _qqCache.list;
  const script =
    '$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
    'Get-CimInstance Win32_Process -Filter "Name=\'QQ.exe\'" | ' +
    'Select-Object ProcessId,ExecutablePath,CreationDate | ConvertTo-Json -Compress -Depth 2';
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000 });
  let list = [];
  if (r.ok && r.stdout.trim()) {
    try {
      const parsed = JSON.parse(r.stdout.trim());
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      list = arr
        .filter((p) => p && Number(p.ProcessId) > 0)
        .map((p) => ({
          pid: Number(p.ProcessId),
          exe: String(p.ExecutablePath || ''),
          createdAt: p.CreationDate || null,
        }));
    } catch {
      list = [];
    }
  }
  _qqCache = { at: Date.now(), list };
  return list;
}

/**
 * 确保 QQ 客户端在运行：已在运行直接返回（标「已在运行」）；
 * 否则用 Start-Process 启动 panel.config.json 的 qqExe，并等 QQ.exe 进程出现（≤60s）。
 */
async function startQQClient() {
  const before = await qqClientProcesses(true);
  if (before.length) {
    return {
      ok: true,
      alreadyRunning: true,
      pids: before.map((p) => p.pid),
      count: before.length,
      detail: `QQ 客户端已在运行（共 ${before.length} 个进程，主进程 PID ${before[0].pid}）`,
    };
  }
  const exe = await qqExePath();
  if (!fs.existsSync(exe)) {
    return {
      ok: false,
      exe,
      detail: `找不到 QQ 客户端：${exe}。请确认路径，或在 console/panel.config.json 的 qqExe 里改成正确路径`,
    };
  }
  try {
    spawnDetached(
      'powershell.exe',
      ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Process -FilePath '${exe.replace(/'/g, "''")}'`],
      { logName: 'launch-qq.log' },
    );
  } catch (err) {
    return { ok: false, exe, detail: `启动 QQ 客户端失败：${String(err)}` };
  }
  // QQNT 是「引导器 + 热更新」架构：QQ.exe 只负责拉起 versions/<ver>/QQNT.dll，
  // 冷启动常要 20~60 秒；而 Get-CimInstance(WMI) 查询本身也慢，两者叠加会让
  // 60 秒窗口只够轮询几次。这里把窗口放宽到 180 秒，并在 WMI 之外补一个
  // 更快的兜底判据（tasklist 命中同样算启动成功），避免误报。
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await sleep(1000);
    let list = await qqClientProcesses(true);
    if (!list.length) {
      const quick = await qqProcessesQuick();
      if (quick.length) {
        _qqCache = { at: Date.now(), list: quick };
        list = quick;
      }
    }
    if (list.length) {
      _statusCache.at = 0;
      return {
        ok: true,
        pids: list.map((p) => p.pid),
        count: list.length,
        exe,
        detail: `QQ 客户端已启动（共 ${list.length} 个进程，主进程 PID ${list[0].pid}）`,
      };
    }
  }
  return {
    ok: false,
    exe,
    detail: `已尝试启动 QQ 客户端（${exe}），但 180 秒内没有检测到 QQ.exe 进程（可能还在初始化，或路径/权限有问题）`,
  };
}

/**
 * 兜底判据：用 tasklist 快速看 QQ.exe 是否存在。
 * 比 Get-CimInstance(WMI) 快很多，用于 WMI 迟迟不返回时的补充检测。
 */
async function qqProcessesQuick() {
  const r = await run('tasklist.exe', ['/FI', 'IMAGENAME eq QQ.exe', '/NH', '/FO', 'CSV'], { timeout: 8000 });
  if (!r.ok || !r.stdout) return [];
  const out = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^"QQ\.exe","(\d+)"/i);
    if (m) out.push({ pid: Number(m[1]), exe: '', createdAt: null });
  }
  return out;
}

/* ---------------------------- 一键启动（异步任务 + 进度） ---------------------------- */

const START_ALL_STEP_NAMES = ['QQ 客户端', 'SnowLuma', 'QQ 注入', 'QQ-Bridge 连接', 'GPT-SoVITS API', '语音暖场', '通道代理'];
const _startAll = {
  running: false,
  jobId: null,
  progress: 0,
  currentStep: '',
  steps: [],
  detail: '',
  startedAt: null,
  finishedAt: null,
  error: null,
};

function newStartAllSteps() {
  return START_ALL_STEP_NAMES.map((name) => ({
    name,
    status: 'pending',
    detail: '',
    startedAt: null,
    endedAt: null,
  }));
}

function startAllSnapshot() {
  return JSON.parse(JSON.stringify(_startAll));
}

function saSetStep(index, patch) {
  const st = _startAll.steps[index];
  if (st) Object.assign(st, patch);
}

function saSetProgress(index, done) {
  const total = START_ALL_STEP_NAMES.length;
  const pct = Math.round(((index + (done ? 1 : 0)) / total) * 100);
  _startAll.progress = Math.max(0, Math.min(100, pct));
}

function saBeginStep(index) {
  saSetStep(index, { status: 'running', startedAt: new Date().toISOString() });
  _startAll.currentStep = START_ALL_STEP_NAMES[index];
  saSetProgress(index, false);
}

function saEndStep(index, status, detail) {
  saSetStep(index, { status, detail, endedAt: new Date().toISOString() });
  saSetProgress(index, true);
}

/** 启动本地 LLM 通道代理（127.0.0.1:3090）：已运行则跳过。 */
async function startChannelProxy() {
  const dir = path.join(WORKSPACE, 'channel-proxy');
  const script = path.join(dir, 'server.mjs');
  if (!fs.existsSync(script)) return { ok: false, detail: `缺少通道代理脚本：${script}` };
  if (await tcpProbe(3090, 900)) return { ok: true, skipped: true, detail: '通道代理已在运行（127.0.0.1:3090）' };
  const r = spawnDetached(NODE_EXE, [script], { cwd: dir, logName: 'channel-proxy.log' });
  if (!r.ok) return { ok: false, detail: '通道代理启动失败' };
  for (let i = 0; i < 20; i += 1) {
    await sleep(500);
    if (await tcpProbe(3090, 700)) return { ok: true, detail: `通道代理已启动（pid ${r.pid}）`, pid: r.pid };
  }
  return { ok: false, detail: `通道代理 10 秒内未就绪（pid ${r.pid}，见 console/logs/channel-proxy.log）`, pid: r.pid };
}

/** 后台按固定 7 步执行一键启动；每步都更新 /api/start-all/status 可查的进度。 */
async function runStartAllJob(jobId) {
  const failed = [];
  try {
    // ① QQ 客户端（必须有 QQ.exe，后面的注入才找得到进程）
    saBeginStep(0);
    const qqStart = await startQQClient();
    saEndStep(0, qqStart.ok ? 'ok' : 'fail', qqStart.detail);
    if (!qqStart.ok) failed.push('QQ 客户端');

    // ② SnowLuma
    saBeginStep(1);
    const sl = await startSnowluma();
    saEndStep(1, sl.ok ? 'ok' : 'fail', sl.detail);
    if (!sl.ok) failed.push('SnowLuma');

    // ③ QQ 注入（在 QQ 进程出现之后才注入；前提不满足就跳过）
    saBeginStep(2);
    let inj;
    if (qqStart.ok && sl.ok) {
      inj = await injectQQ();
    } else if (!qqStart.ok) {
      inj = { ok: false, skipped: true, hint: 'QQ 客户端未就绪，跳过注入（QQ 启动后可点「重新注入 QQ」）' };
    } else {
      inj = { ok: false, skipped: true, hint: 'SnowLuma 未就绪，跳过注入' };
    }
    const injDetail = inj.skipped
      ? inj.hint
      : inj.ok
        ? `QQ 注入成功（uin ${inj.uin}）`
        : `QQ 注入未完成：${inj.hint || inj.note || '未知原因'}`;
    saEndStep(2, inj.ok ? 'ok' : inj.skipped ? 'skip' : 'fail', injDetail);
    if (!inj.ok && !inj.skipped) failed.push('QQ 注入');

    // ④ QQ-Bridge 连接（SnowLuma 恢复后必须重建 WS，否则 connected 一直是 false）
    saBeginStep(3);
    let br;
    if (sl.ok) {
      br = await reconnectBridge(30000);
    } else {
      const started = await startBridge();
      br = { ok: false, connected: false, detail: `SnowLuma 未就绪，未重建连接；${started.detail}` };
    }
    const brOk = !!(br.ok && br.connected);
    saEndStep(3, sl.ok ? (brOk ? 'ok' : 'fail') : 'skip', br.detail || (brOk ? '已重新连上 SnowLuma' : '未连接'));
    if (sl.ok && !brOk) failed.push('QQ-Bridge 连接');

    // ⑤ GPT-SoVITS API
    saBeginStep(4);
    const gpt = await startGptSovits();
    saEndStep(4, gpt.ok ? 'ok' : 'fail', gpt.detail);
    if (!gpt.ok) failed.push('GPT-SoVITS API');

    // ⑥ 语音暖场（最多等 15 秒；超时按 ok 处理并注明后台继续）
    saBeginStep(5);
    if (!gpt.ok) {
      saEndStep(5, 'skip', 'GPT-SoVITS 未就绪，跳过暖场');
    } else {
      const warm = await warmupGptSovits(15000);
      if (warm.ok) {
        saEndStep(5, 'ok', warm.detail);
      } else if (warm.timedOut) {
        saEndStep(5, 'ok', `${warm.detail}（后台继续）`);
      } else if (warm.skipped) {
        saEndStep(5, 'skip', warm.detail);
      } else {
        saEndStep(5, 'fail', warm.detail);
        failed.push('语音暖场');
      }
    }

    // ⑦ 通道代理（官方/中转切换用；没启动也不影响官方通道）
    saBeginStep(6);
    const chanProxy = await startChannelProxy();
    saEndStep(6, chanProxy.ok ? 'ok' : 'fail', chanProxy.detail);
    if (!chanProxy.ok) failed.push('通道代理');

    _startAll.progress = 100;
    _startAll.running = false;
    _startAll.currentStep = '';
    _startAll.finishedAt = new Date().toISOString();
    _startAll.detail = _startAll.steps
      .map(
        (s) =>
          `${s.name}：${
            s.status === 'ok' ? '完成' : s.status === 'fail' ? '失败' : s.status === 'skip' ? '跳过' : s.status
          }${s.detail ? `（${s.detail}）` : ''}`,
      )
      .join('；');
    _startAll.error = failed.length ? `失败步骤：${failed.join('、')}` : null;
    _statusCache.at = 0;
    _procCache.at = 0;
    logLine(`start-all job ${jobId} 结束：${_startAll.error || '全部成功'}`);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    for (const st of _startAll.steps) {
      if (st.status === 'running') {
        st.status = 'fail';
        st.detail = `异常：${msg}`;
        st.endedAt = new Date().toISOString();
      } else if (st.status === 'pending') {
        st.status = 'skip';
      }
    }
    _startAll.progress = 100;
    _startAll.running = false;
    _startAll.currentStep = '';
    _startAll.finishedAt = new Date().toISOString();
    _startAll.detail = `一键启动异常：${msg}`;
    _startAll.error = msg;
    logLine(`start-all job ${jobId} 异常：${msg}`);
  }
}

/** 触发一键启动异步任务：立即返回 jobId；已有任务在跑时不重复触发。 */
function startStartAllJob() {
  if (_startAll.running) {
    return { ok: false, alreadyRunning: true, jobId: _startAll.jobId, hint: '一键启动正在执行中，请等待完成' };
  }
  const jobId = `sa-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  _startAll.running = true;
  _startAll.jobId = jobId;
  _startAll.progress = 0;
  _startAll.currentStep = START_ALL_STEP_NAMES[0];
  _startAll.steps = newStartAllSteps();
  _startAll.detail = '';
  _startAll.startedAt = new Date().toISOString();
  _startAll.finishedAt = null;
  _startAll.error = null;
  logLine(`start-all job ${jobId} 开始`);
  runStartAllJob(jobId).catch((err) => logLine(`start-all job ${jobId} 未捕获异常：${String(err)}`));
  return { ok: true, jobId, detail: '一键启动已开始，正在后台执行（进度见 /api/start-all/status）' };
}

async function runAction(action, body) {
  const confirm = body && body.confirm === true;
  switch (action) {
    case 'start-all':
      return startStartAllJob();
    case 'start-snowluma': {
      const r = await startSnowluma();
      if (!r.ok) return r;
      // 注入 QQ
      const inj = await injectQQ();
      const injDetail = inj.ok
        ? `QQ 注入成功（uin ${inj.uin}）`
        : `QQ 注入未完成：${inj.hint || inj.note || '未知原因'}`;
      // SnowLuma 重启后桥接不会及时重连：顺便重启一次桥接重建 WS
      const br = await reconnectBridge(30000);
      const connected = !!br.connected;
      const connDetail = connected
        ? '桥接已重启以重建连接（connected=true）'
        : '桥接已重启以重建连接，但 snowluma.connected 仍为 false，可点「重启桥接」再试';
      return {
        ok: r.ok && br.ok && connected,
        detail: `${r.detail}；${injDetail}；${connDetail}`,
        injection: inj,
        bridge: { ok: !!br.ok, connected, accountOnline: br.accountOnline ?? null, mode: br.mode ?? null, role: br.role ?? null },
        steps: [
          { name: '启动 SnowLuma', ...r },
          { name: 'QQ 注入', ok: !!inj.ok, uin: inj.uin || null, detail: injDetail },
          { name: '重启桥接', ok: !!br.ok, connected, detail: br.detail, steps: br.steps },
        ],
      };
    }
    case 'start-bridge':
      return startBridge();
    case 'stop-bridge':
      if (!confirm) return { ok: false, detail: '停止桥接需要确认参数 confirm:true', needConfirm: true };
      return stopBridge();
    case 'stop-snowluma':
      if (!confirm) return { ok: false, detail: '停止 SnowLuma 需要确认参数 confirm:true', needConfirm: true };
      return stopSnowluma();
    case 'restart-bridge':
      return restartBridge(confirm);
    case 'restart-snowluma':
      return restartSnowluma(confirm);
    case 'restart-dsh':
      return restartDsh(confirm);
    case 'start-gpt-sovits':
      return startGptSovits();
    case 'stop-gpt-sovits':
      if (!confirm) return { ok: false, detail: '停止 GPT-SoVITS API 需要确认参数 confirm:true', needConfirm: true };
      return stopGptSovits();
    default:
      return { ok: false, detail: `未知操作：${action}`, unknown: true };
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 服务                                                           */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(text);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 跑一个本地 node 脚本，收集 stdout/stderr（用于 API 通道切换）。 */
function runNodeScript(scriptPath, args, { cwd = WORKSPACE, timeout = 150000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(NODE_EXE, [scriptPath, ...args], { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, timeout);
    child.stdout.on('data', (d) => { stdout = (stdout + d.toString()).slice(-8000); });
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(err && err.message ? err.message : err) }); });
  });
}

async function handleStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.resolve(CONSOLE_DIR, rel);
  if (!file.startsWith(CONSOLE_DIR + path.sep) && file !== HTML_PATH) {
    sendText(res, 403, 'forbidden');
    return;
  }
  // 只允许访问控制台自己目录内的静态文件
  const allowed = new Set([HTML_PATH]);
  if (!allowed.has(file)) {
    sendText(res, 404, 'not found');
    return;
  }
  try {
    const buf = await fsp.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
      'content-length': buf.length,
    });
    res.end(buf);
  } catch {
    sendText(res, 500, '无法读取 index.html');
  }
}

async function handler(req, res) {
  const started = Date.now();
  const url = new URL(req.url || '/', `http://127.0.0.1:${PANEL_PORT}`);
  const pathname = decodeURIComponent(url.pathname);
  try {
    // 跨源也允许（本机自用，避免 Edge/其他端口调试时被拦）
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      await handleStatic(res, '/');
      return;
    }
    if (req.method === 'GET' && pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && pathname === '/api/status') {
      sendJson(res, 200, await buildStatus());
      return;
    }
    if (req.method === 'GET' && pathname === '/api/start-all/status') {
      sendJson(res, 200, startAllSnapshot());
      return;
    }
    if (req.method === 'GET' && pathname === '/api/logs') {
      const source = (url.searchParams.get('source') || 'bridge').toLowerCase();
      const linesReq = Math.min(2000, Math.max(10, parseInt(url.searchParams.get('lines') || '200', 10) || 200));
      const map = { bridge: BRIDGE_LOG, snowluma: SNOWLUMA_LOG };
      const file = map[source];
      if (!file) {
        sendJson(res, 400, { ok: false, detail: `未知日志来源：${source}（可选 bridge / snowluma）` });
        return;
      }
      const tail = await readTailLines(file, linesReq);
      const payload = {
        ok: true,
        source,
        file,
        lines: tail.lines,
        size: tail.size,
        mtime: tail.mtime || null,
        missing: tail.missing,
      };
      if (tail.missing) payload.detail = `日志文件不存在或暂不可读：${file}`;
      sendJson(res, 200, payload);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/settings') {
      // 含 Key 的接口只允许本机控制台页面自己读
      res.setHeader('access-control-allow-origin', `http://127.0.0.1:${PANEL_PORT}`);
      try {
        const s = await loadSettings();
        const keys = {};
        for (const k of KNOWN_KEYS) {
          keys[k.key] = { set: Boolean(s.env[k.key]), masked: maskKey(s.env[k.key]), label: k.label, hint: k.hint };
        }
        sendJson(res, 200, { ok: true, modules: s.modules, keys, moduleIds: MCP_MODULE_IDS });
      } catch (err) {
        sendJson(res, 200, { ok: false, error: String(err && err.message ? err.message : err) });
      }
      return;
    }
    if (req.method === 'POST' && pathname === '/api/settings') {
      res.setHeader('access-control-allow-origin', `http://127.0.0.1:${PANEL_PORT}`);
      let body = {};
      try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      try {
        const next = await saveSettings({ modules: body.modules, env: body.env });
        const applied = await applyModuleSwitches(next.modules);
        logLine(`api/settings：模块=${JSON.stringify(next.modules)} 落盘变更=${applied.changed}`);
        sendJson(res, 200, { ok: true, modules: next.modules, applied });
      } catch (err) {
        sendJson(res, 200, { ok: false, error: String(err && err.message ? err.message : err) });
      }
      return;
    }
    if (req.method === 'GET' && pathname === '/api/credentials') {
      // 密钥接口只允许本机控制台页面自己读：收紧 CORS，防止任意网页跨源偷密钥
      res.setHeader('access-control-allow-origin', `http://127.0.0.1:${PANEL_PORT}`);
      try {
        sendJson(res, 200, await buildCredentials());
      } catch (err) {
        // 兜底：任何异常都返回 200 + 空字段，前端显示“读取失败”，绝不 500
        sendJson(res, 200, {
          snowluma: { url: SNOWLUMA_URL, user: '', password: '', error: String(err && err.message ? err.message : err) },
          bridge: { url: BRIDGE_URL, token: '', error: String(err && err.message ? err.message : err), source: '' },
          onebot: { httpUrl: ONEBOT_HTTP, wsUrl: 'ws://127.0.0.1:3001', accessToken: '', error: String(err && err.message ? err.message : err) },
          note: '仅本机回环可见',
        });
      }
      return;
    }
    if (req.method === 'GET' && pathname === '/api/processes') {
      const procs = await listProcesses();
      sendJson(res, 200, {
        ok: true,
        fetchedAt: new Date().toISOString(),
        procs: procs.map((p) => ({ ...p, cmdline: p.cmdline.slice(0, 240) })),
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/nudge') {
      try {
        await readBody(req); // confirm 可选，请求体只需要能读掉
      } catch {
        /* 忽略空/非法 body */
      }
      logLine('api/nudge：唤醒所有 QQ 会话处理未读');
      sendJson(res, 200, await nudgeSessions());
      return;
    }
    if ((req.method === 'GET' || req.method === 'POST') && pathname === '/api/snowluma/inject') {
      logLine(`snowluma/inject（${req.method}）`);
      const result = await injectQQ();
      sendJson(res, 200, result);
      return;
    }
    if (pathname.startsWith('/api/channel/')) {
      const channelCfgPath = path.join(WORKSPACE, 'channel-proxy', 'channels.json');
      const readChannelCfg = () => {
        try { return JSON.parse(fs.readFileSync(channelCfgPath, 'utf8')); } catch { return null; }
      };
      const proxyJson = async (p, body) => {
        try {
          const r = await fetch(`http://127.0.0.1:3090${p}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: body === undefined ? undefined : { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(body === undefined ? 5000 : 90000),
          });
          return await r.json().catch(() => ({}));
        } catch (err) {
          return { ok: false, detail: `通道代理不可用：${String(err && err.message ? err.message : err)}` };
        }
      };
      if (req.method === 'GET' && pathname === '/api/channel/status') {
        const cfg = readChannelCfg();
        const proxy = await proxyJson('/admin/status');
        let dshProvider = null;
        try {
          const patchFile = path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh'), 'profiles', 'web', 'cordis.patch.yml');
          const m = fs.readFileSync(patchFile, 'utf8').match(/^    provider: (deepseek-\w+)\s*$/m);
          dshProvider = m ? m[1] : null;
        } catch { /* 读不到就显示 null */ }
        const relay = cfg && cfg.channels ? cfg.channels.relay : null;
        sendJson(res, 200, {
          ok: true,
          active: cfg ? cfg.active : null,
          dshProvider,
          relayConfigured: !!(relay && relay.baseUrl && relay.apiKey),
          relay: relay ? { baseUrl: relay.baseUrl || '', hasKey: !!relay.apiKey, label: relay.label || '' } : null,
          proxy,
        });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/channel/config') {
        let body = {};
        try { body = JSON.parse((await readBody(req)) || '{}'); } catch {
          sendJson(res, 400, { ok: false, detail: '请求体必须是 JSON' });
          return;
        }
        const result = await proxyJson('/admin/config', body);
        logLine(`channel/config 更新中转配置 ok=${result.ok === true}`);
        sendJson(res, 200, result);
        return;
      }
      if (req.method === 'POST' && pathname === '/api/channel/test') {
        let body = {};
        try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* 空 body 用默认 */ }
        sendJson(res, 200, await proxyJson('/admin/test', body));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/channel/switch') {
        let body = {};
        try { body = JSON.parse((await readBody(req)) || '{}'); } catch {
          sendJson(res, 400, { ok: false, detail: '请求体必须是 JSON' });
          return;
        }
        const ch = String(body.channel || '');
        if (ch !== 'official' && ch !== 'relay') {
          sendJson(res, 400, { ok: false, detail: 'channel 必须是 official 或 relay' });
          return;
        }
        logLine(`channel/switch -> ${ch}`);
        const out = await runNodeScript(path.join(WORKSPACE, 'channel-proxy', 'switch.mjs'), [ch], { cwd: WORKSPACE });
        sendJson(res, 200, { ok: out.code === 0, channel: ch, status: out.code, stdout: out.stdout, stderr: out.stderr });
        return;
      }
      sendJson(res, 404, { ok: false, detail: `未找到接口：${req.method} ${pathname}` });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/action') {
      let body = {};
      try {
        const text = await readBody(req);
        body = text ? JSON.parse(text) : {};
      } catch {
        sendJson(res, 400, { ok: false, detail: '请求体必须是 JSON' });
        return;
      }
      const action = String(body.action || '');
      if (!ACTION_LABELS[action]) {
        sendJson(res, 400, { ok: false, detail: `不支持的操作：${action || '(空)'}` });
        return;
      }
      if (CONFIRM_ACTIONS.has(action) && body.confirm !== true) {
        sendJson(res, 400, { ok: false, detail: `操作「${ACTION_LABELS[action]}」需要二次确认（confirm:true）`, needConfirm: true });
        return;
      }
      logLine(`action=${action} confirm=${body.confirm === true}`);
      const result = await runAction(action, body);
      if (result && result.unknown) sendJson(res, 400, result);
      else sendJson(res, 200, result);
      return;
    }
    sendJson(res, 404, { ok: false, detail: `未找到接口：${req.method} ${pathname}` });
  } catch (err) {
    logLine(`请求异常 ${req.method} ${pathname}: ${String(err && err.stack ? err.stack : err)}`);
    if (!res.headersSent) sendJson(res, 500, { ok: false, detail: String(err && err.message ? err.message : err) });
    else res.end();
  } finally {
    if (process.env.DSH_QQ_CONSOLE_VERBOSE === '1') {
      logLine(`${req.method} ${pathname} ${Date.now() - started}ms`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

async function isOurPanel(port) {
  const r = await getJson(`http://127.0.0.1:${port}/api/status`, { timeout: 1500 });
  return !!(r.ok && r.data && r.data.panel && r.data.panel.name === 'deepseek-qq-console');
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (!fs.existsSync(HTML_PATH)) logLine(`警告：找不到页面文件 ${HTML_PATH}`);

  let port = 3300;
  if (await tcpProbe(3300, 1000)) {
    if (await isOurPanel(3300)) {
      logLine('控制台已经在 3300 端口运行，本次启动直接退出。');
      process.exit(0);
    }
    logLine('3300 端口被其他程序占用，改用 3310。');
    port = 3310;
    if (await tcpProbe(3310, 1000)) {
      if (await isOurPanel(3310)) {
        logLine('控制台已经在 3310 端口运行，本次启动直接退出。');
        process.exit(0);
      }
      logLine('错误：3300 与 3310 都被占用，无法启动控制台。');
      process.exit(1);
    }
  }
  PANEL_PORT = port;

  const server = http.createServer(handler);
  server.requestTimeout = 130000;
  server.headersTimeout = 20000;
  server.keepAliveTimeout = 5000;

  try {
    await listen(server, port);
  } catch (err) {
    logLine(`监听 127.0.0.1:${port} 失败：${String(err)}`);
    process.exit(1);
  }
  logLine(`DeepSeek × QQ 控制台已启动：http://127.0.0.1:${port}`);
}

process.on('uncaughtException', (err) => {
  logLine(`uncaughtException: ${err && err.stack ? err.stack : String(err)}`);
});
process.on('unhandledRejection', (err) => {
  logLine(`unhandledRejection: ${err && err.stack ? err.stack : String(err)}`);
});
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main();
