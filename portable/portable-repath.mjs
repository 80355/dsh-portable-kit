#!/usr/bin/env node
// portable-repath.mjs — 把 DSH 配置里写死的绝对路径改写成本栈（当前盘符）自己的路径。
//
// 为什么需要：可移动卡在别的电脑上可能不是同一个盘符，而
//   <root>/.dsh/profiles/web/cordis.patch.yml  — MCP 的 command / args 全是绝对路径
//   <root>/.dsh/profiles/web/package.json      — dsh-screen / qq 插件是绝对 file:/link: 依赖
// 这些一旦写死，换个盘符就全挂。每次启动跑一遍这个脚本（幂等、毫秒级）即可。
//
// 用法：node portable-repath.mjs          （由 start-dsh.bat 自动调用）
//       node portable-repath.mjs --check  （只报告，不写盘）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));      // <root>
// 本脚本永远住在 <root> 根上，配置就在 <root>\.dsh。
// 这里刻意「先认目录、再认环境变量」：如果环境里残留着别的安装的 DSH_HOME
// （比如在 DSH 自己的 shell 里手动跑这个脚本），绝不能用它去改写别人的配置。
const LOCAL_HOME = path.join(HERE, '.dsh');
const HAS_LOCAL = fs.existsSync(path.join(LOCAL_HOME, 'profiles'));
// 安全闸：本栈没有自己的 .dsh/profiles 时，绝不回退去改环境变量指向的「别人的」安装。
// 只有显式 --force 才允许（例如你把配置放在别处做调试）。
if (!HAS_LOCAL && !process.argv.includes('--force')) {
  const envHome = process.env.DSH_HOME;
  console.error('[repath] 跳过：本栈没有 ' + LOCAL_HOME + ' 下的 profiles 目录');
  console.error('[repath] ' + (envHome
    ? '注意：环境变量 DSH_HOME=' + envHome + ' 指向另一份安装，本脚本不会去改它。'
    : '请确认在正确的栈根目录运行；确实要改环境变量指向的安装请加 --force。'));
  process.exit(2);
}
const DSH_HOME = HAS_LOCAL ? LOCAL_HOME : process.env.DSH_HOME;
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', 'web');
const NODE_EXE = path.join(HERE, 'node', 'node.exe');
const WORKSPACE = path.join(HERE, 'workspace');
const checkOnly = process.argv.includes('--check');

// YAML 单引号串里的反斜杠按惯例写成两个，跟原文件保持一致
const yq = (p) => `'${p.replace(/\\/g, '\\\\')}'`;
const changed = [];

// 想从这一栈里彻底关掉的配置块：在 <root>\portable-strip.txt 里一行写一个 id 前缀。
// 例如里面写 mcp-tts-voice，卡上就会把 mcp-tts-voice-7 整个 MCP 条目删掉（语音功能不带在卡上）。
function readStripList() {
  const f = path.join(HERE, 'portable-strip.txt');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

// 在 YAML 文本里按「块」删掉 id 命中前缀的列表项（保留其它内容与注释顺序）
function stripBlocks(text, tokens) {
  if (!tokens.length) return { text, removed: [] };
  const lines = text.split(/\r?\n/);
  const out = [];
  const removed = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^(\s*)- id:\s*(\S+)\s*$/.exec(lines[i]);
    if (m && tokens.some((t) => m[2] === t || m[2].startsWith(t))) {
      const indent = m[1].length;
      const id = m[2];
      let j = i + 1;
      while (j < lines.length) {
        const L = lines[j];
        if (L.trim() === '') { j += 1; continue; }
        const curIndent = L.length - L.trimStart().length;
        if (curIndent <= indent) break;
        j += 1;
      }
      // 顺带吃掉紧跟其后的空行，别留下双空行
      while (j < lines.length && lines[j].trim() === '') j += 1;
      out.push(`# [portable] 已按 portable-strip.txt 移除: ${id}`);
      removed.push(id);
      i = j;
      continue;
    }
    out.push(lines[i]);
    i += 1;
  }
  return { text: out.join('\n'), removed };
}

function rewriteYml() {
  const file = path.join(PROFILE_DIR, 'cordis.patch.yml');
  if (!fs.existsSync(file)) return `skip (missing): ${file}`;
  const before = fs.readFileSync(file, 'utf8');
  const stripTokens = readStripList();
  const stripped = stripBlocks(before, stripTokens);
  const lines = stripped.text.split(/\r?\n/);
  let touched = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // 1) MCP 的 node 可执行文件
    const mCmd = line.match(/^(\s*command:\s*)'(.*[\\/]node\.exe)'\s*$/i);
    if (mCmd) {
      const next = mCmd[1] + yq(NODE_EXE);
      if (next !== line) { lines[i] = next; touched += 1; }
      continue;
    }
    // 2) MCP 的脚本参数：任何 .../mcp-xxx.js 都改指到本栈 workspace\qq-bridge\src\<同名>
    const mArg = line.match(/^(\s*-\s*)'(.*[\\/](mcp-[A-Za-z0-9._-]+\.js))'\s*$/);
    if (mArg) {
      const target = path.join(WORKSPACE, 'qq-bridge', 'src', mArg[3]);
      const next = mArg[1] + yq(target);
      if (next !== line) { lines[i] = next; touched += 1; }
    }
  }

  const didStrip = stripped.removed.length > 0;
  if (!touched && !didStrip) return 'yml: already portable';
  if (!checkOnly) fs.writeFileSync(file, lines.join('\n'), 'utf8');
  if (didStrip) changed.push(`cordis.patch.yml (移除 ${stripped.removed.join(', ')})`);
  if (touched) changed.push(`cordis.patch.yml (${touched} 行)`);
  return `yml: 改写 ${touched} 行` + (didStrip ? `，移除 ${stripped.removed.length} 个条目 (${stripped.removed.join(', ')})` : '');
}

function rewritePackageJson() {
  const file = path.join(PROFILE_DIR, 'package.json');
  if (!fs.existsSync(file)) return `skip (missing): ${file}`;
  const raw = fs.readFileSync(file, 'utf8');
  const pkg = JSON.parse(raw);
  const deps = pkg.dependencies || {};
  const want = {
    // 从 <root>/.dsh/profiles/web 出发：../../../workspace/dsh-screen
    'dsh-screen': 'file:../../../workspace/dsh-screen',
    // 从 <root>/.dsh/profiles/web 出发：../../plugins/<name>
    'qq-agent-presets': 'file:../../plugins/qq-agent-presets',
    'qq-mode-console': 'file:../../plugins/qq-mode-console',
  };
  let touched = 0;
  for (const [name, spec] of Object.entries(want)) {
    if (!(name in deps)) continue;
    if (deps[name] !== spec) { deps[name] = spec; touched += 1; }
  }
  if (!touched) return 'package.json: already portable';
  if (!checkOnly) fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  changed.push(`package.json (${touched} 项依赖)`);
  return `package.json: 改写 ${touched} 项依赖`;
}

console.log(`[repath] root      = ${HERE}`);
console.log(`[repath] DSH_HOME  = ${DSH_HOME}`);
console.log(`[repath] node      = ${NODE_EXE} (${fs.existsSync(NODE_EXE) ? 'ok' : 'MISSING'})`);
console.log(`[repath] ${rewriteYml()}`);
console.log(`[repath] ${rewritePackageJson()}`);
console.log(checkOnly ? '[repath] --check 模式，未写盘' : (changed.length ? `[repath] 已更新: ${changed.join(', ')}` : '[repath] 无需改动'));
