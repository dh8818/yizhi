/**
 * 分析编排：把"图片 / 演示商品 / 手填字段"变成一张分析卡。
 *
 * 两条路径，绝不混淆：
 *   local  → 全部在本机完成（规则引擎 + 本地标准核验库 + 演示 OCR / 手填字段）
 *   remote → 图片传给后端，由后端做 OCR/模型，再返回同一个结构的报告
 *
 * 本地模式下**没有**真实 OCR：如果用户选了图片但既不用演示商品也没手填，
 * 必须诚实提示"本地不做 OCR"，而不是伪造识别结果。
 */

'use strict';

const { getSettings } = require('../config');
const pipeline = require('../core/pipeline');
const { findDemo } = require('../core/data/demo.products');
const { buildManualFields } = require('../core/manual-fields');
const api = require('./api');
const storage = require('./storage');

/**
 * 本地分析。
 * @param {{images?:Array, demoId?:string, manual?:object, profile?:object, corrections?:object}} input
 */
function analyzeLocal(input) {
  const demo = input.demoId ? findDemo(input.demoId) : null;
  if (input.demoId && !demo) {
    return { ok: false, error: { code: 'DEMO_NOT_FOUND', message: '示例商品不存在' } };
  }
  const manualFields = buildManualFields(input.manual);
  const hasManual = Object.keys(manualFields).length > 0;

  if (!demo && !hasManual) {
    return {
      ok: false,
      error: {
        code: 'LOCAL_NO_OCR',
        message: '本地演示模式不能识别图片文字。请选择示例商品体验完整流程，或在下方手动填写关键参数后再分析。',
        retryable: false,
        detail: 'local 模式没有 OCR/模型服务；接后端后（设置页切到 remote）才能对真实截图做识别。'
      }
    };
  }

  const ocr = demo ? { images: demo.images } : { images: [] };
  const meta = {
    mode: 'local',
    demo: Boolean(demo),
    images: (input.images || []).map((i) => ({ id: i.id, kind: i.kind, preview: i.path })),
    analysis_id: `local-${Date.now()}`,
    created_at: new Date().toISOString()
  };

  const result = pipeline.analyze({
    ocr,
    profile: input.profile || null,
    meta,
    manualFields: hasManual ? manualFields : null,
    corrections: input.corrections || null
  });

  result.report.demo_label = demo ? `演示数据：${demo.label}` : hasManual ? '手动填写模式（无 OCR 结果）' : null;
  return { ok: true, fields: result.fields, report: result.report, notes: result.notes, demo_product: demo ? { id: demo.id, label: demo.label, summary: demo.summary } : null };
}

/**
 * 远程分析：图片 + 手填字段交给后端。
 */
async function analyzeRemote(input) {
  const settings = getSettings();
  if (!settings.apiBase) {
    return { ok: false, error: { code: 'NO_API', message: '未配置后端地址，请到设置页填写' } };
  }
  const images = [];
  for (const img of input.images || []) {
    const read = await require('./upload').readAsBase64(img.path);
    if (!read.ok) return { ok: false, error: read.error };
    images.push({ id: img.id, kind: img.kind || 'promo_screenshot', base64: read.base64 });
  }
  const res = await api.createAnalysis({
    images: input.demoId ? [] : images,
    demo_id: input.demoId || null,
    manual: input.manual || null,
    profile: input.profile || null
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, fields: res.data.fields, report: res.data.report, notes: res.data.notes || [] };
}

/**
 * 统一入口：根据设置选择 local/remote，并保存历史。
 */
async function run(input) {
  const settings = getSettings();
  const runner = settings.mode === 'remote' ? analyzeRemote : analyzeLocal;
  const result = await runner(input);
  if (result.ok && result.report) {
    const saved = storage.saveHistory(result.report, {
      images: (input.images || []).map((i) => ({ id: i.id, kind: i.kind, preview: i.path })),
      fields: result.fields
    });
    result.report.analysis_id = saved.id;
    result.history_id = saved.id;
  }
  return result;
}

/** 修正字段：本地重算整张卡片（remote 模式先提交到后端，接口不同） */
function applyCorrectionLocal({ fields, fieldKey, value, profile, images }) {
  const manual = { [fieldKey]: value };
  const manualFields = buildManualFields(manual);
  const { mergeFieldSets, applyUserCorrection } = require('../core/evidence');
  // 有些字段（如 garment_weight/elasticity）不在手填表单里，但用户仍可能点"手动修正"：
  // 这时退回到通用修正，保证任何一次修正都不会静默失效。
  const merged = manualFields[fieldKey]
    ? mergeFieldSets(fields, manualFields)
    : Object.assign({}, fields, {
        [fieldKey]: applyUserCorrection(fields[fieldKey] || { field_key: fieldKey, status: 'missing' }, {
          normalized_value: value,
          note: '你手动修正的字段'
        })
      });
  const report = require('../core/report').buildReport({
    fields: merged,
    profile,
    rawText: '',
    meta: { mode: 'local', demo: false, images: images || [], analysis_id: fields.__analysis_id || `local-${Date.now()}` }
  });
  return { fields: merged, report };
}

module.exports = { buildManualFields, analyzeLocal, analyzeRemote, run, applyCorrectionLocal };
