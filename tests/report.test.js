'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { analyze } = require('../miniprogram/core/pipeline');
const { findDemo, DEMO_PROFILE } = require('../miniprogram/core/data/demo.products');
const { validateReport } = require('../miniprogram/core/schema');
const { buildComparison } = require('../miniprogram/core/compare');

function reportOf(id, profile, demo) {
  const p = findDemo(id);
  return analyze({
    ocr: { images: p.images },
    profile: profile === undefined ? DEMO_PROFILE : profile,
    meta: { mode: 'local', demo: Boolean(demo), images: p.images, created_at: '2026-10-20T10:00:00.000Z' }
  }).report;
}

test('三张演示卡都通过结构校验（含免责声明与边界）', () => {
  for (const id of ['demo-tshirt', 'demo-coat', 'demo-jeans']) {
    const report = reportOf(id, DEMO_PROFILE, false);
    const check = validateReport(report);
    assert.equal(check.ok, true, `${id}: ${JSON.stringify(check.errors)}`);
  }
});

test('分析卡固定包含 7 个区块，且带证据清单', () => {
  const report = reportOf('demo-tshirt', DEMO_PROFILE, false);
  const keys = report.sections.map((s) => s.key);
  assert.deepEqual(keys, ['basic', 'standard', 'fabric', 'fit', 'wear', 'doubts', 'care']);
  assert.ok(report.questions.length > 0);
  assert.ok(report.limits.length >= 4);
  assert.ok(report.disclaimer.includes('不是检测报告'));
  assert.ok(report.evidence.length >= 15);
  assert.ok(report.confidence_note.includes('不是"猜对的概率"'));
});

test('标准区块永远不出现"符合"结论', () => {
  const report = reportOf('demo-tshirt', DEMO_PROFILE, false);
  assert.equal(report.standard.compliance, 'not_assessed');
  const std = report.sections.find((s) => s.key === 'standard');
  const compliance = std.items.find((i) => i.key === 'compliance');
  assert.match(compliance.value, /未评估/);
});

test('演示标记会透传到卡片与提示语', () => {
  const report = reportOf('demo-tshirt', DEMO_PROFILE, true);
  assert.equal(report.demo, true);
  assert.ok(report.demo_note.includes('演示数据'));
});

test('结论措辞随完整度变化，且不含质量断言', () => {
  const rich = reportOf('demo-tshirt', DEMO_PROFILE, false);
  const poor = analyze({ ocr: { images: [] }, meta: { mode: 'local' } }).report;
  assert.match(rich.header.conclusion, /比较齐全/);
  assert.match(poor.header.conclusion, /受限/);
  for (const r of [rich, poor]) {
    assert.equal(/质量最好|品质最优|值得买/.test(r.header.conclusion), false);
  }
});

test('价格只在有来源时出现', () => {
  const withPrice = reportOf('demo-tshirt', DEMO_PROFILE, false);
  assert.equal(withPrice.header.price, 89);
  const withoutPrice = analyze({
    ocr: { images: [] },
    manualFields: require('../miniprogram/core/manual-fields').buildManualFields({ category: 'T恤' }),
    meta: { mode: 'local' }
  }).report;
  assert.equal(withoutPrice.header.price, null);
});

test('对比：少于两件时明确拒绝', () => {
  const r = buildComparison({ reports: [reportOf('demo-tshirt')] });
  assert.equal(r.ok, false);
  assert.match(r.message, /两件/);
});

test('对比：覆盖 2–3 件，超过 3 件会截断', () => {
  const two = buildComparison({ reports: [reportOf('demo-tshirt'), reportOf('demo-coat')], profile: DEMO_PROFILE });
  assert.equal(two.ok, true);
  assert.equal(two.items.length, 2);
  assert.ok(two.rows.length >= 10);

  const four = buildComparison({
    reports: [reportOf('demo-tshirt'), reportOf('demo-coat'), reportOf('demo-jeans'), reportOf('demo-jeans')]
  });
  assert.equal(four.items.length, 3);
});

test('对比：结论挂到偏好上，不排名质量', () => {
  const r = buildComparison({ reports: [reportOf('demo-tshirt'), reportOf('demo-coat')], profile: DEMO_PROFILE });
  const text = r.suggestion.lines.join(' ');
  assert.ok(text.includes('没有哪一件'));
  assert.ok(r.suggestion.preferences.some((p) => p.includes('宽松')));
  assert.equal(/质量最好的是|品质更好的是/.test(text), false);
  assert.ok(r.disclaimer.includes('信息更完整 ≠ 质量更好'));
});

test('对比：信息缺失不会被判为差', () => {
  const r = buildComparison({ reports: [reportOf('demo-tshirt'), reportOf('demo-coat')], profile: DEMO_PROFILE });
  const completeRow = r.rows.find((row) => row.label === '信息完整度');
  const text = JSON.stringify(completeRow.cells);
  assert.equal(/差|较差|不好/.test(text), false);
});
