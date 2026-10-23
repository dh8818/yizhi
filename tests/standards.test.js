'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const standards = require('../miniprogram/core/standards');

test('已核验标准：GB 18401 能查到真实官方字段', () => {
  const r = standards.lookup('GB 18401');
  assert.equal(r.result, 'official_verified');
  assert.equal(r.record.standard_number, 'GB 18401-2010');
  assert.equal(r.record.name, '国家纺织产品基本安全技术规范');
  assert.equal(r.record.status, 'current');
  assert.match(r.record.publication_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(r.record.implementation_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(r.last_verified_at, '必须带核验时间');
  assert.match(r.official_source_url, /openstd\.samr\.gov\.cn/);
});

test('未收录的年份版本不会被当成已核验', () => {
  const r = standards.lookup('GB 18401-2003');
  assert.equal(r.result, 'pending_verification');
  assert.match(r.message, /没有 2003 版|未核验/);
});

test('不存在的标准号：返回待核验而不是"不存在"的断言', () => {
  const r = standards.lookup('GB 99999');
  assert.equal(r.result, 'pending_verification');
  assert.equal(r.record, null);
  assert.match(r.message, /不判断/);
});

test('行业标准不在国标库：有记录但明确标为待核验', () => {
  const d = standards.detail('FZ/T 73020');
  assert.equal(d.found, true);
  assert.equal(d.verified, false);
  assert.equal(d.registry_result, 'pending_verification');
  assert.match(d.message, /行业标准|hbba/);
});

test('关联判断：标准与商品永远不输出符合性结论', () => {
  const a = standards.associate({
    standard_code_field: { normalized_value: 'GB/T 22849-2024' },
    product_category: 'T恤'
  });
  assert.equal(a.appears_in_product, true);
  assert.equal(a.registry_match, true);
  assert.equal(a.compliance, 'not_assessed');
  assert.equal(a.applicability, 'likely');
  assert.ok(a.caveats.some((c) => c.includes('不做符合性判定')));
});

test('关联判断：品类不匹配时给出"可能不适用"', () => {
  const a = standards.associate({
    standard_code_field: { normalized_value: 'GB/T 2665-2017' },
    product_category: 'T恤'
  });
  assert.equal(a.applicability, 'unlikely');
  assert.match(a.applicability_reason, /不一致/);
  assert.equal(a.compliance, 'not_assessed');
});

test('关联判断：没有标准号时不臆造关联', () => {
  const a = standards.associate({ product_category: 'T恤' });
  assert.equal(a.appears_in_product, false);
  assert.equal(a.registry_match, false);
  assert.ok(a.suggested_standards.length > 0, '应给出"该查哪些标准"的提示');
  assert.ok(a.caveats.some((c) => c.includes('没有标准号')));
});

test('标准详情：范围条款不代填，并说明原因', () => {
  const d = standards.detail('GB 18401-2010');
  assert.equal(d.found, true);
  assert.equal(d.record.scope_summary, undefined);
  assert.ok(d.message === null || typeof d.message === 'string');
  assert.equal(d.editorial.key_requirements_verified, false);
});

test('搜索：按号或名称都能命中', () => {
  const byNumber = standards.search('18401');
  assert.ok(byNumber.results.length >= 1);
  const byName = standards.search('羽绒');
  assert.ok(byName.results.some((r) => r.name.includes('羽绒')));
});
