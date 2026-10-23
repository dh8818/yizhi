'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { analyze } = require('../miniprogram/core/pipeline');
const { findDemo } = require('../miniprogram/core/data/demo.products');
const { computeCompleteness, buildDoubts } = require('../miniprogram/core/rules');
const { emptyFields } = require('../miniprogram/core/pipeline');
const standards = require('../miniprogram/core/standards');
const { assessWeight, assessYarnCount } = require('../miniprogram/core/fabric');
const { assessFit } = require('../miniprogram/core/fit');

const tshirt = findDemo('demo-tshirt');
const coat = findDemo('demo-coat');

const FORBIDDEN = ['违规', '违法', '假货', '不合格', '造假', '欺诈', '骗子'];

function allDoubtText(items) {
  return items.map((d) => `${d.title} ${d.reason} ${d.action || ''}`).join(' ');
}

test('完整度高时完整度等级为 high，并列出缺失字段', () => {
  const { fields } = analyze({ ocr: { images: tshirt.images }, meta: { mode: 'local' } });
  const c = computeCompleteness(fields);
  assert.equal(c.level, 'high');
  assert.deepEqual(c.key_missing, []);
  assert.ok(c.ratio > 0.8);
});

test('空字段集：完整度 low，关键字段全部列出', () => {
  const c = computeCompleteness(emptyFields());
  assert.equal(c.level, 'low');
  assert.ok(c.key_missing.includes('fiber_composition'));
  assert.ok(c.key_missing.includes('standard_code'));
  assert.ok(c.key_missing.includes('size_chart'));
});

test('疑点不重复：尺码表缺失只出现一次（具体规则优先于通用缺失）', () => {
  const { report } = analyze({ ocr: { images: coat.images }, meta: { mode: 'local' } });
  const sizeDoubts = report.doubts.filter((d) => /尺码表/.test(d.title));
  assert.equal(sizeDoubts.length, 1, `实际：${sizeDoubts.map((d) => d.title).join(' / ')}`);
});

test('疑点排序：attention 在 verify 之前，verify 在 info 之前', () => {
  const { report } = analyze({ ocr: { images: findDemo('demo-jeans').images }, meta: { mode: 'local' } });
  const order = { attention: 0, verify: 1, info: 2 };
  const seq = report.doubts.map((d) => order[d.severity]);
  assert.deepEqual(seq, seq.slice().sort((a, b) => a - b));
});

test('每条疑点都有具体依据与下一步，且不含指控性措辞', () => {
  for (const demo of ['demo-tshirt', 'demo-coat', 'demo-jeans']) {
    const { report } = analyze({ ocr: { images: findDemo(demo).images }, meta: { mode: 'local' } });
    for (const d of report.doubts) {
      assert.ok(d.reason && d.reason.length > 8, `${demo} 的疑点缺少原因：${d.title}`);
      assert.ok(Array.isArray(d.basis), `${demo} 的疑点缺少依据数组：${d.title}`);
      assert.ok(d.action && d.action.length > 4, `${demo} 的疑点缺少下一步：${d.title}`);
    }
    const text = allDoubtText(report.doubts);
    for (const word of FORBIDDEN) {
      assert.equal(text.includes(word), false, `疑点里出现了指控性措辞「${word}」：${text.slice(0, 80)}`);
    }
  }
});

test('功能性宣称会触发"需要依据"，并给出可复制的问题', () => {
  const { report } = analyze({ ocr: { images: tshirt.images }, meta: { mode: 'local' } });
  const claim = report.doubts.find((d) => d.id === 'claim-claim-functional');
  assert.ok(claim, '应识别"抗菌"宣称');
  assert.match(claim.reason, /抗菌/);
  assert.ok(report.questions.some((q) => q.includes('检测报告')));
});

test('克重缺失时不评级；有数值但无单位时标口径不明', () => {
  const missing = assessWeight({ category: 'T恤', weightField: null });
  assert.equal(missing.status, 'missing');
  assert.equal(missing.reference, null);

  const ambiguous = assessWeight({
    category: 'T恤',
    weightField: { normalized_value: 190, unit: null, status: 'pending_verification' }
  });
  assert.equal(ambiguous.status, 'ambiguous');
});

test('成衣重量不参与克重比较', () => {
  const r = assessWeight({
    category: 'T恤',
    weightField: null,
    garmentWeightField: { normalized_value: 320, unit: 'g' }
  });
  assert.equal(r.status, 'incomparable');
  assert.match(r.message, /不能换算/);
});

test('跨品类不给克重参考区间', () => {
  const r = assessWeight({ category: '羽绒服', weightField: { normalized_value: 300, unit: 'g/m²', status: 'extracted' } });
  assert.equal(r.status, 'insufficient_reference');
  assert.match(r.message, /没有可用的同类参考区间/);
});

test('参考区间带样本数与更新时间，且明确不是评级', () => {
  const r = assessWeight({ category: 'T恤', weightField: { normalized_value: 190, unit: 'g/m²', status: 'extracted' } });
  assert.equal(r.status, 'reference_only');
  assert.equal(r.reference.samples, 0);
  assert.ok(r.reference.updated_at);
  assert.match(r.message, /不是品质评级/);
});

test('支数：只给口径，不给评级', () => {
  const r = assessYarnCount({ normalized_value: '40 英制支数(S)' });
  assert.equal(r.status, 'known_unrated');
  assert.equal(r.value, '40 英制支数(S)');
  assert.ok(r.limits.some((l) => l.includes('不可直接排名')));
});

test('缺个人数据时，fit 只读尺码表而不给尺码', () => {
  const { fields } = analyze({ ocr: { images: tshirt.images }, meta: { mode: 'local' } });
  const fit = assessFit({ fields, profile: null });
  assert.equal(fit.status, 'profile_incomplete');
  assert.equal(fit.recommended_size, null);
  assert.ok(fit.reasons.some((r) => r.includes('不会推测')));
});

test('个人数据齐全时给出带理由的尺码建议', () => {
  const { fields } = analyze({ ocr: { images: tshirt.images }, meta: { mode: 'local' } });
  const fit = assessFit({ fields, profile: { bust: 96, shoulder: 44, looseness: '宽松', usual_size: 'M' } });
  assert.equal(fit.status, 'heuristic');
  assert.ok(['S', 'M', 'L', 'XL'].includes(fit.recommended_size));
  assert.ok(fit.reasons.length >= 2);
  assert.ok(fit.limits.some((l) => l.includes('不是同一个口径')));
  assert.ok(fit.recommendation.target_bust >= 96);
});

test('缺尺码表时即使用户数据完整也不给尺码', () => {
  const { fields } = analyze({ ocr: { images: coat.images }, meta: { mode: 'local' } });
  const fit = assessFit({ fields, profile: { bust: 96, looseness: '宽松' } });
  assert.equal(fit.status, 'chart_missing');
  assert.equal(fit.recommended_size, null);
});

test('buildDoubts 在无标准号时给出可执行动作', () => {
  const fields = emptyFields();
  const standard = standards.associate({ product_category: null });
  const doubts = buildDoubts({ fields, standard, weight: assessWeight({}), fit: null });
  const std = doubts.items.find((d) => d.id === 'standard-missing');
  assert.ok(std);
  assert.ok(std.action.includes('吊牌'));
});
