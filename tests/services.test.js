'use strict';

/**
 * services 层冒烟测试：用一个最小 wx mock 跑通"页面会用到的真实调用路径"
 * （storage + analysis.run + 修正 + 清空），补上 core 测试覆盖不到的那一层胶水。
 */

const { test, before } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const store = new Map();

global.wx = {
  getStorageSync(key) {
    return store.has(key) ? store.get(key) : '';
  },
  setStorageSync(key, value) {
    store.set(key, JSON.parse(JSON.stringify(value)));
  },
  removeStorageSync(key) {
    store.delete(key);
  },
  getStorageInfoSync() {
    return { currentSize: 12, limitSize: 10240 };
  }
};

const storage = require('../miniprogram/services/storage');
const analysis = require('../miniprogram/services/analysis');
const { getSettings } = require('../miniprogram/config');

before(() => {
  store.clear();
});

test('本地模式：没有示例也没有手填时明确拒绝（不伪造 OCR）', async () => {
  const r = await analysis.run({ images: [{ id: 'img-1', path: 'x.jpg', kind: 'promo_screenshot' }] });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'LOCAL_NO_OCR');
  assert.match(r.error.message, /不能识别图片文字/);
  assert.equal(storage.listHistory().length, 0);
});

test('本地模式：示例商品跑通并写入历史，带演示标记', async () => {
  const r = await analysis.run({ demoId: 'demo-tshirt', profile: { bust: 96, looseness: '宽松' } });
  assert.equal(r.ok, true);
  assert.equal(r.report.demo, true);
  assert.match(r.report.demo_label, /演示数据/);
  assert.ok(r.report.header.conclusion.length > 10);
  assert.equal(r.report.fit.status, 'heuristic');

  const list = storage.listHistory();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, r.history_id);
  assert.ok(list[0].fields, '历史里要保留字段明细，供后续修正');
  assert.ok(list[0].report, '历史里要保留完整报告');
});

test('本地模式：只填手填字段也能出卡，状态为已确认', async () => {
  store.clear();
  const r = await analysis.run({
    manual: {
      product_name: '测试衬衫',
      category: '衬衫',
      standard_code: 'GB/T 2660-2017',
      fiber_composition: '棉 100%',
      size_chart: 'M 胸围 104 肩宽 45 衣长 72\nL 胸围 108 肩宽 46 衣长 74'
    },
    profile: { bust: 96, looseness: '合体' }
  });
  assert.equal(r.ok, true);
  assert.equal(r.fields.standard_code.status, 'user_confirmed');
  assert.equal(r.fields.standard_code.source_type, 'user_input');
  assert.equal(r.report.standard.official_status_label, '现行');
  assert.equal(r.report.fit.status, 'heuristic');
  assert.ok(['M', 'L'].includes(r.report.fit.recommended_size));
});

test('字段修正：重算卡片并保留原识别值', async () => {
  store.clear();
  const first = await analysis.run({ demoId: 'demo-tshirt' });
  const corrected = analysis.applyCorrectionLocal({
    fields: first.fields,
    fieldKey: 'standard_code',
    value: 'GB 18401-2010',
    profile: null,
    images: []
  });
  assert.equal(corrected.fields.standard_code.status, 'user_confirmed');
  assert.equal(corrected.report.standard.normalized_code, 'GB 18401-2010');
  assert.ok(corrected.fields.standard_code.alternatives.length >= 1, '原识别值必须保留');
  assert.ok(
    corrected.fields.standard_code.alternatives.some((a) => String(a.normalized_value).includes('22849')),
    '原值应是 GB/T 22849-2024'
  );
});

test('字段修正：不在手填表单里的字段也能改（不会静默失效）', async () => {
  store.clear();
  const first = await analysis.run({ demoId: 'demo-coat' }); // 这款原本没有克重
  const corrected = analysis.applyCorrectionLocal({
    fields: first.fields,
    fieldKey: 'garment_weight',
    value: '320g',
    profile: null,
    images: []
  });
  assert.equal(corrected.fields.garment_weight.status, 'user_confirmed');
  assert.equal(corrected.fields.garment_weight.unit, 'g');
  assert.equal(corrected.fields.garment_weight.normalized_value, 320);
  // 单件重量不能被当成面料克重做区间对照
  assert.equal(corrected.report.weight.status, 'incomparable');
});

test('删除与清空：历史、收藏、资料都能真的删掉', async () => {
  store.clear();
  const r = await analysis.run({ demoId: 'demo-coat' });
  assert.equal(storage.listHistory().length, 1);
  storage.toggleFavorite(r.history_id);
  assert.equal(storage.isFavorite(r.history_id), true);

  storage.removeHistory(r.history_id);
  assert.equal(storage.listHistory().length, 0);
  assert.equal(storage.listFavorites().length, 0);

  storage.saveProfile({ bust: 96, looseness: '宽松' });
  assert.ok(storage.getProfile());
  storage.clearProfile();
  assert.equal(storage.getProfile(), null);

  storage.saveFeedback('测试反馈');
  storage.clearAll();
  assert.equal(storage.listHistory().length, 0);
  assert.equal(storage.listFeedback().length, 0);
});

test('设置默认是本地模式，且不含任何密钥字段', () => {
  const s = getSettings();
  assert.equal(s.mode, 'local');
  assert.equal(s.apiBase.startsWith('http'), true);
  assert.equal(Object.keys(s).some((k) => /key|secret|token/i.test(k)), false);
});
