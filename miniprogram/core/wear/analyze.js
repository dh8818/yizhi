/**
 * wear/analyze.js —— 长期穿着与老化风险分析。
 *
 * 输入：已合并的字段（fields）+ OCR 原文（rawText）+ 用户偏好（profile，可选）
 * 输出：风险条目（18 个字段）、时间轴、长期外观、区域分布、补图建议、一句话总结。
 *
 * 硬性约束（对应规范 §9 / §12 / §14）：
 *   - 证据不足时 overall_risk = insufficient_evidence，绝不默认"低风险"；
 *   - likelihood 与 impact 分开表达：某一项未知就单独标 unknown，不强行合并成"综合分"；
 *   - 不生成未校准的综合分数，不给具体寿命/洗涤次数/概率；
 *   - 已存在的损伤（observed_defect）与未来可能的变化分开表述；
 *   - 所有措辞面向普通消费者，不做质量指控。
 */

'use strict';

const { hasValue } = require('../fields');
const { detectFeatures } = require('./features');
const { RULES, CATEGORY_REGIONS, UPDATED_AT } = require('./rules');

const IMPACT_MATRIX = {
  high: { high: 'high', medium: 'high', low: 'medium' },
  medium: { high: 'high', medium: 'medium', low: 'low' },
  low: { high: 'medium', medium: 'low', low: 'low' }
};

const LEVEL_LABEL = {
  high: '高风险',
  medium: '中风险',
  low: '低风险',
  insufficient: '证据不足',
  unknown: '无法判断'
};

const CONFIDENCE_LABEL = {
  high: '较高',
  medium: '中等',
  low: '较低',
  unknown: '无法判断'
};

const SEVERITY_ORDER = { high: 0, medium: 1, insufficient: 2, low: 3 };

/* ───────────────── 事实收集 ───────────────── */

function materialFacts(fields) {
  const fiber = fields.fiber_composition;
  const hasFiber = Boolean(fiber && hasValue(fiber));
  const items = fiber && fiber.parsed && Array.isArray(fiber.parsed.items) ? fiber.parsed.items : [];
  const weight = fields.fabric_weight && hasValue(fields.fabric_weight) && fields.fabric_weight.unit === 'g/m²'
    ? Number(fields.fabric_weight.normalized_value)
    : null;
  return {
    has_fiber: hasFiber,
    fiber_text: hasFiber ? String(fiber.normalized_value) : null,
    fiber_items: items,
    weight_g_m2: weight,
    has_construction: Boolean(
      (fields.fit_description && hasValue(fields.fit_description)) ||
        (fields.weave_structure && hasValue(fields.weave_structure)) ||
        (fields.elasticity && hasValue(fields.elasticity)) ||
        (fields.size_chart && hasValue(fields.size_chart))
    ),
    care: fields.care_instructions && hasValue(fields.care_instructions) ? String(fields.care_instructions.normalized_value) : null,
    category: fields.category && hasValue(fields.category) ? String(fields.category.normalized_value) : null
  };
}

/* ───────────────── 规则匹配 ───────────────── */

function matches(rule, ctx) {
  if (rule.categories && rule.categories.length) {
    if (!ctx.category) return { matched: false, reason: '品类未知' };
    if (rule.categories.indexOf(ctx.category) < 0) return { matched: false, reason: '品类不符' };
  }
  const keys = Object.keys(ctx.features.byKey);
  if (Array.isArray(rule.requires_features) && rule.requires_features.length) {
    for (const f of rule.requires_features) {
      if (keys.indexOf(f) < 0) return { matched: false, reason: `缺少特征 ${f}` };
    }
  }
  if (Array.isArray(rule.any_features) && rule.any_features.length) {
    const hit = rule.any_features.some((f) => keys.indexOf(f) >= 0);
    if (!hit) return { matched: false, reason: '缺少任一相关特征' };
  }
  if (rule.text_regex) {
    if (!rule.text_regex.test(ctx.rawText) && !rule.text_regex.test(ctx.fiberText || '')) {
      return { matched: false, reason: '原文未命中' };
    }
  }
  // 没有任何限定条件的规则不成立（避免"泛泛而谈"的条目）
  const hasCondition = (rule.requires_features && rule.requires_features.length) ||
    (rule.any_features && rule.any_features.length) ||
    rule.text_regex;
  if (!hasCondition) return { matched: false, reason: '规则无匹配条件' };
  return { matched: true, reason: '命中' };
}

function likelihoodOf(rule, facts, features) {
  if (rule.evidence_level === 'observed_defect') return 'high';
  if (rule.likelihood_when_known === 'unknown') return 'unknown';
  // 需要"材料已知 + 结构已知"才给可能性；否则按规范留 unknown（证据不足 ≠ 低风险）
  const structuralKnown = Boolean(
    features.byKey.knit_structure || features.byKey.woven_structure || features.byKey.coating_faux_leather || facts.has_construction
  );
  if (facts.has_fiber && structuralKnown) return rule.likelihood_when_known || 'medium';
  if (facts.has_fiber || structuralKnown) return 'unknown';
  return 'unknown';
}

function overallOf(likelihood, impact) {
  if (likelihood === 'unknown' || impact === 'unknown') return 'insufficient';
  const row = IMPACT_MATRIX[likelihood];
  return (row && row[impact]) || 'insufficient';
}

function confidenceOf(rule, facts, features, likelihood) {
  if (rule.evidence_level === 'observed_defect') return 'high';
  const featureKnown = Object.keys(features.byKey).length > 0;
  if (facts.has_fiber && facts.has_construction && featureKnown) return 'medium';
  if (facts.has_fiber || facts.has_construction || featureKnown) return 'low';
  return 'unknown';
}

function buildItem(rule, ctx) {
  const featureKeys = [].concat(rule.requires_features || [], rule.any_features || []);
  const observed = featureKeys
    .map((k) => ctx.features.byKey[k])
    .filter(Boolean)
    .map((f) => `${f.label}（原文/字段：${f.evidence}）`);

  const likelihood = likelihoodOf(rule, ctx.facts, ctx.features);
  const overall = overallOf(likelihood, rule.impact);
  const confidence = confidenceOf(rule, ctx.facts, ctx.features, likelihood);

  const evidence = [];
  for (const f of featureKeys.map((k) => ctx.features.byKey[k]).filter(Boolean)) {
    evidence.push({ type: 'feature', label: f.label, text: f.evidence, source: f.source });
  }
  if (ctx.facts.fiber_text) evidence.push({ type: 'field', label: '纤维成分', text: ctx.facts.fiber_text, source: '标注' });
  if (ctx.facts.weight_g_m2) evidence.push({ type: 'field', label: '面料克重', text: `${ctx.facts.weight_g_m2} g/m²`, source: '标注' });
  if (ctx.facts.care) evidence.push({ type: 'field', label: '洗护', text: ctx.facts.care, source: '标签' });

  const missing = [];
  for (const need of rule.evidence_needed || []) {
    if (/成分|比例/.test(need) && ctx.facts.has_fiber) continue;
    if (/洗护/.test(need) && ctx.facts.care) continue;
    if (/克重/.test(need) && ctx.facts.weight_g_m2) continue;
    missing.push(need);
  }

  return {
    id: rule.id,
    item_name: rule.name,
    garment_area: rule.area,
    observed_feature: observed.length ? observed.join('；') : '（仅依据通用规律，未在本次材料中观察到具体特征）',
    identified_material: ctx.facts.fiber_text || '未提供纤维成分',
    construction_feature: ctx.facts.has_construction ? '有部分结构/版型信息' : '未提供结构或工艺信息',
    possible_failure: (rule.failure_modes || []).join('；'),
    failure_modes: rule.failure_modes || [],
    mechanism: rule.mechanism,
    evidence,
    missing_information: missing,
    likelihood_level: likelihood,
    likelihood_label: LEVEL_LABEL[likelihood] || likelihood,
    impact_level: rule.impact,
    impact_label: LEVEL_LABEL[rule.impact] || rule.impact,
    overall_risk: overall,
    overall_label: LEVEL_LABEL[overall] || overall,
    confidence_level: confidence,
    confidence_label: CONFIDENCE_LABEL[confidence] || confidence,
    mitigation: rule.mitigation || [],
    seller_questions: rule.seller_questions || [],
    verification_method: rule.verification,
    source_references: rule.sources || [],
    evidence_level: rule.evidence_level,
    not_applicable: rule.not_applicable,
    limitations: rule.limitations || null,
    disclaimer:
      '本条是基于图片文字与通用工艺知识的风险提示，不是检测结论；' +
      (rule.limitations || '') +
      ' 「判断置信度」不等于「发生概率」。',
    category: rule.categories && rule.categories.length ? rule.categories : null,
    updated_at: rule.updated_at || UPDATED_AT
  };
}

/**
 * 一条规则都没命中时，也要诚实地产出一条"证据不足"，而不是让整个区块消失。
 * 这类条目在所有字段上都必须表明"无法判断"。
 */
function noEvidenceItem(facts, features) {
  const missing = [];
  if (!facts.category) missing.push('品类');
  if (!facts.has_fiber) missing.push('纤维成分');
  if (!facts.has_construction) missing.push('结构/工艺（接缝、领口、印花等）');
  if (!facts.weight_g_m2) missing.push('克重');
  if (!facts.care) missing.push('洗护标签');
  if (!missing.length) missing.push('可判断的设计特征（如领口结构、印花工艺）');

  return {
    id: 'insufficient-evidence',
    item_name: '现有材料不足以判断长期表现',
    garment_area: '整体（尚未锁定具体部位）',
    observed_feature: Object.keys(features.byKey).length
      ? Object.keys(features.byKey).map((k) => features.byKey[k].label).join('、')
      : '未识别到可用的设计特征',
    identified_material: facts.fiber_text || '未提供纤维成分',
    construction_feature: facts.has_construction ? '有部分结构/版型信息' : '未提供结构或工艺信息',
    possible_failure: '无法判断具体失效方式',
    failure_modes: [],
    mechanism: '老化表现取决于纤维、纱线、织物组织、缝制工艺、洗护方式与穿着强度；' + `本次材料缺少 ${missing.join('、')}，因此无法把风险落到具体部位。`,
    evidence: [],
    missing_information: missing,
    likelihood_level: 'unknown',
    likelihood_label: LEVEL_LABEL.unknown,
    impact_level: 'unknown',
    impact_label: LEVEL_LABEL.unknown,
    overall_risk: 'insufficient',
    overall_label: LEVEL_LABEL.insufficient,
    confidence_level: 'unknown',
    confidence_label: CONFIDENCE_LABEL.unknown,
    mitigation: ['补充吊牌/水洗标照片（成分、执行标准、洗护）', '补一张领口、袖口或接缝的近景', '向商家索取面料参数与检测资料'],
    seller_questions: ['这款的成分、克重与洗护要求是什么？', '有耐磨/抗起球/色牢度等测试结果吗？'],
    verification_method: '看吊牌与水洗标；要求商家提供检测报告首页',
    source_references: ['通用纺织与服装工艺知识（非标准条文、非检测数据）'],
    evidence_level: 'general_knowledge',
    not_applicable: null,
    limitations: '信息不足时不代表商品较差，也不代表没有风险：本条只表示"判断不了"。',
    disclaimer:
      '这是一条"证据不足"的提示，不是风险评估结果。「证据不足」不等于低风险，也不等于高风险。' +
      '补充材料后才能给出更具体的判断。',
    category: null,
    updated_at: UPDATED_AT
  };
}

/* ───────────────── 区域分布 ───────────────── */

function outlineOf(category) {
  if (!category) return 'generic';
  if (/裤|牛仔|短裤/.test(category)) return 'bottom';
  if (/裙|连衣裙/.test(category)) return 'dress';
  if (/外套|大衣|西装|风衣|夹克|羽绒/.test(category)) return 'outer';
  if (/T恤|卫衣|衬衫|羊毛衫|内衣|瑜伽|运动/.test(category)) return 'top';
  return 'generic';
}

function buildRegions(category, items) {
  const known = CATEGORY_REGIONS[category] || ['领口', '袖口', '下摆', '接缝', '图案与装饰'];
  const used = [];
  const regions = known.map((name) => {
    const hits = items.filter((it) => {
      const matched = it.garment_area.indexOf(name) >= 0 || (name === '接缝' && /接缝|拼接|缝合/.test(it.garment_area));
      if (matched) used.push(it.id);
      return matched;
    });
    return regionOf(name, hits);
  });

  // 没有落进任何已知区域的条目（例如"腋下 / 袖内侧"），单独列出，避免信息被吞掉
  const extras = new Map();
  for (const it of items) {
    if (used.indexOf(it.id) >= 0) continue;
    const area = it.garment_area.split(' / ')[0];
    if (!extras.has(area)) extras.set(area, []);
    extras.get(area).push(it);
  }
  for (const [area, hits] of extras) regions.push(regionOf(area, hits));

  return {
    outline: outlineOf(category),
    regions,
    note:
      '标记只表示"该位置有风险条目或值得重点观察"，不代表已检查、也不代表没有标记的区域就没有风险。' +
      '本次图片是否覆盖这些位置、内部结构与接缝细节，系统无法确认。'
  };
}

function regionOf(name, hits) {
  const worst = hits
    .map((h) => h.overall_risk)
    .sort((a, b) => (SEVERITY_ORDER[a] === undefined ? 9 : SEVERITY_ORDER[a]) - (SEVERITY_ORDER[b] === undefined ? 9 : SEVERITY_ORDER[b]))[0];
  return {
    name,
    level: worst || 'none',
    level_label: worst ? LEVEL_LABEL[worst] || worst : '未发现相关条目',
    item_ids: hits.map((h) => h.id),
    inspected: false
  };
}

/* ───────────────── 时间轴（定性，不给寿命） ───────────────── */

function buildTimeline(ctx, items) {
  const areas = Array.from(new Set(items.slice(0, 4).map((i) => i.garment_area))).slice(0, 4);
  const care = ctx.facts.care;
  const print = ctx.features.byKey.big_print || ctx.features.byKey.embroidery_beads;
  return [
    {
      stage: '初始状态',
      title: '现在能看到的',
      text:
        `已知结构：${Object.keys(ctx.features.byKey).length ? Object.keys(ctx.features.byKey).map((k) => ctx.features.byKey[k].label).join('、') : '未识别到明确的设计特征'}。` +
        (ctx.facts.fiber_text ? `成分标注为 ${ctx.facts.fiber_text}（商家标注）。` : '成分未提供。')
    },
    {
      stage: '使用与摩擦',
      title: '最先受力的位置',
      text: areas.length
        ? `${areas.join('、')}是这类商品最先出现变化的部位：反复摩擦、拉伸或弯折会让纤维与缝线逐步疲劳。`
        : '暂未识别出明确的受力集中位置。'
    },
    {
      stage: '洗护',
      title: '洗护决定老化速度',
      text: care
        ? `标签要求：${care}。按标签洗护可以明显降低变形、起球与开裂的速度；违反标签要求通常是老化的加速器。`
        : '没有洗护标签信息；按更保守的方式（低温、温和、翻面、阴干）通常更安全。' + (print ? '带印花或装饰件的商品尤其要翻面洗涤。' : '')
    },
    {
      stage: '长期外观',
      title: '可能被察觉的变化',
      text: items.length
        ? `值得定期观察：${items.slice(0, 3).map((i) => i.garment_area).join('、')}的颜色是否均匀、是否起球或变形。`
        : '暂无可列的观察点。'
    },
    {
      stage: '实际反馈',
      title: '穿过之后才知道的部分',
      text: '洗涤与穿着次数、使用强度、环境湿度都会影响实际表现。建议记录第一次洗后的尺寸与外观，作为后续判断基线。'
    }
  ];
}

/* ───────────────── 长期外观与使用价值（与物理耐久分开） ───────────────── */

function buildAppearance(ctx, items) {
  const durability = items
    .filter((i) => i.overall_risk === 'high' || i.overall_risk === 'medium')
    .slice(0, 4)
    .map((i) => ({ area: i.garment_area, text: i.possible_failure, level: i.overall_risk }));
  const durabilityInsufficient = items.filter((i) => i.overall_risk === 'insufficient').length;

  const style = [];
  const f = ctx.features.byKey;
  if (f.big_print) {
    style.push({
      title: '图案辨识度较高',
      text: '大面积图案的视觉重心集中，搭配时可考虑用素色下装或外套平衡；与其它图案叠穿时更依赖比例控制。若你更看重多年自由搭配，可与素色/小图案款对比。',
      level: 'info'
    });
  }
  if (f.embroidery_beads) {
    style.push({
      title: '装饰元素较多',
      text: '装饰件会缩小适用场景（更适合特定场合），同时增加洗护时勾挂的可能。若以日常高频穿着为主，可优先考虑装饰更克制的款式。',
      level: 'info'
    });
  }
  if (f.splice_multi) {
    style.push({
      title: '拼接/拼色设计',
      text: '拼色与拼接能提升辨识度，但也意味着不同区域的老化节奏可能不一致（颜色、收缩、起球会分开发生），长期外观可能出现"局部与整体不同步"。',
      level: 'info'
    });
  }
  if (!style.length) {
    style.push({
      title: '设计相对克制',
      text: '本次材料中没有识别到大面积图案、密集装饰或拼接设计，搭配灵活度通常较高；这不是质量结论，只是外观风格的中性描述。',
      level: 'info'
    });
  }

  return {
    durability,
    durability_note: durabilityInsufficient
      ? `另有 ${durabilityInsufficient} 项因缺少材料/结构/检测信息无法判断，与"低风险"不是一回事。`
      : '物理耐久性相关条目见上方风险列表。',
    style,
    disclaimer:
      '本节只做"是否容易显旧/是否容易搭配"的中性描述，不评价审美高低，也不把设计感等同于不耐穿。' +
      '流行元素、个人风格与穿着场景差异很大，最终取舍由你决定。'
  };
}

/* ───────────────── 补图建议 ───────────────── */

function buildEvidenceGaps(ctx, items) {
  const gaps = new Map();
  for (const it of items) {
    for (const need of it.missing_information || []) {
      if (!gaps.has(need)) gaps.set(need, { what: need, why: [], items: [] });
      const g = gaps.get(need);
      if (g.items.indexOf(it.item_name) < 0) g.items.push(it.item_name);
      const why = `用于判断「${it.garment_area}」的风险：${it.possible_failure.split('；')[0]}`;
      if (g.why.indexOf(why) < 0) g.why.push(why);
    }
  }
  return Array.from(gaps.values()).slice(0, 6).map((g) => ({
    what: g.what,
    why: g.why.slice(0, 2).join('；'),
    how: /近景|图片/.test(g.what) ? '拍一张能看清结构与纹理的局部照片（可以只拍这一处）' : '向商家索取参数或检测资料，或在吊牌/水洗标上核对'
  }));
}

/* ───────────────── 一句话总结 ───────────────── */

function buildSummary(ctx, items, gaps) {
  if (!items.length) {
    return '本次材料没有识别到可判断的设计或工艺特征，因此无法给出老化风险提示。' +
      '这不等于"没有问题"，只说明现有信息不足以支撑任何判断。';
  }
  const high = items.filter((i) => i.overall_risk === 'high');
  const medium = items.filter((i) => i.overall_risk === 'medium');
  const insufficient = items.filter((i) => i.overall_risk === 'insufficient');

  const areas = Array.from(new Set(items.map((i) => i.garment_area))).slice(0, 3).join('、');
  const parts = [];
  if (high.length) {
    parts.push(`最值得关注的是${Array.from(new Set(high.map((i) => i.garment_area))).slice(0, 2).join('、')}`);
  } else if (medium.length) {
    parts.push(`目前值得关注的是${areas}`);
  } else {
    parts.push(`目前能在${areas}看到一些需要留意的设计特征`);
  }

  if (insufficient.length) {
    parts.push(`其中 ${insufficient.length} 项因缺少材料或工艺信息暂时无法判断（不是"没问题"）`);
  }

  if (gaps.length) {
    parts.push(`补充${gaps.slice(0, 2).map((g) => g.what).join('、')}可以明显提高判断的可靠度`);
  }

  parts.push('如果商家无法提供这些资料，就把它们当作"尚未验证的风险"，而不是确定的质量问题。');
  return parts.join('，').replace(/，+/g, '，').replace(/。+$/, '') + '。';
}

/* ───────────────── 入口 ───────────────── */

/**
 * @param {{fields: object, rawText?: string, profile?: object}} input
 */
function buildWearReport(input) {
  const fields = (input && input.fields) || {};
  const rawText = String((input && input.rawText) || '');
  const facts = materialFacts(fields);
  const features = detectFeatures({ fields, rawText });

  const ctx = {
    fields,
    rawText,
    facts,
    category: facts.category,
    features,
    fiberText: facts.fiber_text
  };

  const items = [];
  const skipped = [];
  for (const rule of RULES) {
    const m = matches(rule, ctx);
    if (!m.matched) {
      if (m.reason !== '品类不符' && m.reason !== '品类未知') skipped.push({ id: rule.id, reason: m.reason });
      continue;
    }
    items.push(buildItem(rule, ctx));
  }

  // 一条都没命中：给一条明确的"证据不足"，而不是让区块空着
  if (!items.length) {
    items.push(noEvidenceItem(facts, features));
  }

  // 排序：高风险 → 中 → 证据不足 → 低；同级按影响程度
  const impactRank = { high: 0, medium: 1, low: 2, unknown: 3 };
  items.sort((a, b) => {
    const ra = SEVERITY_ORDER[a.overall_risk] === undefined ? 9 : SEVERITY_ORDER[a.overall_risk];
    const rb = SEVERITY_ORDER[b.overall_risk] === undefined ? 9 : SEVERITY_ORDER[b.overall_risk];
    return ra - rb || (impactRank[a.impact_level] || 3) - (impactRank[b.impact_level] || 3);
  });

  const gaps = buildEvidenceGaps(ctx, items);
  const counts = {
    high: items.filter((i) => i.overall_risk === 'high').length,
    medium: items.filter((i) => i.overall_risk === 'medium').length,
    low: items.filter((i) => i.overall_risk === 'low').length,
    insufficient: items.filter((i) => i.overall_risk === 'insufficient').length
  };

  return {
    available: items.length > 0,
    title: '穿久了会怎么样？',
    subtitle: '基于已知材料、结构与工艺的风险提示；不是检测报告，也不预测具体寿命',
    features: features.features,
    facts: {
      category: facts.category,
      fiber: facts.fiber_text,
      weight_g_m2: facts.weight_g_m2,
      care: facts.care,
      has_construction: facts.has_construction
    },
    items,
    counts,
    summary: buildSummary(ctx, items, gaps),
    timeline: buildTimeline(ctx, items),
    appearance: buildAppearance(ctx, items),
    regions: buildRegions(facts.category, items),
    evidence_gaps: gaps,
    seller_questions: Array.from(new Set(items.flatMap((i) => i.seller_questions || []))).slice(0, 8),
    skipped_rules: skipped.slice(0, 12),
    disclaimer:
      '本区块只做风险提示：不预测具体使用年限、洗涤次数或坏损概率，也不把材料常见特征当成每件商品都会出现的结果。' +
      '要得到确定结论，需要检测报告、实物核对与你的实际穿着记录。',
    confidence_note: '「判断置信度」表示我们对这条判断有多少依据，不等于发生概率。',
    rule_count: RULES.length,
    updated_at: UPDATED_AT
  };
}

module.exports = { buildWearReport, IMPACT_MATRIX, LEVEL_LABEL, CONFIDENCE_LABEL, outlineOf };
