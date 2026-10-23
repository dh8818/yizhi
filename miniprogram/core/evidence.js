/**
 * evidence-engine：多来源合并、冲突保留、用户修正留痕。
 *
 * 关键规则（规范 5.2 第 8、9 条）：
 * - 两张图冲突时，保留双方证据，不允许静默择一；
 * - 用户修正后，修正值成为 canonical，但原始证据必须保留在 alternatives 里。
 */

'use strict';

const { FIELD_STATUS, SOURCE_TYPE, SOURCE_RANK, makeField, hasValue } = require('./fields');

function rank(sourceType) {
  return SOURCE_RANK[sourceType] == null ? 0 : SOURCE_RANK[sourceType];
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 把 normalized_value 压成一个可比较的字符串 */
function fingerprint(field) {
  const v = field.normalized_value;
  if (v == null) return '';
  if (Array.isArray(v)) {
    return v
      .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
      .join('|')
      .replace(/\s+/g, '')
      .toLowerCase();
  }
  if (typeof v === 'object') return JSON.stringify(v).replace(/\s+/g, '').toLowerCase();
  return String(v).replace(/\s+/g, '').toLowerCase();
}

/** 两个值在业务上是否算"同一件事"（数字允许容差） */
function sameValue(a, b, fieldKey) {
  if (isNum(a) && isNum(b)) {
    const tolerance = fieldKey === 'price' ? 0.01 : fieldKey === 'fabric_weight' ? 0.05 : 0.001;
    const base = Math.max(Math.abs(a), Math.abs(b), 1);
    return Math.abs(a - b) / base <= tolerance;
  }
  const fa = fingerprint({ normalized_value: a });
  const fb = fingerprint({ normalized_value: b });
  if (!fa || !fb) return fa === fb;
  // 纤维成分允许顺序不同
  if (fieldKey === 'fiber_composition') {
    const norm = (s) => s.split(/[/、,，]|\|/).map((x) => x.trim()).filter(Boolean).sort().join('|');
    return norm(fa) === norm(fb);
  }
  return fa === fb;
}

/**
 * 合并同一字段的多个候选来源。
 * @param {string} fieldKey
 * @param {Array<object>} candidates 字段记录数组（来自不同图片/用户/官方）
 * @returns {object} 单个字段记录，冲突时 status=conflict 且 alternatives 含全部证据
 */
function mergeField(fieldKey, candidates) {
  const list = (candidates || []).filter(Boolean);
  if (!list.length) {
    return makeField({ field_key: fieldKey, status: FIELD_STATUS.MISSING, source_type: SOURCE_TYPE.NOT_PROVIDED });
  }

  // 用户确认优先级最高：用户说的话就是这个商品的"当前事实"，但保留历史证据
  const userConfirmed = list.filter((c) => c.status === FIELD_STATUS.USER_CONFIRMED && hasValue(c));
  const withValue = list.filter((c) => hasValue(c) && c.status !== FIELD_STATUS.USER_CONFIRMED);

  if (userConfirmed.length) {
    const canonical = userConfirmed[userConfirmed.length - 1];
    const others = list.filter((c) => c !== canonical && hasValue(c));
    return {
      ...canonical,
      alternatives: [
        ...(canonical.alternatives || []),
        ...others.map((c) => ({
          normalized_value: c.normalized_value,
          raw_text: c.raw_text,
          source_type: c.source_type,
          source_image_id: c.source_image_id,
          status: c.status
        }))
      ],
      evidence_note: others.length
        ? `已按你的修正记录；原始识别结果保留在来源里（${others.length} 条）`
        : canonical.evidence_note
    };
  }

  if (!withValue.length) {
    // 全是 missing/unreadable：优先报"识别不清"，因为它更有行动价值
    const unreadable = list.find((c) => c.status === FIELD_STATUS.UNREADABLE);
    const base = unreadable || list[0];
    return { ...base, alternatives: [] };
  }

  // 按来源效力排序
  const sorted = withValue.slice().sort((a, b) => rank(b.source_type) - rank(a.source_type));
  const best = sorted[0];
  const conflicting = sorted.filter((c) => !sameValue(c.normalized_value, best.normalized_value, fieldKey));

  if (conflicting.length) {
    return {
      ...best,
      status: FIELD_STATUS.CONFLICT,
      alternatives: sorted.map((c) => ({
        normalized_value: c.normalized_value,
        raw_text: c.raw_text,
        source_type: c.source_type,
        source_image_id: c.source_image_id,
        status: c.status,
        evidence_note: c.evidence_note
      })),
      evidence_note:
        `不同来源对「${best.field_name || fieldKey}」的说法不一致：` +
        sorted
          .map((c) => `${sourceLabel(c.source_type)}为 ${displayValue(c)}`)
          .join('；') +
        '。两侧证据都已保留，建议以实物标签为准并让商家确认'
    };
  }

  // 一致：合并证据数量，最高效力者为准
  const merged = { ...best };
  const supporting = sorted.filter((c) => c !== best);
  if (supporting.length) {
    merged.alternatives = supporting.map((c) => ({
      normalized_value: c.normalized_value,
      raw_text: c.raw_text,
      source_type: c.source_type,
      source_image_id: c.source_image_id,
      status: c.status
    }));
    merged.evidence_note = `${best.evidence_note || ''}${best.evidence_note ? '；' : ''}另有 ${supporting.length} 处来源与之一致`;
  }
  return merged;
}

function sourceLabel(sourceType) {
  const { SOURCE_META } = require('./fields');
  return (SOURCE_META[sourceType] || { label: sourceType }).label;
}

function displayValue(field) {
  const v = field.normalized_value;
  if (v == null) return '（空）';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : x && x.size ? x.size : JSON.stringify(x))).join('、');
  if (typeof v === 'object') return JSON.stringify(v);
  return `${v}${field.unit && field.unit !== '%' ? ' ' + field.unit : ''}`;
}

/**
 * 合并两组字段集合（例如：先宣传页提取，再补充标签页提取）。
 * @param {Object<string, object>} base
 * @param {Object<string, object>} extra
 * @returns {Object<string, object>}
 */
function mergeFieldSets(base, extra) {
  const keys = new Set([...Object.keys(base || {}), ...Object.keys(extra || {})]);
  const out = {};
  for (const key of keys) {
    const a = base ? base[key] : null;
    const b = extra ? extra[key] : null;
    if (a && b) out[key] = mergeField(key, [a, b]);
    else out[key] = a || b;
  }
  return out;
}

/**
 * 用户修正字段。保留原值与来源，修正值标记 user_confirmed。
 * @param {object} field 原字段
 * @param {object} patch { normalized_value, unit?, raw_text? }
 */
function applyUserCorrection(field, patch) {
  const prev = field || {};
  const original = {
    normalized_value: prev.normalized_value,
    raw_text: prev.raw_text,
    source_type: prev.source_type,
    source_image_id: prev.source_image_id,
    status: prev.status
  };
  const alternatives = (prev.alternatives || []).slice();
  if (prev.normalized_value != null) alternatives.unshift(original);
  return makeField({
    field_key: prev.field_key,
    normalized_value: patch.normalized_value,
    raw_text: patch.raw_text != null ? patch.raw_text : prev.raw_text,
    unit: patch.unit !== undefined ? patch.unit : prev.unit,
    status: FIELD_STATUS.USER_CONFIRMED,
    source_type: SOURCE_TYPE.USER_INPUT,
    confidence: null,
    evidence_note: patch.note || '你手动确认/修正过该字段',
    alternatives,
    updated_at: new Date().toISOString()
  });
}

module.exports = { mergeField, mergeFieldSets, applyUserCorrection, sameValue, rank, sourceLabel, displayValue };
