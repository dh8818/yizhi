'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { extractFromOcr } = require('../miniprogram/core/extractor');
const { analyze } = require('../miniprogram/core/pipeline');
const { findDemo } = require('../miniprogram/core/data/demo.products');
const { FIELD_STATUS, SOURCE_TYPE } = require('../miniprogram/core/fields');

const tshirt = findDemo('demo-tshirt');
const coat = findDemo('demo-coat');
const jeans = findDemo('demo-jeans');

test('完整宣传页：关键字段都能提取', () => {
  const { fields } = extractFromOcr({ images: tshirt.images });
  assert.equal(fields.category.normalized_value, 'T恤');
  assert.equal(fields.standard_code.normalized_value, 'GB/T 22849-2024');
  assert.equal(fields.fiber_composition.normalized_value, '棉 100%');
  assert.equal(fields.fabric_weight.normalized_value, 190);
  assert.equal(fields.fabric_weight.unit, 'g/m²');
  assert.equal(fields.price.normalized_value, 89);
  assert.equal(fields.size_chart.status, FIELD_STATUS.EXTRACTED);
  assert.equal(fields.size_chart.normalized_value.length, 4);
  assert.equal(fields.care_instructions.status, FIELD_STATUS.EXTRACTED);
});

test('宣传页不会编造没出现的字段', () => {
  const { fields } = extractFromOcr({ images: tshirt.images });
  assert.equal(fields.weave_structure.status, FIELD_STATUS.MISSING);
  assert.equal(fields.weave_structure.normalized_value, null);
  assert.equal(fields.yarn_count.status, FIELD_STATUS.EXTRACTED); // 40S 出现在文本里
});

test('只有吊牌：商品名称不会被标签参数冒充', () => {
  const { fields } = extractFromOcr({ images: coat.images.filter((i) => i.kind === SOURCE_TYPE.PHYSICAL_LABEL) });
  assert.equal(fields.product_name.status, FIELD_STATUS.MISSING);
  assert.equal(fields.fiber_composition.status, FIELD_STATUS.EXTRACTED);
  assert.match(fields.fiber_composition.normalized_value, /羊毛 70%/);
});

test('图片类型决定来源标记：吊牌优先于宣传页', () => {
  const { fields } = extractFromOcr({ images: jeans.images });
  assert.equal(fields.fiber_composition.source_type, SOURCE_TYPE.PHYSICAL_LABEL);
  assert.equal(fields.standard_code.source_type, SOURCE_TYPE.PHYSICAL_LABEL);
});

test('两张图说法不一致时保留冲突，不静默择一', () => {
  const { fields } = analyze({ ocr: { images: jeans.images }, meta: { mode: 'local' } });
  assert.equal(fields.fiber_composition.status, FIELD_STATUS.CONFLICT);
  assert.ok(fields.fiber_composition.alternatives.length >= 2);
  const values = fields.fiber_composition.alternatives.map((a) => String(a.normalized_value)).join('|');
  assert.match(values, /98/);
  assert.match(values, /100/);
});

test('空 OCR：所有字段 missing，不产生臆造值', () => {
  const { fields, notes } = extractFromOcr({ images: [] });
  assert.match(notes.join(' '), /未返回任何文本/);
  const keys = Object.keys(fields);
  assert.ok(keys.length > 8);
  assert.equal(keys.every((k) => fields[k].status === FIELD_STATUS.MISSING), true);
});

test('非服装文本：能给出 missing 与低完整度，而不是硬猜品类', () => {
  const ocr = { images: [{ id: 'x', kind: 'promo_screenshot', blocks: [{ text: '今日天气晴，气温 18 到 25 度', confidence: 0.9 }] }] };
  const { report } = analyze({ ocr, meta: { mode: 'local' } });
  assert.equal(report.header.completeness.level, 'low');
  assert.equal(report.header.category, null);
  assert.equal(report.standard.appears_in_product, false);
});

test('手填字段优先于识别结果，并记录来源', () => {
  const { report, fields } = analyze({
    ocr: { images: tshirt.images },
    manualFields: require('../miniprogram/core/manual-fields').buildManualFields({ standard_code: 'GB 18401-2010' }),
    meta: { mode: 'local' }
  });
  assert.equal(fields.standard_code.status, FIELD_STATUS.USER_CONFIRMED);
  assert.equal(fields.standard_code.source_type, SOURCE_TYPE.USER_INPUT);
  assert.equal(report.standard.normalized_code, 'GB 18401-2010');
  const evidence = report.evidence.find((e) => e.field_key === 'standard_code');
  assert.equal(evidence.source_label, '你填写');
});
