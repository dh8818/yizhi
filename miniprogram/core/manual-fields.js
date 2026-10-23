/**
 * 手填字段 → 标准字段记录（纯函数，小程序与服务端共用）。
 *
 * 关键点：手填的内容一律标 status=user_confirmed、source_type=user_input，
 * 绝不伪装成"图片识别"或"官方核验"。
 */

'use strict';

const { makeField, FIELD_STATUS, SOURCE_TYPE } = require('./fields');
const {
  normalizeStandardCode,
  normalizeFiberComposition,
  normalizeWeight,
  normalizeYarnCount,
  normalizePrice,
  normalizeSizeChart
} = require('./normalize');

function buildManualFields(manual) {
  const m = manual || {};
  const fields = {};

  const put = (key, value, extra) => {
    if (value == null || String(value).trim() === '') return;
    fields[key] = makeField(
      Object.assign(
        {
          field_key: key,
          normalized_value: value,
          raw_text: String(value),
          status: FIELD_STATUS.USER_CONFIRMED,
          source_type: SOURCE_TYPE.USER_INPUT,
          evidence_note: '你手动填写/确认的字段'
        },
        extra || {}
      )
    );
  };

  if (m.product_name) put('product_name', String(m.product_name).trim());
  if (m.brand) put('brand', String(m.brand).trim());
  if (m.category) put('category', String(m.category).trim());

  if (m.price) {
    const p = normalizePrice(m.price);
    if (p.value != null) put('price', p.value, { unit: '元', evidence_note: p.note || '你填写的价格' });
  }

  if (m.standard_code) {
    const n = normalizeStandardCode(m.standard_code);
    put('standard_code', n.code || String(m.standard_code).trim(), {
      status: n.valid ? FIELD_STATUS.USER_CONFIRMED : FIELD_STATUS.PENDING_VERIFICATION,
      evidence_note: n.note || '你填写的标准号（未经官方核验）'
    });
  }

  if (m.safety_category) {
    const level = String(m.safety_category).match(/([ABC])/);
    put('safety_category', level ? `${level[1]}类` : String(m.safety_category).trim());
  }

  if (m.fiber_composition) {
    const parsed = normalizeFiberComposition(m.fiber_composition);
    const field = makeField({
      field_key: 'fiber_composition',
      normalized_value: parsed.items.length
        ? parsed.items.map((i) => `${i.fiber} ${i.percent}%`).join(' / ')
        : String(m.fiber_composition).trim(),
      raw_text: String(m.fiber_composition),
      status: FIELD_STATUS.USER_CONFIRMED,
      source_type: SOURCE_TYPE.USER_INPUT,
      evidence_note: '你填写的纤维成分（标注值，非实测）'
    });
    if (parsed.items.length) field.parsed = { items: parsed.items, parts: parsed.parts, total: parsed.total };
    fields.fiber_composition = field;
  }

  if (m.fabric_weight) {
    const w = normalizeWeight(m.fabric_weight);
    if (w) {
      const key = w.kind === 'garment_weight' ? 'garment_weight' : 'fabric_weight';
      fields[key] = makeField({
        field_key: key,
        normalized_value: w.value,
        raw_text: String(m.fabric_weight),
        unit: w.unit,
        status: w.kind === 'ambiguous' ? FIELD_STATUS.PENDING_VERIFICATION : FIELD_STATUS.USER_CONFIRMED,
        source_type: SOURCE_TYPE.USER_INPUT,
        evidence_note: w.note
      });
    }
  }

  if (m.yarn_count) {
    const y = normalizeYarnCount(m.yarn_count);
    if (y) {
      fields.yarn_count = makeField({
        field_key: 'yarn_count',
        normalized_value: `${y.value}${y.system ? ' ' + y.system : ''}`,
        raw_text: String(m.yarn_count),
        status: y.system ? FIELD_STATUS.USER_CONFIRMED : FIELD_STATUS.PENDING_VERIFICATION,
        source_type: SOURCE_TYPE.USER_INPUT,
        evidence_note: y.note
      });
    }
  }

  if (m.size_chart) {
    const chart = normalizeSizeChart(m.size_chart);
    fields.size_chart = makeField({
      field_key: 'size_chart',
      normalized_value: chart.sizes,
      raw_text: String(m.size_chart),
      status: chart.sizes.length ? FIELD_STATUS.USER_CONFIRMED : FIELD_STATUS.PENDING_VERIFICATION,
      source_type: SOURCE_TYPE.USER_INPUT,
      evidence_note: chart.notes.length ? chart.notes.join('；') : '你填写的尺码表'
    });
  }

  if (m.size_range) put('size_range', String(m.size_range).trim());
  if (m.fit_description) put('fit_description', String(m.fit_description).trim());
  if (m.care_instructions) put('care_instructions', String(m.care_instructions).trim());
  if (m.weave_structure) put('weave_structure', String(m.weave_structure).trim());
  if (m.elasticity) put('elasticity', String(m.elasticity).trim());
  if (m.garment_weight) {
    const w = normalizeWeight(m.garment_weight);
    if (w) {
      fields.garment_weight = makeField({
        field_key: 'garment_weight',
        normalized_value: w.value,
        raw_text: String(m.garment_weight),
        unit: 'g',
        status: FIELD_STATUS.USER_CONFIRMED,
        source_type: SOURCE_TYPE.USER_INPUT,
        evidence_note: '你填写的单件重量（g），与面料克重(g/m²)不是同一口径'
      });
    }
  }

  return fields;
}

module.exports = { buildManualFields };
