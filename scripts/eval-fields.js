#!/usr/bin/env node
/**
 * 字段级评测：拿演示商品当"标注集"，统计逐字段命中情况。
 *
 * 诚实的边界：
 * - 只有 3 个样例，且都来自本仓库自己构造的模拟 OCR 文本，**不能代表真实截图的表现**；
 * - 它的作用是"验证提取规则没有漂移"，而不是宣称准确率。
 */

'use strict';

const { analyze } = require('../miniprogram/core/pipeline');
const { findDemo } = require('../miniprogram/core/data/demo.products');

const EXPECTED = {
  'demo-tshirt': {
    category: 'T恤',
    standard_code: 'GB/T 22849-2024',
    fabric_weight: 190,
    price: 89,
    size_chart_rows: 4,
    safety_category: 'B类',
    care: true
  },
  'demo-coat': {
    category: '大衣',
    standard_code: 'GB/T 2665-2017',
    fabric_weight: null,
    price: 899,
    size_chart_rows: 0,
    safety_category: 'B类',
    care: true
  },
  'demo-jeans': {
    category: '牛仔裤',
    standard_code: 'GB/T 22700-2016',
    fabric_weight: 360,
    price: 259,
    size_chart_rows: 0,
    safety_category: 'B类',
    care: true
  }
};

function valueOf(field) {
  if (!field) return null;
  if (field.status === 'missing' || field.status === 'unreadable' || field.status === 'conflict') return null;
  return field.normalized_value == null ? null : field.normalized_value;
}

function rowsOf(field) {
  if (!field || !Array.isArray(field.normalized_value)) return 0;
  return field.normalized_value.length;
}

const perField = {};
let hits = 0;
let total = 0;

for (const [id, expected] of Object.entries(EXPECTED)) {
  const demo = findDemo(id);
  const { fields } = analyze({ ocr: { images: demo.images }, meta: { mode: 'local' } });

  const checks = {
    category: valueOf(fields.category) === expected.category,
    standard_code: valueOf(fields.standard_code) === expected.standard_code,
    fabric_weight: valueOf(fields.fabric_weight) === expected.fabric_weight,
    price: valueOf(fields.price) === expected.price,
    size_chart_rows: rowsOf(fields.size_chart) === expected.size_chart_rows,
    safety_category: valueOf(fields.safety_category) === expected.safety_category,
    care_present: Boolean(valueOf(fields.care_instructions)) === expected.care
  };

  for (const [k, ok] of Object.entries(checks)) {
    perField[k] = perField[k] || { hit: 0, total: 0 };
    perField[k].total += 1;
    if (ok) perField[k].hit += 1;
    total += 1;
    if (ok) hits += 1;
  }

  console.log(`\n${id}  (${demo.label})`);
  for (const [k, ok] of Object.entries(checks)) {
    console.log(`  ${ok ? '✓' : '✗'} ${k}`);
  }
}

console.log('\n— 逐字段命中 —');
for (const [k, v] of Object.entries(perField)) {
  console.log(`  ${k.padEnd(18)} ${v.hit}/${v.total}`);
}
console.log(`\n总计 ${hits}/${total}（样例 n=3，均为模拟 OCR 文本，不代表真实截图准确率）`);
