#!/usr/bin/env node
/**
 * 工程自检（不需要微信开发者工具）：
 *   1) app.json 里每个页面都有 js/json/wxml/wxss 四件套；
 *   2) 页面与组件声明的 usingComponents 路径都能解析到实际文件；
 *   3) 所有 JSON 配置能被解析；
 *   4) core/ 下每个模块都能被 require；
 *   5) 标准数据集每条都带 last_verified_at 与官方来源；
 *   6) 小程序包里没有疑似密钥；
 *   7) 只有 services/ 里直接调 wx.request（架构约束）。
 *
 * 这些检查能抓住"文件漏建/路径写错/密钥误提交"这类真问题，
 * 但**不能**替代在微信开发者工具里的真实编译与真机验证。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MP = path.join(ROOT, 'miniprogram');

const problems = [];
const notes = [];

function fail(msg) {
  problems.push(msg);
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function exists(p) {
  return fs.existsSync(p);
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    fail(`JSON 解析失败：${rel(p)} — ${err.message}`);
    return null;
  }
}

/* 1. 页面四件套 */
const app = readJson(path.join(MP, 'app.json'));
if (!app) {
  console.error('app.json 不可用，终止');
  process.exit(1);
}
for (const page of app.pages || []) {
  for (const ext of ['js', 'json', 'wxml', 'wxss']) {
    const p = path.join(MP, `${page}.${ext}`);
    if (!exists(p)) fail(`页面缺文件：${page}.${ext}`);
  }
}
notes.push(`页面 ${app.pages.length} 个，四件套检查完成`);

/* 2. usingComponents 路径 */
function checkUsingComponents(jsonPath) {
  const json = readJson(jsonPath);
  if (!json || !json.usingComponents) return;
  const baseDir = path.dirname(jsonPath);
  for (const [name, target] of Object.entries(json.usingComponents)) {
    const resolved = path.resolve(baseDir, target);
    if (!exists(`${resolved}.wxml`) && !exists(path.join(resolved, 'index.wxml'))) {
      if (!exists(`${resolved}.js`)) fail(`组件路径不存在：${rel(jsonPath)} → ${name}: ${target}`);
    }
  }
}

checkUsingComponents(path.join(MP, 'app.json'));
for (const page of app.pages || []) checkUsingComponents(path.join(MP, `${page}.json`));
const compDir = path.join(MP, 'components');
if (exists(compDir)) {
  for (const name of fs.readdirSync(compDir)) {
    const p = path.join(compDir, name, `${name}.json`);
    if (exists(p)) checkUsingComponents(p);
  }
}
notes.push('usingComponents 路径检查完成');

/* 3. core 模块可加载 */
const coreDir = path.join(MP, 'core');
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const coreFiles = walk(coreDir);
for (const file of coreFiles) {
  try {
    require(file);
  } catch (err) {
    fail(`模块加载失败：${rel(file)} — ${err.message}`);
  }
}
notes.push(`core 模块 ${coreFiles.length} 个可加载`);

/* 4. 标准数据集完整性 */
try {
  const standards = require(path.join(coreDir, 'standards'));
  const records = standards.dataset.records || {};
  const keys = Object.keys(records);
  if (keys.length === 0) fail('标准数据集为空');
  for (const key of keys) {
    const rec = records[key];
    if (!rec.last_verified_at) fail(`标准 ${key} 缺少 last_verified_at`);
    if (!rec.official_source_url) fail(`标准 ${key} 缺少 official_source_url`);
    if (rec.verification_status === 'official_verified' && !rec.standard_number) fail(`标准 ${key} 缺少 standard_number`);
  }
  const verified = keys.filter((k) => records[k].verification_status === 'official_verified').length;
  notes.push(`标准数据集 ${keys.length} 条（已核验 ${verified} 条）`);
} catch (err) {
  fail(`标准数据集加载失败：${err.message}`);
}

/* 5. 小程序包里不能出现密钥 */
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{16,}/,
  /api[_-]?key\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i,
  /secret\s*[:=]\s*['"][A-Za-z0-9_\-]{12,}['"]/i,
  /Bearer\s+[A-Za-z0-9_\-\.]{20,}/
];
for (const file of walk(MP)) {
  const text = fs.readFileSync(file, 'utf8');
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) fail(`疑似密钥出现在小程序包：${rel(file)} 匹配 ${re}`);
  }
}
notes.push('小程序包密钥扫描完成');

/* 6. wx.request 只能在 services 里 */
for (const file of walk(MP)) {
  if (file.includes(`${path.sep}services${path.sep}`)) continue;
  const text = fs.readFileSync(file, 'utf8');
  if (/wx\.request\s*\(/.test(text)) fail(`wx.request 出现在 services/ 之外：${rel(file)}`);
}
notes.push('wx.request 位置约束检查完成');

/* 输出 */
console.log('— 工程自检 —');
for (const n of notes) console.log(`  ✓ ${n}`);
if (problems.length) {
  console.log(`\n发现 ${problems.length} 个问题：`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exit(1);
}
console.log('\n全部通过。注意：这只验证工程结构，真实编译与真机需在微信开发者工具中完成。');
