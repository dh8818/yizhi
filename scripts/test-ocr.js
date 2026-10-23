#!/usr/bin/env node
/**
 * OCR 单图调试工具：不经过小程序、不启动服务，直接验证"这张图能不能读出来"。
 *
 * 用法：
 *   node scripts/test-ocr.js <图片路径> [--kind promo_screenshot|physical_label|size_chart|detail_photo]
 *   node scripts/test-ocr.js --probe            # 只探测 provider 是否就绪
 *   node scripts/test-ocr.js <图片> --json      # 输出完整 OCR JSON（调试用）
 *
 * 输出三段：① provider 与耗时 ② 读到的文本块 ③ 下游提取出的字段与分析卡结论。
 * 这样能把"OCR 读错了"和"规则判错了"分开定位。
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch (err) {
    /* .env 可选 */
  }
}

loadDotEnv(path.join(__dirname, '..', '.env'));

const CORE = path.join(__dirname, '..', 'miniprogram', 'core');
const providers = require(path.join(CORE, 'ai', 'providers'));
const { extractFromOcr } = require(path.join(CORE, 'extractor'));
const { analyze } = require(path.join(CORE, 'pipeline'));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const hasFlag = (name) => process.argv.indexOf(name) >= 0;

async function main() {
  const cfg = providers.resolveConfig(process.env);
  console.log('— OCR 配置 —');
  console.log(`  provider : ${cfg.provider}${cfg.configured ? '' : '（未配置，将降级为 mock）'}`);
  if (cfg.provider === 'ollama') console.log(`  ollama   : ${cfg.ollama.host} / ${cfg.ollama.model}`);
  if (cfg.provider === 'openai_compat') console.log(`  vision   : ${cfg.openai.model} @ ${cfg.openai.baseUrl}`);
  if (cfg.provider === 'baidu_ocr') console.log('  baidu    : accurate_basic（已配置密钥）');
  console.log(`  timeout  : ${cfg.timeoutMs}ms`);

  if (hasFlag('--probe')) {
    const p = await providers.probe(process.env);
    console.log('\n— 探活 —');
    console.log(`  ok=${p.ok} · ${p.detail || ''}`);
    process.exit(p.ok ? 0 : 1);
  }

  const file = process.argv[2];
  if (!file || file.startsWith('--')) {
    console.error('\n用法：node scripts/test-ocr.js <图片路径> [--kind <类型>] [--json]');
    console.error('     node scripts/test-ocr.js --probe');
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.error(`\n图片不存在：${file}`);
    process.exit(2);
  }

  const buf = fs.readFileSync(file);
  const base64 = buf.toString('base64');
  const kind = arg('--kind', 'promo_screenshot');
  const images = [{ id: 'cli-image-1', kind, base64, mime: providers.sniffMime(base64) }];

  console.log(`\n— 调用 OCR —`);
  console.log(`  文件 : ${file}（${(buf.length / 1024).toFixed(1)}KB，${images[0].mime}）`);
  console.log(`  类型 : ${kind}`);

  const t0 = Date.now();
  const res = await providers.callOcr({ images, config: cfg });
  const ms = Date.now() - t0;

  if (!res.ok) {
    console.log(`\n✗ 失败（${ms}ms）：${res.error.code} — ${res.error.message}`);
    if (res.error.detail) console.log(`  detail: ${res.error.detail}`);
    process.exit(1);
  }

  console.log(`\n✓ ${res.provider} 返回 ${ms}ms`);
  if (hasFlag('--json')) console.log(JSON.stringify(res.ocr, null, 2));

  console.log('\n— 读到的文本块 —');
  for (const img of res.ocr.images) {
    console.log(`  [${img.id} / ${img.kind}] ${img.blocks.length} 块`);
    img.blocks.forEach((b, i) => {
      console.log(`   ${String(i + 1).padStart(2, '0')}. ${b.text}${b.confidence != null ? `   (conf ${b.confidence})` : ''}`);
    });
  }

  const { fields } = extractFromOcr({ images: res.ocr.images });
  console.log('\n— 提取出的字段 —');
  const interesting = ['category', 'product_name', 'standard_code', 'fiber_composition', 'fabric_weight', 'price', 'size_chart', 'safety_category', 'care_instructions'];
  for (const k of interesting) {
    const f = fields[k];
    if (!f) continue;
    const v = f.normalized_value;
    const shown = Array.isArray(v) ? `${v.length} 行` : v == null ? '—' : String(v).slice(0, 60);
    console.log(`  ${(f.field_name || k).padEnd(6, '　')} [${f.status}] ${shown}`);
  }

  const { report } = analyze({ ocr: res.ocr, meta: { mode: 'ocr', demo: false, images: [{ id: 'cli-image-1', kind }] } });
  console.log('\n— 分析卡结论 —');
  console.log(`  ${report.header.conclusion}`);
  console.log(`  完整度：${report.header.completeness.level_label}（${Math.round(report.header.completeness.ratio * 100)}%）` +
    ` · 疑点：重点${report.doubt_counts.attention}/确认${report.doubt_counts.verify}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
