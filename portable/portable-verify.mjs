#!/usr/bin/env node
// portable-verify.mjs — 便携栈自检：确认这张卡插到别的电脑上能直接跑。
//
// 用法：node portable-verify.mjs
// 退出码：0 全部通过；1 有关键项失败；2 只有警告

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// 同 repath：先认「本栈自己的 .dsh」，再退回环境变量，免得在别人的 shell 里误判。
const LOCAL_HOME = path.join(ROOT, '.dsh');
const DSH_HOME = isDirSafe(path.join(LOCAL_HOME, 'profiles')) ? LOCAL_HOME : (process.env.DSH_HOME || LOCAL_HOME);
const WS = path.join(ROOT, 'workspace');
const NODE = path.join(ROOT, 'node', 'node.exe');
const PROFILE = path.join(DSH_HOME, 'profiles', 'web');

let fails = 0;
let warns = 0;
function isDirSafe(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { fails += 1; console.log(`  FAIL  ${m}`); };
const warn = (m) => { warns += 1; console.log(`  warn  ${m}`); };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const bytes = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

console.log(`\n== 1. 运行时 ==`);
if (isFile(NODE)) {
  ok(`node 运行时存在 ${NODE}`);
  try {
    const v = execFileSync(NODE, ['-v'], { encoding: 'utf8' }).trim();
    ok(`node -v => ${v}`);
  } catch (e) { bad(`node 无法执行: ${e.message}`); }
} else bad(`缺 node 运行时: ${NODE}`);

console.log(`\n== 2. DSH 主体 ==`);
const BIN = path.join(ROOT, 'dsh-workspace', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
isFile(BIN) ? ok('dsh bin.js 存在') : bad(`缺 dsh bin.js: ${BIN}`);
isDir(path.join(DSH_HOME, 'profiles', 'web')) ? ok('DSH_HOME/profiles/web 存在') : bad('缺 DSH_HOME/profiles/web');
isFile(path.join(PROFILE, 'cordis.patch.yml')) ? ok('cordis.patch.yml 存在') : bad('缺 cordis.patch.yml');
isFile(path.join(PROFILE, 'package.json')) ? ok('profile package.json 存在') : bad('缺 profile package.json');
isDir(path.join(ROOT, 'workspace')) ? ok('workspace 存在') : bad('缺 workspace');

console.log(`\n== 3. 路径可移植性（不能残留别的机器的绝对路径）==`);
const yml = isFile(path.join(PROFILE, 'cordis.patch.yml')) ? fs.readFileSync(path.join(PROFILE, 'cordis.patch.yml'), 'utf8') : '';
const pkgRaw = isFile(path.join(PROFILE, 'package.json')) ? fs.readFileSync(path.join(PROFILE, 'package.json'), 'utf8') : '';
const deadPatterns = [/C:[\\/]+Users[\\/]+[A-Za-z0-9_.-]+[\\/]+(?:dsh-workspace|[.]dsh)/i, /D:[\\/]+Documents[\\/]+deepseek-harness/i, /D:[\\/]+dsh[\\/]/i];
for (const [label, text] of [['cordis.patch.yml', yml], ['package.json', pkgRaw]]) {
  const hits = deadPatterns.filter((re) => re.test(text));
  if (hits.length) {
    bad(`${label} 仍含写死路径: ${hits.map((r) => r.source).join(', ')}`);
  } else ok(`${label} 已无写死绝对路径`);
  if (text && text.length) {
    const m = text.match(/^\s*command:\s*'(.+?)'/m);
    if (m) (path.normalize(m[1]) === path.normalize(NODE) ? ok : bad)(`MCP command 指向本栈 node: ${m[1]}`);
  }
}

console.log(`\n== 4. QQ 插件（exFAT 上原来是 junction，已换成实体目录）==`);
for (const name of ['qq-agent-presets', 'qq-mode-console']) {
  const p = path.join(PROFILE, 'node_modules', name);
  if (!isDir(p)) { bad(`缺 ${name}`); continue; }
  const idx = ['lib/index.js', 'index.js', 'dist/index.js'].map((f) => path.join(p, f)).find(isFile)
    || (() => { try { return fs.readdirSync(p).filter((f) => f.endsWith('.mjs')).map((f) => path.join(p, f))[0]; } catch { return undefined; } })();
  idx ? ok(`${name} 有实体入口 (${path.relative(ROOT, idx)})`) : warn(`${name} 存在但没找到常见入口文件`);
  try { if (fs.lstatSync(p).isSymbolicLink()) bad(`${name} 还是符号链接，exFAT 上不合法`); } catch {}
}
const schem = path.join(DSH_HOME, 'plugins', 'qq-mode-console', 'node_modules', '@deepseek-ai', 'schemastery');
isDir(schem) ? ok('qq-mode-console 的 schemastery 实体存在') : bad('qq-mode-console 缺 schemastery 依赖');
isDir(path.join(ROOT, 'dsh-workspace', 'node_modules', '@deepseek-ai', 'dsh')) ? ok('checkout node_modules 完整') : bad('checkout node_modules 不完整');

console.log(`\n== 5. 记忆 / 人格（主人的"大肥鱼"要跟着走）==`);
const mem = path.join(WS, 'shared', '大肥鱼记忆.md');
bytes(mem) > 0 ? ok(`共享记忆 ${Math.round(bytes(mem) / 1024)} KB`) : bad('缺共享记忆 shared/大肥鱼记忆.md');
const persona = path.join(DSH_HOME, 'douyin-browser', 'memory', 'persona', 'role-card.md');
bytes(persona) > 0 ? ok(`人格卡 ${Math.round(bytes(persona) / 1024)} KB`) : bad('缺人格卡 douyin-browser/memory/persona/role-card.md');
const qqRole = path.join(WS, 'qq-bridge', 'roles', '大肥鱼.md');
bytes(qqRole) > 0 ? ok(`QQ 人格 ${Math.round(bytes(qqRole) / 1024)} KB`) : warn('缺 QQ 人格 qq-bridge/roles/大肥鱼.md');
const sqlite = path.join(DSH_HOME, 'douyin-browser', 'memory', 'shared.sqlite');
bytes(sqlite) > 0 ? ok(`抖音记忆库 ${Math.round(bytes(sqlite) / 1024)} KB`) : warn('缺 shared.sqlite');
isFile(path.join(PROFILE, '.credentials.yaml')) || isFile(path.join(DSH_HOME, '.credentials.yaml'))
  ? ok('凭据文件在')
  : warn('没找到 .credentials.yaml（可能只在 DSH_HOME 根，属正常）');

console.log(`\n== 6. 语音功能（主人要求卡上不带）==`);
{
  const stripFile = path.join(ROOT, 'portable-strip.txt');
  const stripList = isFile(stripFile)
    ? fs.readFileSync(stripFile, 'utf8').split(/\r?\n/).map((s) => s.replace(/#.*$/, '').trim()).filter(Boolean)
    : [];
  const asksNoVoice = stripList.some((t) => t.includes('tts-voice'));
  const voiceDirs = [['GPT-SoVITS', 'gpt-sovits'], ['RVC', 'rvc']].filter(([, rel]) => isDir(path.join(WS, rel)));
  const ttsEntry = /mcp-tts-voice/.test(yml.replace(/^#.*$/gm, ''));
  if (asksNoVoice) {
    voiceDirs.length === 0 ? ok('卡上确实没有语音模型目录（已按要求移除）') : warn(`还留着语音目录: ${voiceDirs.map(([l]) => l).join(', ')}`);
    ttsEntry ? bad('配置里还挂着 tts-voice MCP（会去启动不存在的语音服务）') : ok('tts-voice MCP 已从配置移除');
    console.log('  info  想恢复语音：把 gpt-sovits / rvc 拷回 workspace，并删掉 portable-strip.txt 里的 mcp-tts-voice');
  } else {
    for (const [label, rel] of [['GPT-SoVITS', 'gpt-sovits'], ['RVC', 'rvc']]) {
      isDir(path.join(WS, rel)) ? ok(`${label} 目录存在`) : warn(`${label} 不在（不影响 DSH 本体）`);
    }
  }
}

console.log(`\n== 7. exFAT 兼容性（卡上不能有 junction/symlink）==`);
let linkCount = 0;
const SKIP = new Set(['node_modules', '.git']);
function walk(dir, depth) {
  if (depth > 6 || linkCount > 20) return;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    try { const st = fs.lstatSync(p); if (st.isSymbolicLink()) { linkCount += 1; if (linkCount <= 5) console.log(`        link: ${path.relative(ROOT, p)}`); } } catch {}
    if (e.isDirectory() && !SKIP.has(e.name)) walk(p, depth + 1);
  }
}
walk(ROOT, 0);
linkCount === 0 ? ok('没有符号链接/junction') : bad(`发现 ${linkCount}+ 个链接对象（exFAT 上会失效）`);

console.log(`\n== 8. 本机环境 ==`);
console.log(`  info  卡当前盘符 = ${ROOT.slice(0, 2)}  （换电脑盘符变了也没关系，启动脚本自己算）`);
console.log(`  info  系统盘 = ${process.env.SystemDrive || '?'}  用户 = ${os.userInfo().username}`);
console.log(`  info  DSH_HOME = ${DSH_HOME}`);

console.log(`\n===== 结果：${fails} 项失败 / ${warns} 项警告 =====`);
if (fails) { console.log('=> 还不能直接插到别的电脑上用，先修上面的 FAIL 项。\n'); process.exit(1); }
if (warns) { console.log('=> 关键项通过，警告项按需处理。\n'); process.exit(2); }
console.log('=> 全部通过，插到别的 Windows 电脑上双击 start-dsh.bat 即可。\n');
