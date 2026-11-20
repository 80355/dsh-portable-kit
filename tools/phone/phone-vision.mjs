/**
 * phone-vision.mjs —— 手机读屏模块（带截图指纹缓存）
 *
 * 设计依据（全部来自实测，不是猜测）：
 *  - 单次视觉调用下限 ~6 秒（claude-sonnet-5，原图 1200x2652），无法再压缩。
 *    降采样无效：token 由模型的图片切块策略决定，与字节数无关
 *    （实测 400px 档 prompt_tokens=23104，反而比原图 15030 更高），
 *    且小字会认错（嗶哩嗶哩 → 嗨唔嗨唔），会导致点错东西。
 *  - 换模型无效：claude-haiku-5-5 实测 17.3 秒（早先的 1.9 秒是上游
 *    prompt cache 命中造成的假象）；claude-haiku-4-5 精度只有 3/11；
 *    gemini-4-argon 10/11；只有 claude-sonnet-5 是 11/11 且稳定。
 *  - 唯一有效的提速手段 = 不重复调用。
 *
 * 指纹为什么用「截图 md5」而不是「Activity hash」：
 *  - mCurrentFocus 的 hash 只随 Activity 变化。实测在同一 Activity 内
 *    input swipe 滚动后 hash 完全不变 → 无法感知内容变化。
 *  - QQ 聊天页正是「同 Activity + 内容变化」，只信 Activity hash 会
 *    返回陈旧画面，导致基于不存在的消息回复。
 *  - 截图是必做步骤（要发给模型），所以 md5 的额外成本 ~1ms，
 *    而 Activity hash 方案要额外花 340ms 且不安全。
 *
 * 用法：
 *   import { readScreen } from './phone-vision.mjs';
 *   const r = await readScreen();
 *   console.log(r.cached, r.ms, r.text);
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const execFileP = promisify(execFile);

// ---------- 配置 ----------
export const ADB = process.env.ADB_BIN || 'adb';
// 你手机 USB 调试序列号：`adb devices` 第一列（形如 1234567890ABCDEF）。
// 留空则只走无线调试（_adb-tls-connect），详见 docs/手机操控.md。
export const USB_SERIAL = process.env.PHONE_SERIAL || '';
export const SERIAL = USB_SERIAL; // 兼容旧导出（固定为 USB 序列号）
export const COCO_BASE = 'https://api.cocoapi.top/v1/chat/completions';
export const VISION_MODEL = 'claude-sonnet-5';
export const CACHE_MAX = 20;
export const SHOT_PATH = path.join(os.tmpdir(), 'phone-vision', 'current.png');

// ---------- adb 封装（自动重连）----------
let _adbChain = Promise.resolve(); // 串行化：并发 adb 会导致 server 状态错乱
let _serial = USB_SERIAL; // 实际使用的 serial：优先 USB，USB 掉线时自动切无线

/** 运行 adb devices，自动选可用设备：优先 USB 精确匹配，否则退回无线调试（_adb-tls-connect）。 */
async function resolveSerial() {
  try {
    const { stdout } = await execFileP(ADB, ['devices'], { timeout: 10000 });
    const lines = String(stdout).split('\n').slice(1);
    for (const l of lines) {
      // adb devices 用 \t 分隔 serial 和 state；mDNS 序列号里可能带空格（"(2)" 去重后缀），不能用 \s+ 拆
      const [sn, state] = l.trim().split('\t');
      if (sn === USB_SERIAL && state === 'device') return sn;
    }
    for (const l of lines) {
      // adb devices 用 \t 分隔 serial 和 state；mDNS 序列号里可能带空格（"(2)" 去重后缀），不能用 \s+ 拆
      const [sn, state] = l.trim().split('\t');
      if (sn && sn.includes('_adb-tls-connect') && state === 'device') return sn;
    }
  } catch {}
  return null;
}

async function adbRaw(args, { timeout = 30000 } = {}) {
  return execFileP(ADB, ['-s', _serial, ...args], {
    timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer',
  });
}

async function adbRecover() {
  try { await execFileP(ADB, ['kill-server'], { timeout: 10000 }); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  try { await execFileP(ADB, ['start-server'], { timeout: 20000 }); } catch {}
  // 轮询等待设备出现，而不是固定 sleep 3 秒（实测固定 sleep 让重连高达 16 秒）
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const sn = await resolveSerial();
    if (sn) { _serial = sn; return; }
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * 带自动重连的 adb 调用。串行化执行，避免并发把 adb server 搞乱。
 * 这是我踩过的坑：连续快速发多条命令时 server 会掉成空列表。
 */
export function adb(args, opts) {
  const task = _adbChain.then(async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const sn = await resolveSerial();
      if (sn) {
        _serial = sn;
        try {
          const r = await adbRaw(args, opts);
          return r;
        } catch (e) {
          const msg = String(e.stderr || e.message || '');
          if (!/device .* not found|no devices|closed/i.test(msg)) throw e;
        }
      }
      await adbRecover();
    }
    throw new Error(`ADB 连续 3 次失败，无法恢复：adb ${args.join(' ')}`);
  });
  // 保证链不因单次失败而断掉
  _adbChain = task.then(() => {}, () => {});
  return task;
}

/**
 * 强制重连 adb（截图完整性校验失败时调用）。
 * 实测：adb 掉线/重连期间 exec-out screencap 会返回残缺数据且不报错，
 * 必须先重连再重试，单纯原地重试会拿到同样的坏数据。
 */
export async function adbReconnect() {
  await adb(['get-state']).catch(() => {});
  await adbRecover();
}

// ---------- 截图 ----------
/**
 * 校验截图的 PNG 完整性。**这是必须的** —— 实测踩到的坑：
 * adb 掉线/重连期间 `exec-out screencap -p` 会「成功返回」一段残缺数据
 * （实测只拿到 360 字节：有 PNG 头，但只有 IHDR/iCCP/sBIT 三个 chunk，
 * 没有 IDAT 图像数据也没有 IEND 结束标记）。
 * 把这种坏图发给视觉模型会稳定触发上游错误：
 *   {"type":"upstream_error","message":"The service is temporarily unavailable..."}
 * 而且坏图的 md5 与正常图不同，会让指纹缓存永远无法命中。
 *
 * 完整截图实测特征：约 200KB、头 8 字节 89504e470d0a1a0a、尾 8 字节 49454e44ae426082（IEND+CRC）。
 */
const MIN_PNG_BYTES = 10 * 1024;

function assertPng(buf) {
  if (!buf || buf.length < MIN_PNG_BYTES) {
    throw new Error(`截图数据残缺：只有 ${buf ? buf.length : 0} 字节（正常约 200KB）`);
  }
  if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('截图不是 PNG（文件头校验失败）');
  }
  const tail = buf.slice(-8).toString('hex');
  if (tail !== '49454e44ae426082') {
    throw new Error(`截图 PNG 不完整（缺少 IEND 结束标记，尾部为 ${tail}）`);
  }
}

/**
 * 用 ffmpeg 裁掉顶部状态栏，只留内容区。
 *
 * 为什么必须裁：实测手机屏幕的状态栏「时间」和「电量」每时每刻都在变，
 * 直接对整张 PNG 取 md5 会导致指纹每次都不同 —— 缓存永远不可能命中。
 * 裁掉状态栏后，时间/电量变化不再影响指纹，而页面内容变化仍会导致指纹变化。
 *
 * 状态栏高度实测约 132px（1200x2652 屏幕），用 -vf crop 裁掉顶部。
 */
const STATUSBAR_H = 132;
let _ffmpegPath = null;

async function findFfmpeg() {
  if (_ffmpegPath) return _ffmpegPath;
  const candidates = [
    process.env.FFMPEG,
    'ffmpeg',
  ].filter(Boolean);
  for (const c of candidates) {
    try { await execFileP(c, ['-version'], { timeout: 8000 }); _ffmpegPath = c; return c; } catch {}
  }
  throw new Error('找不到 ffmpeg，无法裁剪状态栏');
}

// ---------- 坐标网格叠加 ----------
// 「给 AI 一部手机」这类教程里的核心技巧之一：在截图上画一层坐标网格 +
// 轴边刻度数字，让视觉模型直接读出「发送键在 (860, 2320)」，而不是含糊的
// 「大致位置」。对点击精度几乎是质变级提升。
const GRID_PX = 120; // 网格间距（像素），与视频一致
const GRID_FONT = 'C\\:/Windows/Fonts/arial.ttf';

/** 从 PNG 字节头读宽高（不起了进程，~微秒级）。PNG 签名(8) + IHDR长度(4) + 'IHDR'(4) + W(4) + H(4)。 */
export function pngSize(buf) {
  if (!buf || buf.length < 24 || buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/**
 * 在截图字节上叠加坐标网格 + 轴刻度数字，返回新的 PNG 字节。
 * 网格线每隔 GRID_PX 一条（半透明红），x 刻度标在顶部、y 刻度标在左侧
 * （黄字 + 黑底，保证在任意画面上都能看清）。
 * 失败时（ffmpeg 缺失等）返回原图，不阻断读屏。
 */
export async function drawGrid(buf) {
  try {
    const size = pngSize(buf);
    if (!size) return buf;
    const { w, h } = size;
    const ff = await findFfmpeg();
    const tmpIn = path.join(path.dirname(SHOT_PATH), 'grid-in.png');
    const tmpOut = path.join(path.dirname(SHOT_PATH), 'grid-out.png');
    await fs.mkdir(path.dirname(SHOT_PATH), { recursive: true });
    await fs.writeFile(tmpIn, buf);

    const filters = [
      `drawgrid=width=${GRID_PX}:height=${GRID_PX}:thickness=1:color=red@0.55`,
    ];
    // 注意：fontfile 必须同时满足「反斜杠转义冒号 C\:」+「单引号包裹」，
    // 二者缺一 ffmpeg 都报 "No option name near '/Windows/...'"（已实测三条路）。
    for (let x = GRID_PX; x < w; x += GRID_PX) {
      filters.push(`drawtext=text='${x}':x=${x + 2}:y=3:fontsize=20:fontcolor=yellow:box=1:boxcolor=black@0.55:boxborderw=3:fontfile='${GRID_FONT}'`);
    }
    for (let y = GRID_PX; y < h; y += GRID_PX) {
      filters.push(`drawtext=text='${y}':x=3:y=${y + 2}:fontsize=20:fontcolor=yellow:box=1:boxcolor=black@0.55:boxborderw=3:fontfile='${GRID_FONT}'`);
    }

    await execFileP(ff, ['-y', '-loglevel', 'error', '-i', tmpIn, '-vf', filters.join(','), tmpOut], { timeout: 25000 });
    const out = await fs.readFile(tmpOut);
    return out.length ? out : buf;
  } catch (e) {
    const stderr = e.stderr ? String(e.stderr).split('\n').filter(Boolean).slice(-3).join(' | ') : '';
    console.error('[grid] 画坐标网格失败，退回原图：', String(e.message || e).slice(0, 120), stderr ? ` stderr=${stderr.slice(0, 200)}` : '');
    return buf;
  }
}

/** 裁掉顶部状态栏。失败时返回原图（退化为「指纹含状态栏」，缓存命中率降低但不报错）。 */
async function cropStatusBar(buf) {
  try {
    const ff = await findFfmpeg();
    const tmpIn = path.join(path.dirname(SHOT_PATH), 'raw.png');
    const tmpOut = path.join(path.dirname(SHOT_PATH), 'cropped.png');
    await fs.mkdir(path.dirname(SHOT_PATH), { recursive: true });
    await fs.writeFile(tmpIn, buf);
    await execFileP(ff, ['-y', '-loglevel', 'error', '-i', tmpIn,
      '-vf', `crop=iw:ih-${STATUSBAR_H}:0:${STATUSBAR_H}`, tmpOut], { timeout: 20000 });
    const out = await fs.readFile(tmpOut);
    return out.length ? out : buf;
  } catch {
    return buf;
  }
}

/**
 * 截图到本地。返回 { buf, fpBuf, md5, ms, shotMs, stable, tries }。
 *
 * 用 exec-out 直接取字节，避免手机上写文件再 pull 的两倍开销。
 *
 * **静止检测（关键，实测得出）**：Activity 切换动画 / 惯性滑动期间连续两次
 * 截图的字节完全不同 —— 实测那一次耗时 7090ms，而屏幕静止后只要 616ms，
 * 差异字节占 97%（PNG 是压缩格式，局部像素变化会让后续字节整体错位）。
 * 屏幕静止后 md5 完全一致（实测 #2/#3/#4 三次 md5 完全相同）。
 * 所以这里连续截图直到两次 md5 一致，确认画面已静止才返回，
 * 否则指纹会抖动、缓存永远无法命中。
 *
 * md5 取自「裁掉状态栏后」的字节：屏蔽时间/电量的持续变化，
 * 但页面内容变化仍会导致指纹变化。
 */
export async function capture({ crop = true, maxTries = 4, requireStable = true, trace = !!process.env.PV_TRACE } = {}) {
  const t0 = Date.now();
  let prev = null;
  let softFails = 0;
  const log = (...a) => { if (trace) console.error('[capture]', ...a); };

  for (let tries = 1; tries <= maxTries; tries++) {
    const s0 = Date.now();
    let raw;
    try {
      const { stdout } = await adb(['exec-out', 'screencap', '-p'], { timeout: 30000 });
      raw = Buffer.from(stdout);
      assertPng(raw);
    } catch (e) {
      // 残缺截图是间歇性的（实测约 386ms 就返回，说明 adb 提前结束了流）。
      // **策略：先原地立刻重试**（代价 ~600ms），不要马上重连 ——
      // adbRecover() 实测要 16 秒，为一次瞬时抖动付这个代价太贵。
      // 连续软失败 2 次才认为链路真的坏了，那时才重连。
      softFails++;
      if (softFails < 2 && tries < maxTries) {
        log(`try${tries} 截图残缺(${Date.now() - s0}ms): ${e.message.slice(0, 60)} → 原地重试`);
        continue;
      }
      if (tries === maxTries) throw e;
      log(`try${tries} 连续 ${softFails} 次残缺 → 重连 adb`);
      const rc0 = Date.now();
      await adbReconnect();
      log(`try${tries} 重连耗时 ${Date.now() - rc0}ms`);
      softFails = 0;
      continue;
    }
    softFails = 0;
    const shotMs = Date.now() - s0;

    const c0 = Date.now();
    const fpBuf = crop ? await cropStatusBar(raw) : raw;
    const cropMs = Date.now() - c0;
    const md5 = createHash('md5').update(fpBuf).digest('hex');

    log(`try${tries} 截图=${shotMs}ms(含adb检查) 裁剪=${cropMs}ms md5=${md5.slice(0, 10)} ${prev && prev.md5 === md5 ? '★与上次相同' : '(与上次不同)'}`);

    if (prev && prev.md5 === md5) {
      await fs.mkdir(path.dirname(SHOT_PATH), { recursive: true });
      await fs.writeFile(SHOT_PATH, raw);
      return { buf: raw, fpBuf, md5, ms: Date.now() - t0, shotMs, path: SHOT_PATH, stable: true, tries };
    }

    prev = { buf: raw, fpBuf, md5, shotMs };
    if (tries < maxTries) {
      if (!requireStable) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  log(`达到上限仍未稳定，总耗时 ${Date.now() - t0}ms`);
  // requireStable=false，或达到上限仍不稳定：返回最后一次，标记 stable=false
  await fs.mkdir(path.dirname(SHOT_PATH), { recursive: true });
  await fs.writeFile(SHOT_PATH, prev.buf);
  return { ...prev, ms: Date.now() - t0, path: SHOT_PATH, stable: false, triesUsed: maxTries };
}

// ---------- 视觉调用 ----------
const KEY = process.env.COCO_KEY || process.env.OPENAI_API_KEY;
if (!KEY) throw new Error('缺少视觉 API Key：请先设置环境变量 COCO_KEY（见 docs/配置说明.md）');

const DEFAULT_QUESTION = `这是安卓手机截图，上面叠了一层坐标网格（每 ${GRID_PX} 像素一条红线，顶部标 x 刻度、左侧标 y 刻度，黄字）。请严格按下面格式回答，不要解释、不要客套：
页面：<当前页面是什么，一句话>
列表：<从上到下的可见文字项，用 | 分隔>
时间：<状态栏时间>
电量：<电量百分比>
可点：<最值得点击的 3 个目标，格式 文字(x,y)，x/y 必须是读网格刻度得出的精确像素坐标，例如 发送(860,2320)>`;

/**
 * 调视觉模型。带退避重试 —— 实测中转站会偶发返回
 * {"type":"upstream_error","message":"The service is temporarily unavailable..."}，
 * 这是上游抖动，重试通常即可恢复。
 */
export async function askVision(buf, question = DEFAULT_QUESTION, { timeoutMs = 90000, retries = 3 } = {}) {
  const b64 = buf.toString('base64');
  const t0 = Date.now();
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(COCO_BASE, {
        method: 'POST',
        signal: ac.signal,
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: VISION_MODEL,
          max_tokens: 900,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
              { type: 'text', text: question },
            ],
          }],
        }),
      });
      const d = await r.json();
      if (d.error) {
        const transient = /upstream_error|temporarily unavailable|rate.?limit|overload/i.test(
          JSON.stringify(d.error));
        lastErr = new Error(`上游错误: ${JSON.stringify(d.error).slice(0, 300)}`);
        if (!transient || attempt === retries) throw lastErr;
        await new Promise((r2) => setTimeout(r2, 1500 * attempt));
        continue;
      }
      const text = d.choices?.[0]?.message?.content ?? '';
      if (!text) { lastErr = new Error('模型返回空内容'); if (attempt < retries) { await new Promise((r2) => setTimeout(r2, 1000 * attempt)); continue; } throw lastErr; }
      return { text, ms: Date.now() - t0, usage: d.usage, bytes: buf.length, attempts: attempt };
    } catch (e) {
      lastErr = e;
      const isAbort = e.name === 'AbortError';
      if (attempt === retries) throw isAbort ? new Error(`视觉调用超时 ${timeoutMs}ms`) : e;
      await new Promise((r2) => setTimeout(r2, 1500 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// ---------- 缓存 ----------
const cache = new Map(); // md5 -> { text, usage, at }

function cacheGet(md5) {
  const hit = cache.get(md5);
  if (!hit) return null;
  // LRU：命中后挪到末尾
  cache.delete(md5);
  cache.set(md5, hit);
  return hit;
}

function cachePut(md5, val) {
  cache.set(md5, val);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// ---------- 主入口 ----------
/**
 * 读屏。同一画面（截图字节完全一致）直接返回缓存，不重复调模型。
 *
 * @returns {Promise<{text:string, cached:boolean, md5:string, totalMs:number,
 *                    shotMs:number, visionMs:number, usage?:object}>}
 */
export async function readScreen({ question = DEFAULT_QUESTION, force = false, crop = true } = {}) {
  const t0 = Date.now();
  const shot = await capture({ crop });
  const shotMs = Date.now() - t0;

  if (!force) {
    const hit = cacheGet(shot.md5);
    if (hit) {
      return {
        text: hit.text, cached: true, md5: shot.md5,
        totalMs: Date.now() - t0, shotMs, visionMs: 0, usage: hit.usage,
      };
    }
  }

  // 发往模型前叠坐标网格（只在缓存未命中时做一次，~200ms，代价可接受）。
  // 指纹用的仍是原始 fpBuf，网格不影响缓存 key。
  const gridBuf = await drawGrid(shot.buf);
  const v = await askVision(gridBuf, question);
  cachePut(shot.md5, { text: v.text, usage: v.usage, at: Date.now() });
  return {
    text: v.text, cached: false, md5: shot.md5,
    totalMs: Date.now() - t0, shotMs, visionMs: v.ms, usage: v.usage, attempts: v.attempts,
  };
}

// ---------- 附加：便宜的状态查询（不调模型）----------
/** 当前前台 Activity。~340ms，用于日志/调试，不作为缓存指纹（感知不到内容变化）。 */
export async function focusedActivity() {
  const { stdout } = await adb(['shell', 'dumpsys window | grep -m1 mCurrentFocus']);
  const s = String(stdout);
  const m = s.match(/Window\{[0-9a-f]+ u0 ([^}]+)\}/);
  return m ? m[1] : s.trim();
}

/** 点击 */
export async function tap(x, y) {
  await adb(['shell', `input tap ${Math.round(x)} ${Math.round(y)}`]);
}

/** 滑动 */
export async function swipe(x1, y1, x2, y2, ms = 300) {
  await adb(['shell', `input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${ms}`]);
}

/** 输入文本（ASCII）。中文需走其他通道，见 setClipboard+paste。 */
export async function inputText(s) {
  const esc = String(s).replace(/(["\\$`])/g, '\\$1').replace(/ /g, '%s');
  await adb(['shell', `input text "${esc}"`]);
}

/** 按键 */
export async function key(code) {
  await adb(['shell', `input keyevent ${code}`]);
}

// ---------- 中文输入（ADBKeyboard）----------
// 视频教程核心技巧之一：`adb shell input text` 只能打 ASCII，中文会变空白。
// 解法 = 装开源 ADBKeyboard，再走广播打 base64 的 UTF-8。
const ADBKB_IME = 'com.android.adbkeyboard/.AdbIME';

/** 安装并启用 ADBKeyboard（apkPath 为本地 APK 的绝对路径）。 */
export async function installAdbKeyboard(apkPath) {
  await adb(['install', '-r', apkPath], { timeout: 120000 });
  await adb(['shell', 'ime', 'enable', ADBKB_IME]);
  await adb(['shell', 'ime', 'set', ADBKB_IME]);
}

/** 用 ADBKeyboard 打中文（UTF-8 → base64 → 广播）。安装太慢（~2 秒），适合一次性短文本。
 * 返回广播结果 stdout（正常含 "Broadcast completed: result=0"）。 */
export async function inputTextCn(text) {
  const b64 = Buffer.from(String(text), 'utf8').toString('base64');
  const r = await adb(['shell', 'am', 'broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', b64]);
  return String(r.stdout).trim();
}

/** 切回系统默认输入法（视频坑③：打完中文立刻切输入法会丢字，应保持 30 秒后再切）。 */
export async function resetIme() {
  await adb(['shell', 'ime', 'reset']);
}

// ---------- uiautomator 节点树 ----------
// 视频核心原则：截图拿来定位、节点树拿来确认，两个都要给——因为抖音这类
// 重绘 App 的节点树会停留在上一页（屏幕已是私聊、树还返回消息列表）。
/** uiautomator dump 拿节点树（裸 dump 3~5 秒，慢但可靠）。返回 XML 文本。 */
export async function dumpUi() {
  await adb(['shell', 'uiautomator', 'dump', '/sdcard/window_dump.xml'], { timeout: 60000 });
  const { stdout } = await adb(['exec-out', 'cat', '/sdcard/window_dump.xml'], { timeout: 30000 });
  return String(stdout);
}

/**
 * 把节点树解析成可点击元素的列表，返回 text 非空的节点：
 * [{ text, bounds:[x1,y1,x2,y2], cx, cy }]。cx/cy 是控件中心，可直接喂给 tap()。
 * 这是视频「截图定位 + 节点树确认」里的「确认」半边——截图找「要按哪个」，
 * 节点树给出「精确按在哪」。
 */
export async function uiNodes() {
  const xml = await dumpUi();
  const out = [];
  const nodeRe = /<node\b[^>]*>/g;
  const unesc = (s) => String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, '\n');
  let m;
  while ((m = nodeRe.exec(xml)) !== null) {
    // 属性顺序不固定：逐个抽出，text 和 content-desc 都可能承载「按钮上写了什么」
    const attrs = {};
    const attrRe = /([-\w:]+)="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(m[0])) !== null) attrs[a[1]] = a[2];
    const bm = (attrs.bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!bm) continue;
    const x1 = +bm[1], y1 = +bm[2], x2 = +bm[3], y2 = +bm[4];
    const text = unesc(attrs.text || '').trim();
    const contentDesc = unesc(attrs['content-desc'] || '').trim();
    if (!text && !contentDesc) continue; // 只保留有「可读标签」的节点
    out.push({
      text, contentDesc,
      resourceId: attrs['resource-id'] || '',
      className: attrs['class'] || '',
      clickable: attrs['clickable'] === 'true',
      bounds: [x1, y1, x2, y2],
      cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2),
    });
  }
  return out;
}

/** 按文字/描述模糊匹配节点，返回第一个命中（text 或 content-desc 均可）。 */
export async function findNode(substr) {
  const nodes = await uiNodes();
  const s = String(substr);
  return nodes.find((n) => (n.text + '\n' + n.contentDesc).includes(s)) || null;
}

// ---------- 屏幕状态（视频坑⑥：AOD 息屏显示会骗人）----------
/** 判断屏幕是否真亮着。AOD 息屏显示会骗人：mWakefulness=Asleep 但屏其实亮着，
 * 此时不应按电源键（视频坑⑥）。同时看两个来源：power 的 wakefulness + display 的 mScreenState。 */
export async function screenState() {
  const [{ stdout: a }, { stdout: b }] = await Promise.all([
    adb(['shell', 'dumpsys power | grep mWakefulness='], { timeout: 20000 }),
    adb(['shell', 'dumpsys display | grep -i mScreenState='], { timeout: 20000 }),
  ]);
  const w = (String(a).match(/mWakefulness=(\w+)/) || [])[1] || '?';
  const s = (String(b).match(/mScreenState=(\w+)/i) || [])[1] || '?';
  return { wakefulness: w, screenState: s, screenOn: s === 'ON' };
}

export function cacheSize() { return cache.size; }
export function cacheClear() { cache.clear(); }

// ---------- 视频「十条坑」防御 ----------

/**
 * 坑⑨：QQ 图片后缀不可信（GIF 会被存成 .jpg，反之亦然），判断类型只看字节头。
 * 返回 'gif' | 'png' | 'jpeg' | 'bmp' | 'webp' | 'unknown'。
 */
export function imageType(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  if (b.length < 4) return 'unknown';
  const hex = b.slice(0, 12).toString('hex');
  if (hex.startsWith('474946383961') || hex.startsWith('474946383761')) return 'gif'; // GIF89a / GIF87a
  if (hex.startsWith('89504e470d0a1a0a')) return 'png';
  if (hex.startsWith('ffd8ff')) return 'jpeg';
  if (hex.startsWith('424d')) return 'bmp';
  if (hex.startsWith('52494646') && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return 'unknown';
}

/**
 * 坑⑦：App 自持屏幕锁（如抖音 hold SCREEN_BRIGHT_WAKE_LOCK），改系统设置没用，
 * 必须 force-stop 才能让它松开。pkg 如 'com.ss.android.ugc.aweme'（抖音）。
 */
export async function forceStop(pkg) {
  return adb(['shell', 'am', 'force-stop', String(pkg)], { timeout: 20000 });
}

/** 坑⑦补充：列出当前谁在持 wake lock（判断是不是有 App 不让屏睡）。 */
export async function wakeLocks() {
  const { stdout } = await adb(
    ['shell', 'dumpsys power | grep -iE "wake lock|partl|screen_bright|full_wake|locks.size|mWakeLock"'],
    { timeout: 20000 },
  ).catch(() => ({ stdout: '' }));
  return String(stdout || '');
}

/**
 * 坑⑧：滑动后画面没变 = 卡住了（网页版弹「打开App」遮住滑动、页面到底了等）。
 * 滑前截一次、滑后截一次，md5 相同即判定卡住。为避免状态栏时间/电量造成误判，
 * 用 crop=true（去掉状态栏）比较内容区。
 * 返回 { changed, beforeMd5, afterMd5 }。
 */
export async function swipeChecked(x1, y1, x2, y2, ms = 400) {
  const before = await capture({ crop: true, requireStable: false, maxTries: 2 });
  await swipe(x1, y1, x2, y2, ms);
  await new Promise((r) => setTimeout(r, 700)); // 等惯性滑动停稳
  const after = await capture({ crop: true, requireStable: false, maxTries: 2 });
  return { changed: before.md5 !== after.md5, beforeMd5: before.md5, afterMd5: after.md5 };
}

export { cache };
