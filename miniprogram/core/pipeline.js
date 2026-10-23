/**
 * pipeline：把 OCR → 提取 → 证据合并 → 规则/报告 串成一条**纯函数**流水线。
 *
 * 小程序（local 模式）和 Node 服务端都调用这里，保证两端结果一致。
 * 任何 IO（上传、存储、网络）都不在这一层。
 */

'use strict';

const { extractFromOcr } = require('./extractor');
const { mergeFieldSets, applyUserCorrection } = require('./evidence');
const { buildReport } = require('./report');
const { FIELD_STATUS, SOURCE_TYPE, makeField } = require('./fields');

/**
 * 单次分析：一张或多张图片的 OCR 结果 → 分析卡数据。
 *
 * @param {object} input
 * @param {{images: Array<object>}} input.ocr
 * @param {object} [input.profile]
 * @param {object} [input.meta] { mode, demo, images, analysis_id, created_at }
 * @param {object} [input.corrections] 用户修正 { field_key: {normalized_value, unit?, note?} }
 * @param {object} [input.manualFields] 手填字段（makeField 结构，status=user_confirmed）
 */
function analyze(input) {
  const ocr = (input && input.ocr) || { images: [] };
  const images = ocr.images || [];

  // 按图片类型分别提取后合并：宣传页 / 标签页 / 尺码表 的证据效力不同，
  // 先各自提取再 merge，才能保留"同一字段不同来源"的冲突信息。
  const groups = {};
  for (const img of images) {
    const kind = img.kind || SOURCE_TYPE.PROMO_SCREENSHOT;
    groups[kind] = groups[kind] || [];
    groups[kind].push(img);
  }

  let fields = {};
  const notes = [];
  for (const [kind, imgs] of Object.entries(groups)) {
    const extracted = extractFromOcr({ images: imgs });
    fields = mergeFieldSets(fields, extracted.fields);
    notes.push(...extracted.notes.map((n) => `[${kind}] ${n}`));
  }

  // 用户手填字段：user_confirmed 优先，历史识别值保留在 alternatives
  if (input && input.manualFields) {
    fields = mergeFieldSets(fields, input.manualFields);
  }

  // 用户修正：优先级最高，但历史值保留
  const corrections = (input && input.corrections) || {};
  for (const [key, patch] of Object.entries(corrections)) {
    if (!patch) continue;
    fields[key] = applyUserCorrection(fields[key] || makeField({ field_key: key }), patch);
  }

  const rawText = images
    .reduce((acc, img) => acc.concat((img.blocks || []).map((b) => b.text)), [])
    .join('\n');

  const report = buildReport({
    fields,
    profile: input && input.profile,
    rawText,
    meta: (input && input.meta) || {}
  });

  return { fields, report, notes };
}

/**
 * 只做提取，不生成报告（用于「补充图片」后增量展示）。
 */
function extractOnly(ocr) {
  const images = (ocr && ocr.images) || [];
  let fields = {};
  for (const img of images) {
    const one = extractFromOcr({ images: [img] });
    fields = mergeFieldSets(fields, one.fields);
  }
  return fields;
}

/** 空字段集（用于纯手填流程） */
function emptyFields() {
  const keys = [
    'product_name', 'brand', 'category', 'price', 'fiber_composition', 'fabric_weight', 'garment_weight',
    'yarn_count', 'weave_structure', 'elasticity', 'fit_description', 'size_range', 'size_chart',
    'standard_code', 'safety_category', 'care_instructions', 'test_report'
  ];
  const out = {};
  for (const k of keys) {
    out[k] = makeField({ field_key: k, status: FIELD_STATUS.MISSING, source_type: SOURCE_TYPE.NOT_PROVIDED });
  }
  return out;
}

module.exports = { analyze, extractOnly, emptyFields };
