/**
 * 结构校验：模型输出必须过这一关才能进入业务层。
 *
 * 为什么不用 ajv 之类的库：
 * 小程序包里每多一个依赖都要占体积，而这里只需要"拒绝明显不合规的输出"，
 * 不需要完整的 JSON Schema 实现。规则写死在这里，反而更容易审阅。
 */

'use strict';

const { FIELD_STATUS, SOURCE_TYPE } = require('./fields');

const VALID_STATUS = new Set(Object.values(FIELD_STATUS));
const VALID_SOURCE = new Set(Object.values(SOURCE_TYPE));

const KINDS = new Set([SOURCE_TYPE.PROMO_SCREENSHOT, SOURCE_TYPE.PHYSICAL_LABEL, SOURCE_TYPE.SIZE_CHART, SOURCE_TYPE.DETAIL_PHOTO]);

/**
 * 校验 OCR/视觉适配器的输出。
 * @param {any} payload
 * @returns {{ok:boolean, errors:Array<{path:string,message:string}>, sanitized:object|null}}
 */
function validateOcrPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object') {
    return { ok: false, errors: [{ path: '$', message: '不是对象' }], sanitized: null };
  }
  const images = Array.isArray(payload.images) ? payload.images : null;
  if (!images) return { ok: false, errors: [{ path: '$.images', message: '缺少 images 数组' }], sanitized: null };
  if (images.length === 0) errors.push({ path: '$.images', message: 'images 为空' });
  if (images.length > 9) errors.push({ path: '$.images', message: '图片数量超过 9 张' });

  const sanitized = { images: [] };
  images.forEach((img, i) => {
    const at = `$.images[${i}]`;
    if (!img || typeof img !== 'object') {
      errors.push({ path: at, message: '不是对象' });
      return;
    }
    const kind = img.kind || SOURCE_TYPE.PROMO_SCREENSHOT;
    if (!KINDS.has(kind)) errors.push({ path: `${at}.kind`, message: `未知图片来源类型：${kind}` });
    const blocks = Array.isArray(img.blocks) ? img.blocks : null;
    if (!blocks) {
      errors.push({ path: `${at}.blocks`, message: '缺少 blocks 数组' });
      return;
    }
    const cleanBlocks = [];
    blocks.forEach((b, j) => {
      const bat = `${at}.blocks[${j}]`;
      if (!b || typeof b !== 'object') {
        errors.push({ path: bat, message: '不是对象' });
        return;
      }
      if (typeof b.text !== 'string' || !b.text.trim()) {
        errors.push({ path: `${bat}.text`, message: 'text 必须是非空字符串' });
        return;
      }
      const conf = typeof b.confidence === 'number' ? Math.min(1, Math.max(0, b.confidence)) : null;
      cleanBlocks.push({
        text: b.text.slice(0, 2000),
        confidence: conf,
        box: Array.isArray(b.box) && b.box.length === 4 && b.box.every((n) => typeof n === 'number') ? b.box : null
      });
    });
    sanitized.images.push({
      id: typeof img.id === 'string' && img.id ? img.id : `img-${i + 1}`,
      kind: KINDS.has(kind) ? kind : SOURCE_TYPE.PROMO_SCREENSHOT,
      blocks: cleanBlocks
    });
  });

  return { ok: errors.length === 0, errors, sanitized: errors.length ? sanitized : sanitized };
}

/** 校验模型返回的"字段 JSON"（可选路径：模型直接输出结构化字段而不是 OCR 文本） */
function validateFieldPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.fields)) {
    return { ok: false, errors: [{ path: '$.fields', message: '需要 fields 数组' }], sanitized: null };
  }
  const fields = [];
  payload.fields.forEach((f, i) => {
    const at = `$.fields[${i}]`;
    if (!f || typeof f.field_key !== 'string') {
      errors.push({ path: at, message: 'field_key 缺失' });
      return;
    }
    if (f.status && !VALID_STATUS.has(f.status)) errors.push({ path: `${at}.status`, message: `未知状态 ${f.status}` });
    if (f.source_type && !VALID_SOURCE.has(f.source_type)) errors.push({ path: `${at}.source_type`, message: `未知来源 ${f.source_type}` });
    fields.push({
      field_key: f.field_key,
      raw_text: typeof f.raw_text === 'string' ? f.raw_text : null,
      normalized_value: f.normalized_value === undefined ? null : f.normalized_value,
      unit: typeof f.unit === 'string' ? f.unit : null,
      status: VALID_STATUS.has(f.status) ? f.status : FIELD_STATUS.EXTRACTED,
      source_type: VALID_SOURCE.has(f.source_type) ? f.source_type : SOURCE_TYPE.PROMO_SCREENSHOT,
      source_image_id: typeof f.source_image_id === 'string' ? f.source_image_id : null,
      confidence: typeof f.confidence === 'number' ? Math.min(1, Math.max(0, f.confidence)) : null,
      evidence_note: typeof f.evidence_note === 'string' ? f.evidence_note.slice(0, 500) : null
    });
  });
  return { ok: errors.length === 0, errors, sanitized: { fields } };
}

/** 校验分析卡是否包含必需结构（服务端返回给小程序前的最后一道关） */
function validateReport(report) {
  const errors = [];
  if (!report || typeof report !== 'object') return { ok: false, errors: [{ path: '$', message: '不是对象' }] };
  if (!report.header || typeof report.header.conclusion !== 'string') errors.push({ path: '$.header.conclusion', message: '缺少一句话结论' });
  if (!Array.isArray(report.sections)) errors.push({ path: '$.sections', message: '缺少 sections' });
  if (!Array.isArray(report.doubts)) errors.push({ path: '$.doubts', message: '缺少 doubts' });
  if (!Array.isArray(report.limits) || report.limits.length === 0) errors.push({ path: '$.limits', message: '缺少边界说明' });
  if (!report.disclaimer) errors.push({ path: '$.disclaimer', message: '缺少免责声明' });
  if (report.standard && report.standard.compliance !== 'not_assessed') {
    errors.push({ path: '$.standard.compliance', message: '不允许输出符合性结论' });
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { validateOcrPayload, validateFieldPayload, validateReport };
