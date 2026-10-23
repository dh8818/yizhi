/**
 * 字段与状态字典 —— 全项目的唯一真源。
 *
 * 设计约束（对应产品规范 5.1）：
 * 1. 每个字段都必须落成结构化记录，禁止只产出一段自然语言；
 * 2. 状态是"证据状态"，不是"质量评价"；
 * 3. 置信度只是模型自评，不能当真实概率用（见 CONFIDENCE_NOTE）。
 */

'use strict';

/** 字段状态。缺省一律 missing，绝不留空字符串。 */
const FIELD_STATUS = Object.freeze({
  EXTRACTED: 'extracted', // 从图片识别得到
  USER_CONFIRMED: 'user_confirmed', // 用户确认或修正
  OFFICIAL_VERIFIED: 'official_verified', // 通过官方资料核验
  INFERRED: 'inferred', // 模型/规则推断
  MISSING: 'missing', // 当前材料未提供
  UNREADABLE: 'unreadable', // 图片中无法辨识
  CONFLICT: 'conflict', // 多来源冲突
  PENDING_VERIFICATION: 'pending_verification' // 需要进一步核实
});

/** 来源类型。证据效力排序见 SOURCE_RANK。 */
const SOURCE_TYPE = Object.freeze({
  PROMO_SCREENSHOT: 'promo_screenshot', // 商品宣传详情页截图
  PHYSICAL_LABEL: 'physical_label', // 实物吊牌 / 水洗标 / 检测报告照片
  SIZE_CHART: 'size_chart', // 尺码表截图
  DETAIL_PHOTO: 'detail_photo', // 实物或细节照片
  USER_INPUT: 'user_input', // 用户自己填写/修正
  OFFICIAL_LOOKUP: 'official_lookup', // 官方标准平台查询结果
  MODEL_INFERENCE: 'model_inference', // 模型推断
  NOT_PROVIDED: 'not_provided' // 未提供
});

/**
 * 来源证据效力（仅用于冲突时的展示排序与提示，不用于"判定真伪"）。
 * 实物标签 > 官方查询 > 尺码表 > 商品宣传页 > 模型推断。
 * 说明：宣传页是商家自述，实物标签是法定标识，二者效力不同，但都不等于检测结论。
 */
const SOURCE_RANK = Object.freeze({
  [SOURCE_TYPE.PHYSICAL_LABEL]: 40,
  [SOURCE_TYPE.OFFICIAL_LOOKUP]: 35,
  [SOURCE_TYPE.USER_INPUT]: 30,
  [SOURCE_TYPE.SIZE_CHART]: 25,
  [SOURCE_TYPE.PROMO_SCREENSHOT]: 20,
  [SOURCE_TYPE.DETAIL_PHOTO]: 15,
  [SOURCE_TYPE.MODEL_INFERENCE]: 5,
  [SOURCE_TYPE.NOT_PROVIDED]: 0
});

const STATUS_META = Object.freeze({
  [FIELD_STATUS.EXTRACTED]: { label: '已识别', tone: 'info', hint: '由图片识别得到，建议对照原图复核' },
  [FIELD_STATUS.USER_CONFIRMED]: { label: '已确认', tone: 'ok', hint: '你已确认或修正过该字段' },
  [FIELD_STATUS.OFFICIAL_VERIFIED]: { label: '已核验', tone: 'ok', hint: '已通过官方资料查询确认' },
  [FIELD_STATUS.INFERRED]: { label: '推断', tone: 'warn', hint: '由规则或模型推断，不是原文' },
  [FIELD_STATUS.MISSING]: { label: '未提供', tone: 'muted', hint: '当前材料中没有这一项' },
  [FIELD_STATUS.UNREADABLE]: { label: '识别不清', tone: 'warn', hint: '图片中的文字无法可靠辨识' },
  [FIELD_STATUS.CONFLICT]: { label: '信息冲突', tone: 'alert', hint: '不同来源的说法不一致，已保留双方证据' },
  [FIELD_STATUS.PENDING_VERIFICATION]: { label: '待核实', tone: 'warn', hint: '存在需要进一步确认的点' }
});

const SOURCE_META = Object.freeze({
  [SOURCE_TYPE.PROMO_SCREENSHOT]: { label: '商品宣传截图', is_claim: true },
  [SOURCE_TYPE.PHYSICAL_LABEL]: { label: '实物标签照片', is_claim: true },
  [SOURCE_TYPE.SIZE_CHART]: { label: '尺码表', is_claim: true },
  [SOURCE_TYPE.DETAIL_PHOTO]: { label: '实物照片', is_claim: false },
  [SOURCE_TYPE.USER_INPUT]: { label: '你填写', is_claim: false },
  [SOURCE_TYPE.OFFICIAL_LOOKUP]: { label: '官方查询', is_claim: false },
  [SOURCE_TYPE.MODEL_INFERENCE]: { label: '模型推断', is_claim: false },
  [SOURCE_TYPE.NOT_PROVIDED]: { label: '未提供', is_claim: false }
});

/** 置信度的口径声明，任何面向用户的置信度展示都必须带上它。 */
const CONFIDENCE_NOTE =
  '置信度是模型对本次提取的自评值，不是"猜对的概率"。本项目未建立校准测试集，因此不提供准确率数字。';

/**
 * 字段定义表。
 * required: 是否属于"关键信息"（影响结论强度，而不是强制用户填写）
 * group: 用于分析卡分组
 */
const FIELD_DEFS = Object.freeze([
  { key: 'product_name', name: '商品名称', group: 'basic', unit: null, required: false },
  { key: 'brand', name: '品牌', group: 'basic', unit: null, required: false },
  { key: 'category', name: '品类', group: 'basic', unit: null, required: true },
  { key: 'price', name: '价格', group: 'commerce', unit: '元', required: false },
  { key: 'fiber_composition', name: '纤维成分', group: 'fabric', unit: '%', required: true },
  { key: 'fabric_weight', name: '面料克重', group: 'fabric', unit: 'g/m²', required: false },
  { key: 'garment_weight', name: '成衣重量', group: 'fabric', unit: 'g', required: false },
  { key: 'yarn_count', name: '纱线支数', group: 'fabric', unit: null, required: false },
  { key: 'weave_structure', name: '织物组织/工艺', group: 'fabric', unit: null, required: false },
  { key: 'elasticity', name: '弹性', group: 'fabric', unit: null, required: false },
  { key: 'fit_description', name: '版型描述', group: 'size', unit: null, required: false },
  { key: 'size_range', name: '尺码范围', group: 'size', unit: null, required: false },
  { key: 'size_chart', name: '尺码表', group: 'size', unit: 'cm', required: true },
  { key: 'standard_code', name: '执行标准号', group: 'standard', unit: null, required: true },
  { key: 'safety_category', name: '产品安全类别', group: 'standard', unit: null, required: false },
  { key: 'care_instructions', name: '洗护信息', group: 'care', unit: null, required: false },
  { key: 'test_report', name: '检测报告/证书', group: 'standard', unit: null, required: false }
]);

const FIELD_DEF_MAP = FIELD_DEFS.reduce((acc, d) => {
  acc[d.key] = d;
  return acc;
}, {});

const GROUP_LABELS = Object.freeze({
  basic: '基本信息',
  commerce: '价格',
  fabric: '面料与工艺',
  size: '版型与尺码',
  standard: '标准与标识',
  care: '洗护'
});

/** 关键字段（缺失会直接降低结论强度） */
const KEY_FIELDS = FIELD_DEFS.filter((d) => d.required).map((d) => d.key);

function fieldDef(key) {
  return FIELD_DEF_MAP[key] || { key, name: key, group: 'basic', unit: null, required: false };
}

/**
 * 构造一条字段证据记录（对应规范 5.1 的全部字段）。
 * @param {object} input
 * @returns {object} 规范化的字段记录
 */
function makeField(input) {
  const def = fieldDef(input.field_key);
  const status = input.status || FIELD_STATUS.MISSING;
  const sourceType = input.source_type || SOURCE_TYPE.NOT_PROVIDED;
  return {
    field_key: input.field_key,
    field_name: input.field_name || def.name,
    group: input.group || def.group,
    raw_text: input.raw_text == null ? null : String(input.raw_text),
    normalized_value: input.normalized_value == null ? null : input.normalized_value,
    unit: input.unit === undefined ? def.unit : input.unit,
    status,
    source_type: sourceType,
    source_image_id: input.source_image_id || null,
    source_location: input.source_location || null,
    confidence: typeof input.confidence === 'number' ? clamp01(input.confidence) : null,
    evidence_note: input.evidence_note || (STATUS_META[status] ? STATUS_META[status].hint : null),
    alternatives: Array.isArray(input.alternatives) ? input.alternatives : [],
    updated_at: input.updated_at || new Date().toISOString()
  };
}

function clamp01(n) {
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

/** 是否为"有内容"的字段（可展示 normalized_value） */
function hasValue(field) {
  if (!field) return false;
  if (field.status === FIELD_STATUS.MISSING || field.status === FIELD_STATUS.UNREADABLE) return false;
  if (field.status === FIELD_STATUS.CONFLICT) {
    return Array.isArray(field.alternatives) && field.alternatives.length > 0;
  }
  const v = field.normalized_value;
  if (v == null) return false;
  if (typeof v === 'string' && v.trim() === '') return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

module.exports = {
  FIELD_STATUS,
  SOURCE_TYPE,
  SOURCE_RANK,
  STATUS_META,
  SOURCE_META,
  CONFIDENCE_NOTE,
  FIELD_DEFS,
  FIELD_DEF_MAP,
  GROUP_LABELS,
  KEY_FIELDS,
  fieldDef,
  makeField,
  hasValue
};
