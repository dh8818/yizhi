'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  normalizeStandardCode,
  normalizeFiberComposition,
  normalizeWeight,
  normalizeYarnCount,
  normalizePrice,
  normalizeSizeChart,
  tidy
} = require('../miniprogram/core/normalize');

test('tidy 去掉全角与 OCR 噪声', () => {
  assert.equal(tidy('　棉　１００％ '), '棉 100%');
});

test('标准号：全角/破折号/小写都能规范化', () => {
  const n = normalizeStandardCode('ｇｂ／ｔ ２２８４９—２０２４');
  assert.equal(n.valid, true);
  assert.equal(n.code, 'GB/T 22849-2024');
  assert.equal(n.has_year, true);
});

test('标准号：缺年份时不自动补年份', () => {
  const n = normalizeStandardCode('GB 18401');
  assert.equal(n.code, 'GB 18401');
  assert.equal(n.has_year, false);
  assert.match(n.note, /缺少年份/);
});

test('标准号：无法识别的写法标记无效而不是猜', () => {
  const n = normalizeStandardCode('执行国标');
  assert.equal(n.valid, false);
  assert.equal(n.code, null);
});

test('纤维成分：单段 100%', () => {
  const r = normalizeFiberComposition('面料：棉 100%');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].fiber, '棉');
  assert.equal(r.complete, true);
});

test('纤维成分：多段（面料/里料）保留分段', () => {
  const r = normalizeFiberComposition('面料：羊毛 70% 聚酯纤维 30%\n里料：聚酯纤维 100%');
  assert.equal(r.parts.length, 2);
  assert.equal(r.parts[0].part, '面料');
  assert.equal(r.parts[1].part, '里料');
  assert.equal(r.parts[1].items[0].percent, 100);
});

test('纤维成分：比例合计不到 100 时标记不完整', () => {
  const r = normalizeFiberComposition('棉 90% 氨纶 8%');
  assert.equal(r.complete, false);
  assert.match(r.note, /98/);
});

test('纤维成分：百分比写在纤维前面也能解析', () => {
  const r = normalizeFiberComposition('95%棉 5%氨纶');
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].percent, 95);
});

test('克重：g/m² 识别为面料克重', () => {
  const w = normalizeWeight('克重：190g/m²');
  assert.equal(w.value, 190);
  assert.equal(w.unit, 'g/m²');
  assert.equal(w.kind, 'fabric_weight');
});

test('克重：单件重量不会被当成克重', () => {
  const w = normalizeWeight('净重：320克');
  assert.equal(w.kind, 'garment_weight');
  assert.equal(w.unit, 'g');
});

test('克重：无单位时不换算、标为口径不明', () => {
  const w = normalizeWeight('克重 190');
  assert.equal(w.kind, 'ambiguous');
  assert.equal(w.unit, null);
});

test('支数：识别英制体系', () => {
  const y = normalizeYarnCount('40S 精梳棉');
  assert.equal(y.value, 40);
  assert.equal(y.system, '英制支数(S)');
});

test('支数：无体系时不给结论', () => {
  const y = normalizeYarnCount('支数 60');
  assert.equal(y.system, null);
  assert.match(y.note, /不可直接比较/);
});

test('价格：促销价会提示口径', () => {
  const p = normalizePrice('券后 ¥199');
  assert.equal(p.value, 199);
  assert.match(p.note, /促销/);
});

test('尺码表：按行解析出尺码与测量值', () => {
  const c = normalizeSizeChart('S 胸围 104 肩宽 46 衣长 66\nM 胸围 108 肩宽 47 衣长 68');
  assert.equal(c.sizes.length, 2);
  assert.equal(c.sizes[1].size, 'M');
  assert.equal(c.sizes[1].measurements['胸围'], 108);
});
