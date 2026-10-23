'use strict';

/**
 * 老化风险模块测试：对应补充规范 §13 的 14 个案例。
 * 每个案例只用"模拟 OCR 文本"构造，不依赖图片识别。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { buildWearReport } = require('../miniprogram/core/wear/analyze');
const { analyze } = require('../miniprogram/core/pipeline');
const { RULES } = require('../miniprogram/core/wear/rules');

function ocrOf(lines, kind) {
  return {
    images: [
      {
        id: 'case-1',
        kind: kind || 'promo_screenshot',
        blocks: lines.map((text) => ({ text, confidence: 0.9 }))
      }
    ]
  };
}

function wearOf(lines, opts) {
  const o = opts || {};
  const { fields } = analyze({ ocr: ocrOf(lines, o.kind), meta: { mode: 'local' } });
  return { wear: buildWearReport({ fields, rawText: lines.join('\n') }), fields };
}

const ids = (w) => w.items.map((i) => i.id);

/* 1 */
test('案例1：罗纹领口的针织T恤 → 领口/袖口/起球/缩水', () => {
  const { wear } = wearOf([
    '纯棉短袖T恤 男女同款',
    '面料成分：棉 100%',
    '克重：190g/m²',
    '领口：罗纹领口，双层包边',
    '袖口：罗纹收口',
    '洗涤：可机洗，40℃以下'
  ]);
  const found = ids(wear);
  assert.ok(found.includes('rib-collar-relax'), `实际：${found.join(',')}`);
  assert.ok(found.includes('cuff-hem-relax'));
  assert.ok(found.includes('knit-pilling'));
  assert.ok(found.includes('cellulosic-shrinkage'));
  const collar = wear.items.find((i) => i.id === 'rib-collar-relax');
  assert.equal(collar.garment_area, '领口');
  assert.ok(collar.mechanism.length > 10, '必须解释形成机制');
  assert.ok(collar.seller_questions.length > 0);
  assert.equal(collar.evidence_level, 'general_knowledge');
});

/* 2 */
test('案例2：大面积胶印的卫衣 → 印花开裂，且与工艺相关', () => {
  const { wear } = wearOf([
    '连帽卫衣 加绒',
    '面料：棉 80% 聚酯纤维 20%',
    '大面积胶印图案 前胸满印',
    '罗纹袖口 罗纹下摆',
    '帽绳：抽绳'
  ]);
  const found = ids(wear);
  assert.ok(found.includes('print-crack'));
  assert.ok(found.includes('hoodie-cord-anchor'));
  const print = wear.items.find((i) => i.id === 'print-crack');
  assert.match(print.mechanism, /膜层|印花/);
  assert.ok(print.mitigation.some((m) => m.includes('翻面')));
});

/* 3 */
test('案例3：带仿皮涂层的夹克 → 涂层剥离，且不得断言化学材质', () => {
  const { wear } = wearOf(['仿皮夹克 PU涂层', '面料：聚酯纤维 100%', '金属拉链']);
  const found = ids(wear);
  assert.ok(found.includes('coating-peel'));
  const coat = wear.items.find((i) => i.id === 'coating-peel');
  assert.equal(coat.impact_level, 'high', '涂层剥落影响程度高');
  assert.match(coat.disclaimer, /不是检测结论/);
  // 只能表述为"疑似涂层/仿皮结构"
  const allText = JSON.stringify(wear);
  assert.equal(/聚氨酯|PVC的?材质已确认/.test(allText), false);
});

/* 4 */
test('案例4：绒面/磨毛 → 绒感变化，且区分正常变化与损伤', () => {
  const { wear } = wearOf(['摇粒绒外套 抓绒', '面料：聚酯纤维 100%', '克重：300g/m²']);
  const found = ids(wear);
  assert.ok(found.includes('brushed-surface-change'));
  const r = wear.items.find((i) => i.id === 'brushed-surface-change');
  assert.match(r.limitations, /正常现象|灰色地带|不据此判定/);
  assert.equal(r.impact_level, 'low');
});

/* 5 */
test('案例5：深色牛仔裤 → 裤裆磨损 + 褪色', () => {
  const { wear } = wearOf([
    '高腰直筒牛仔裤 黑色',
    '面料：棉 98% 氨纶 2%',
    '克重：360g/m²',
    '工艺：水洗做旧'
  ]);
  const found = ids(wear);
  assert.ok(found.includes('jeans-crotch-thigh'));
  assert.ok(found.includes('dark-color-fade'), `实际：${found.join(',')}`);
  const wash = wear.items.find((i) => i.id === 'dark-color-fade');
  assert.match(wash.not_applicable, /水洗做旧|预设/);
});

/* 6 */
test('案例6：浅色纯棉衬衫 → 领口磨白、纽扣，但不误报深色褪色', () => {
  const { wear } = wearOf([
    '男士长袖衬衫 白色',
    '面料：棉 100%',
    '门襟：纽扣 7 粒',
    '衣领：有衬领座'
  ]);
  const found = ids(wear);
  assert.ok(found.includes('shirt-collar-wear'));
  assert.ok(found.includes('button-hole-loose'));
  assert.equal(found.includes('dark-color-fade'), false, '浅色不应命中深色褪色规则');
});

/* 7 */
test('案例7：含弹性纤维的紧身裤 → 弹性衰减 + 接缝受力', () => {
  const { wear } = wearOf(['瑜伽紧身裤 高弹', '面料：锦纶 75% 氨纶 25%', '四针六线接缝']);
  const found = ids(wear);
  assert.ok(found.includes('spandex-decay'));
  const sp = wear.items.find((i) => i.id === 'spandex-decay');
  assert.match(sp.mechanism, /高温|氯/);
  assert.ok(sp.limitations.includes('无法预测具体衰减速度'));
});

/* 8 */
test('案例8：高装饰（贴布/珠片）→ 连接失效 + 搭配提示', () => {
  const { wear } = wearOf(['刺绣贴布 珠片装饰卫衣', '面料：棉 70% 聚酯纤维 30%', '水钻装饰']);
  const found = ids(wear);
  assert.ok(found.includes('embroidery-attach'));
  const r = wear.items.find((i) => i.id === 'embroidery-attach');
  assert.ok(r.failure_modes.length >= 3);
  assert.ok(wear.appearance.style.some((s) => /装饰/.test(s.title)));
});

/* 9 */
test('案例9：金属拉链/纽扣外套 → 五金磨损', () => {
  const { wear } = wearOf(['工装外套 金属拉链 铜扣', '面料：棉 60% 锦纶 40%', '五金：YKK 拉链']);
  const found = ids(wear);
  assert.ok(found.includes('metal-hardware-wear'));
  const r = wear.items.find((i) => i.id === 'metal-hardware-wear');
  assert.match(r.limitations, /无法判断内部结构|镀层厚度/);
});

/* 10 */
test('案例10：复杂拼接运动服 → 接缝/拼接相关条目', () => {
  const { wear } = wearOf(['运动外套 拼色拼接 弹力速干', '面料：聚酯纤维 88% 氨纶 12%', '反光印花']);
  const found = ids(wear);
  assert.ok(found.includes('sport-seam-strain'), `实际：${found.join(',')}`);
  assert.ok(found.includes('print-on-stretch') || found.includes('print-crack'));
});

/* 11 */
test('案例11：只有主图、无接缝细节 → 大量证据不足，且不默认低风险', () => {
  const { wear } = wearOf(['春季新款女装上衣', '版型：宽松']);
  assert.ok(wear.available);
  const insufficient = wear.items.filter((i) => i.overall_risk === 'insufficient');
  assert.ok(insufficient.length > 0, '缺材料/结构时必须出现证据不足');
  for (const it of insufficient) {
    assert.equal(it.overall_risk, 'insufficient');
    assert.notEqual(it.overall_risk, 'low');
    assert.ok(it.missing_information.length > 0, '证据不足必须写明缺什么');
  }
  assert.ok(wear.evidence_gaps.length > 0);
});

/* 12 */
test('案例12：宣称耐磨抗起球但无检测资料 → 只要求证据，不给性能结论', () => {
  const { wear } = wearOf(['面料：棉 100%', '抗起球 耐磨 免烫处理', '克重：180g/m²']);
  const found = ids(wear);
  assert.ok(found.includes('claim-without-data'));
  const r = wear.items.find((i) => i.id === 'claim-without-data');
  assert.equal(r.likelihood_level, 'unknown');
  assert.match(r.mechanism, /检测|测试/);
  assert.ok(r.seller_questions[0].includes('检测报告'));
  // 不得出现"已经过抗起球测试"这类表述
  assert.equal(/已通过.*测试|检测结果合格/.test(JSON.stringify(wear)), false);
});

/* 13 */
test('案例13：已出现裂纹/开线 → 标为已存在损伤（high + 高置信），与未来风险区分', () => {
  const { wear } = wearOf(['二手闲置 卫衣', '描述：袖口已开线，表面有轻微起球', '面料：棉 100%']);
  const found = ids(wear);
  assert.ok(found.includes('existing-damage'));
  const r = wear.items.find((i) => i.id === 'existing-damage');
  assert.equal(r.overall_risk, 'high');
  assert.equal(r.confidence_level, 'high');
  assert.equal(r.evidence_level, 'observed_defect');
  assert.match(r.mechanism, /已经发生/);
});

/* 14 */
test('案例14：只有成分、无结构与工艺 → 结论保守，并列出缺什么', () => {
  const { wear } = wearOf(['面料：棉 100%']);
  const structureRules = ['rib-collar-relax', 'print-crack', 'coating-peel', 'jeans-crotch-thigh'];
  for (const id of structureRules) {
    assert.equal(ids(wear).includes(id), false, `${id} 不应在没有结构信息时命中`);
  }
  const anyItem = wear.items[0];
  if (anyItem) {
    assert.ok(['insufficient', 'low', 'medium'].includes(anyItem.overall_risk));
    assert.ok(anyItem.construction_feature.includes('未提供'));
  }
  assert.match(wear.summary, /证据|无法判断|补充|尚未验证/);
});

/* ───────── 结构性与边界断言（规范 §9 / §14） ───────── */

test('每条风险都包含规范要求的 18 个字段', () => {
  const { wear } = wearOf([
    '纯棉短袖T恤 罗纹领口',
    '面料成分：棉 100%',
    '克数：190g/m²',
    '洗涤：40℃机洗'
  ]);
  const required = [
    'item_name', 'garment_area', 'observed_feature', 'identified_material', 'construction_feature',
    'possible_failure', 'mechanism', 'evidence', 'missing_information', 'likelihood_level',
    'impact_level', 'overall_risk', 'confidence_level', 'mitigation', 'seller_questions',
    'verification_method', 'source_references', 'disclaimer'
  ];
  assert.ok(wear.items.length > 0);
  for (const it of wear.items) {
    for (const k of required) {
      assert.ok(Object.prototype.hasOwnProperty.call(it, k), `缺字段 ${k}（${it.id}）`);
      assert.notEqual(it[k], undefined, `字段 ${k} 为 undefined（${it.id}）`);
    }
    assert.ok(['high', 'medium', 'low', 'unknown'].includes(it.likelihood_level));
    assert.ok(['high', 'medium', 'low'].includes(it.impact_level));
    assert.ok(['high', 'medium', 'low', 'insufficient'].includes(it.overall_risk));
    assert.ok(['high', 'medium', 'low', 'unknown'].includes(it.confidence_level));
  }
});

test('不预测寿命/概率，不出现伪精确数字', () => {
  const cases = [
    ['纯棉T恤 罗纹领口', '面料：棉 100%'],
    ['仿皮夹克 PU涂层', '面料：聚酯纤维 100%'],
    ['牛仔裤 黑色', '面料：棉 98% 氨纶 2%'],
    ['羊毛大衣', '面料：羊毛 70% 聚酯纤维 30%']
  ];
  for (const lines of cases) {
    const { wear } = wearOf(lines);
    const text = JSON.stringify(wear);
    assert.equal(/能用\s*\d+\s*年|穿\s*\d+\s*次|大概率|\d+\s*%\s*的概率/.test(text), false, `出现寿命/概率表述：${text.slice(0, 80)}`);
    assert.equal(/必然|一定会|肯定/.test(text), false, '不出现绝对化断言');
    assert.equal(/土|廉价|难看|低档/.test(text), false, '不使用审美贬损词');
  }
});

test('时间轴是 5 个定性阶段，不含寿命预测', () => {
  const { wear } = wearOf(['纯棉T恤 罗纹领口', '面料：棉 100%']);
  assert.equal(wear.timeline.length, 5);
  assert.deepEqual(wear.timeline.map((s) => s.stage), ['初始状态', '使用与摩擦', '洗护', '长期外观', '实际反馈']);
  for (const s of wear.timeline) {
    assert.ok(s.text.length > 8);
    assert.equal(/天|个月|年/.test(s.text.replace(/长期/g, '')), false, `时间轴出现具体时长：${s.text}`);
  }
});

test('区域分布：按品类给区域，未匹配的条目也不会被吞掉', () => {
  const { wear } = wearOf(['高腰直筒牛仔裤', '面料：棉 98% 氨纶 2%']);
  assert.equal(wear.regions.outline, 'bottom');
  const names = wear.regions.regions.map((r) => r.name);
  assert.ok(names.includes('裤裆'));
  // 条目区域若不在预置区域里，会作为额外区域出现
  const itemAreas = wear.items.map((i) => i.garment_area.split(' / ')[0]);
  for (const area of itemAreas) {
    assert.ok(names.includes(area) || names.some((n) => area.indexOf(n) >= 0), `区域 ${area} 未出现在分布图中`);
  }
  assert.match(wear.regions.note, /不代表已检查/);
});

test('物理耐久性与长期外观（搭配）分开输出', () => {
  const { wear } = wearOf(['大面积胶印图案 卫衣 拼色拼接', '面料：棉 80% 聚酯纤维 20%']);
  assert.ok(Array.isArray(wear.appearance.durability));
  assert.ok(Array.isArray(wear.appearance.style));
  assert.ok(wear.appearance.style.length > 0);
  assert.match(wear.appearance.disclaimer, /不评价审美|中性描述/);
  // 搭配建议不得写成质量结论
  assert.equal(/质量差|不值|别买/.test(JSON.stringify(wear.appearance)), false);
});

test('不同商品的总结不相同（不是模板套话）', () => {
  const a = wearOf(['罗纹领口纯棉T恤', '面料：棉 100%']).wear.summary;
  const b = wearOf(['仿皮夹克 PU涂层 金属拉链', '面料：聚酯纤维 100%']).wear.summary;
  const c = wearOf(['高腰牛仔裤 黑色', '面料：棉 98% 氨纶 2%']).wear.summary;
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.notEqual(a, c);
});

test('规则库规模与字段完整性', () => {
  assert.ok(RULES.length >= 20, `规则数 ${RULES.length}`);
  for (const r of RULES) {
    assert.ok(r.id && r.name && r.area && r.mechanism && r.impact);
    assert.ok(Array.isArray(r.failure_modes) && r.failure_modes.length > 0);
    assert.ok(Array.isArray(r.evidence_needed) && r.evidence_needed.length > 0);
    assert.ok(Array.isArray(r.mitigation) && r.mitigation.length > 0);
    assert.ok(Array.isArray(r.seller_questions) && r.seller_questions.length > 0);
    assert.ok(r.limitations && r.limitations.length > 5);
    assert.ok(r.updated_at);
    assert.ok(['general_knowledge', 'industry_practice', 'observed_defect'].includes(r.evidence_level));
  }
});

test('报告里新增了「穿久了会怎么样？」区块，且不破坏原有区块', () => {
  const { fields } = analyze({ ocr: ocrOf(['纯棉T恤 罗纹领口', '面料：棉 100%']), meta: { mode: 'local' } });
  const report = require('../miniprogram/core/report').buildReport({ fields, rawText: '纯棉T恤 罗纹领口' });
  const keys = report.sections.map((s) => s.key);
  assert.deepEqual(keys, ['basic', 'standard', 'fabric', 'fit', 'wear', 'doubts', 'care']);
  const wearSection = report.sections.find((s) => s.key === 'wear');
  assert.equal(wearSection.title, '穿久了会怎么样？');
  assert.ok(wearSection.items.length > 0);
  assert.ok(report.wear.items.length > 0);
  assert.ok(report.limits.some((l) => l.includes('老化')));
});
