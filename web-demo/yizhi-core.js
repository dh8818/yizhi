/* 自动生成，请勿手工编辑：node scripts/build-web.js */
(function () {
  'use strict';
  var defs = {};
  var cache = {};
  defs["core/pipeline.js"] = function (module, exports, require) {
/**
 * pipeline：把 OCR → 提取 → 证据合并 → 规则/报告 串成一条**纯函数**流水线。
 *
 * 小程序（local 模式）和 Node 服务端都调用这里，保证两端结果一致。
 * 任何 IO（上传、存储、网络）都不在这一层。
 */

'use strict';

const { extractFromOcr } = require('./extractor');
const { mergeFieldSets, applyUserCorrection } = require('./evidence');
const { buildReport } = require('./report');
const { FIELD_STATUS, SOURCE_TYPE, makeField } = require('./fields');

/**
 * 单次分析：一张或多张图片的 OCR 结果 → 分析卡数据。
 *
 * @param {object} input
 * @param {{images: Array<object>}} input.ocr
 * @param {object} [input.profile]
 * @param {object} [input.meta] { mode, demo, images, analysis_id, created_at }
 * @param {object} [input.corrections] 用户修正 { field_key: {normalized_value, unit?, note?} }
 * @param {object} [input.manualFields] 手填字段（makeField 结构，status=user_confirmed）
 */
function analyze(input) {
  const ocr = (input && input.ocr) || { images: [] };
  const images = ocr.images || [];

  // 按图片类型分别提取后合并：宣传页 / 标签页 / 尺码表 的证据效力不同，
  // 先各自提取再 merge，才能保留"同一字段不同来源"的冲突信息。
  const groups = {};
  for (const img of images) {
    const kind = img.kind || SOURCE_TYPE.PROMO_SCREENSHOT;
    groups[kind] = groups[kind] || [];
    groups[kind].push(img);
  }

  let fields = {};
  const notes = [];
  for (const [kind, imgs] of Object.entries(groups)) {
    const extracted = extractFromOcr({ images: imgs });
    fields = mergeFieldSets(fields, extracted.fields);
    notes.push(...extracted.notes.map((n) => `[${kind}] ${n}`));
  }

  // 用户手填字段：user_confirmed 优先，历史识别值保留在 alternatives
  if (input && input.manualFields) {
    fields = mergeFieldSets(fields, input.manualFields);
  }

  // 用户修正：优先级最高，但历史值保留
  const corrections = (input && input.corrections) || {};
  for (const [key, patch] of Object.entries(corrections)) {
    if (!patch) continue;
    fields[key] = applyUserCorrection(fields[key] || makeField({ field_key: key }), patch);
  }

  const rawText = images
    .reduce((acc, img) => acc.concat((img.blocks || []).map((b) => b.text)), [])
    .join('\n');

  const report = buildReport({
    fields,
    profile: input && input.profile,
    rawText,
    meta: (input && input.meta) || {}
  });

  return { fields, report, notes };
}

/**
 * 只做提取，不生成报告（用于「补充图片」后增量展示）。
 */
function extractOnly(ocr) {
  const images = (ocr && ocr.images) || [];
  let fields = {};
  for (const img of images) {
    const one = extractFromOcr({ images: [img] });
    fields = mergeFieldSets(fields, one.fields);
  }
  return fields;
}

/** 空字段集（用于纯手填流程） */
function emptyFields() {
  const keys = [
    'product_name', 'brand', 'category', 'price', 'fiber_composition', 'fabric_weight', 'garment_weight',
    'yarn_count', 'weave_structure', 'elasticity', 'fit_description', 'size_range', 'size_chart',
    'standard_code', 'safety_category', 'care_instructions', 'test_report'
  ];
  const out = {};
  for (const k of keys) {
    out[k] = makeField({ field_key: k, status: FIELD_STATUS.MISSING, source_type: SOURCE_TYPE.NOT_PROVIDED });
  }
  return out;
}

module.exports = { analyze, extractOnly, emptyFields };

  };
  defs["core/extractor.js"] = function (module, exports, require) {
/**
 * product-extractor：把 OCR 文本块提取成结构化字段。
 *
 * 这是一个**确定性**提取器（正则 + 关键词 + 上下文校验），不是大模型。
 * 好处：可测试、可解释、离线可用；大模型只在 ai/vision-adapter 里作为另一种
 * 提取实现存在，两者输出同一套字段结构。
 *
 * 输入约定（ocr-service 的输出）：
 * {
 *   images: [{
 *     id, kind: 'promo_screenshot'|'physical_label'|'size_chart'|'detail_photo',
 *     blocks: [{ text, confidence?, box?: [x,y,w,h] }]
 *   }]
 * }
 */

'use strict';

const { FIELD_STATUS, SOURCE_TYPE, makeField } = require('./fields');
const {
  tidy,
  normalizeStandardCode,
  normalizeFiberComposition,
  normalizeWeight,
  normalizeYarnCount,
  normalizePrice,
  normalizeSizeChart
} = require('./normalize');

const CATEGORY_KEYWORDS = [
  ['羽绒服', ['羽绒服', '鹅绒', '鸭绒']],
  ['大衣', ['大衣', '毛呢外套']],
  ['风衣', ['风衣', 'trench']],
  ['夹克', ['夹克', '工装外套', '冲锋衣', '机车服', '飞行员夹克']],
  ['西装', ['西装', '西服', 'blazer']],
  ['羊毛衫', ['羊毛衫', '毛衣', '针织衫', '羊绒衫']],
  ['卫衣', ['卫衣', '连帽衫']],
  ['T恤', ['T恤', 't恤', '短袖', 'tee', 'POLO', 'Polo', 'polo']],
  ['衬衫', ['衬衫', '衬衣', 'shirt']],
  ['连衣裙', ['连衣裙', '长裙', 'dress']],
  ['半身裙', ['半身裙', '半裙', 'skirt']],
  ['牛仔裤', ['牛仔裤', '牛仔']],
  ['休闲裤', ['休闲裤', '长裤', '西裤', '工装裤']],
  ['短裤', ['短裤', '五分裤']],
  ['运动裤', ['运动裤', '束脚裤', '瑜伽裤', '紧身裤', '打底裤']],
  ['瑜伽/运动紧身衣', ['瑜伽', '紧身', '速干']],
  ['外套', ['外套', '棉服', '派克', '滑雪服']],
  ['内衣', ['内衣', '文胸', 'bra']],
  ['袜品', ['袜子', '袜']],
  ['围巾/披肩', ['围巾', '披肩']]
];

const LABELS = {
  standard: ['执行标准', '产品标准', '标准号', '执行标准号', '执行国标', 'GB', 'FZ', 'QB'],
  safety: ['安全类别', '安全技术类别', '类别'],
  fiber: ['纤维成分', '成分', '面料', '材质', '纤维含量'],
  weight: ['克重', '面料克重', '单位面积质量', '重量', '净重'],
  yarn: ['支数', '纱支', '纱线支数', 'S/2', 'Nm'],
  price: ['¥', '￥', '价格', '售价', '到手价', '活动价'],
  size: ['尺码', '可选尺码', '尺寸', '版型'],
  care: ['洗涤', '洗护', '不可漂白', '干洗', '熨烫', '水洗', '护理'],
  report: ['检测报告', '质检报告', '检验报告', '合格证', '检测机构'],
  brand: ['品牌', '品牌名']
};

function norm(text) {
  return tidy(text).toLowerCase();
}

function includesAny(text, words) {
  const t = norm(text);
  return words.some((w) => t.indexOf(w.toLowerCase()) >= 0);
}

/** 从整组文本块猜品类。命中越具体越靠前。 */
function guessCategory(allText) {
  for (const [category, words] of CATEGORY_KEYWORDS) {
    for (const w of words) {
      if (norm(allText).indexOf(w.toLowerCase()) >= 0) {
        return { category, matched: w };
      }
    }
  }
  return null;
}

/** 从 "¥199" / "价格：199" 之类里取价格，优先带货币符号的行 */
function findPrice(blocks) {
  for (const b of blocks) {
    const t = tidy(b.text);
    if (/[¥￥]\s*\d/.test(t)) {
      return { raw: t, confidence: b.confidence };
    }
  }
  for (const b of blocks) {
    const t = tidy(b.text);
    if (/(价格|售价|到手价|活动价)\s*[:：]?\s*\d/.test(t)) {
      return { raw: t, confidence: b.confidence };
    }
  }
  return null;
}

function findStandardCode(labelBlocks, promoBlocks, tagged) {
  const collect = (list, fromLabel) => {
    const strong = [];
    const weak = [];
    for (const b of list) {
      const t = tidy(b.text);
      const re = /(GB\/T|GB\/Z|GB|FZ\/T|FZ|QB\/T|HG\/T|SN\/T)\s*\d+(?:\.\d+)*\s*[-—–]?\s*\d{0,4}/gi;
      let m;
      while ((m = re.exec(t)) !== null) {
        const item = { raw: m[0], text: t, confidence: b.confidence, from_label: fromLabel };
        if (includesAny(t, ['执行标准', '产品标准', '标准号', '符合'])) strong.push(item);
        else weak.push(item);
      }
    }
    return { strong, weak };
  };
  // 吊牌/水洗标上的标准号效力最高；宣传页只在标签缺失时使用
  const fromLabel = collect(labelBlocks, true);
  if (fromLabel.strong.length) return fromLabel.strong;
  if (fromLabel.weak.length) return fromLabel.weak;
  const fromPromo = collect(promoBlocks, false);
  if (fromPromo.strong.length) return fromPromo.strong;
  if (fromPromo.weak.length) return fromPromo.weak;
  const all = collect(tagged, false);
  return all.strong.length ? all.strong : all.weak;
}

function findSafetyCategory(blocks) {
  for (const b of blocks) {
    const t = tidy(b.text);
    const m = t.match(/([ABC])\s*类/);
    if (m) {
      const ctx = /31701/.test(t) ? 'GB 31701' : /18401/.test(t) ? 'GB 18401' : null;
      return { raw: t, level: m[1], basis: ctx, confidence: b.confidence };
    }
  }
  return null;
}

/**
 * 成分可能分散在多个块里（面料、里料、填充物），所以把相关块拼起来再解析，
 * 这样 parts 结构不会丢。优先级：实物标签 > 宣传页 > 全量。
 */
function findFiber(labelBlocks, promoBlocks, tagged) {
  const pick = (list, fromLabel) => {
    const hits = list.filter((b) => /%/.test(tidy(b.text)) && (includesAny(b.text, LABELS.fiber) || /\d{1,3}\s*%/.test(tidy(b.text))));
    if (!hits.length) return null;
    const merged = hits.slice(0, 4).map((b) => tidy(b.text)).join('\n');
    const parsed = normalizeFiberComposition(merged);
    if (!parsed.items.length) return null;
    return { raw: merged, parsed, confidence: hits[0].confidence, from_label: fromLabel };
  };
  return pick(labelBlocks, true) || pick(promoBlocks, false) || pick(tagged, false);
}

function findLabelled(blocks, words) {
  for (const b of blocks) {
    const t = tidy(b.text);
    if (includesAny(t, words)) return { raw: t, confidence: b.confidence };
  }
  return null;
}

function findFit(blocks) {
  const fitWords = ['宽松', 'oversize', 'Oversize', '直筒', '修身', '紧身', '常规版型', '落肩', '正肩', '廓形'];
  for (const b of blocks) {
    const t = tidy(b.text);
    const hit = fitWords.find((w) => t.indexOf(w) >= 0);
    if (hit && (includesAny(t, ['版型', '款型', '版', '设计']) || t.length < 24)) {
      return { raw: t, fit: hit, confidence: b.confidence };
    }
  }
  return null;
}

function findSizeRange(blocks) {
  for (const b of blocks) {
    const t = tidy(b.text);
    const m = t.match(/(XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL|4XL)\s*[-~至到]\s*(XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL|4XL)/);
    if (m) return { raw: t, range: `${m[1]}-${m[2]}`, confidence: b.confidence };
    if (includesAny(t, ['可选尺码', '尺码']) && /(S|M|L|XL)/.test(t)) {
      return { raw: t, range: t.replace(/^.*?[:：]/, '').trim(), confidence: b.confidence };
    }
  }
  return null;
}

/** 参数行特征：带冒号/单位的行不是商品标题 */
const PARAM_LINE = /(成分|含量|克重|重量|标准|型号|规格|尺码|尺寸|价格|售价|品牌|安全类别|纱支|支数|面料|里料|洗涤|维护|产地|执行)/;

/** 短、纯文字、且不是参数行的块，作为商品名称候选 */
function guessProductName(blocks) {
  const skipped = /(¥|￥|折|券|包邮|销量|评价|收藏|加入购物车|立即购买|七天|退货|客服|发货|库存)/;
  const candidates = blocks
    .map((b) => ({ text: tidy(b.text), confidence: b.confidence, index: blocks.indexOf(b) }))
    .filter((b) => {
      const t = b.text;
      if (t.length < 4 || t.length > 40) return false;
      if (skipped.test(t)) return false;
      if (PARAM_LINE.test(t) && /[:：]/.test(t)) return false;
      if (/^[\d.\s%*/-]+$/.test(t)) return false;
      return true;
    });
  if (!candidates.length) return null;

  const scored = candidates
    .map((b) => {
      let score = 0;
      if (/(T恤|衬衫|连衣裙|裤|大衣|外套|卫衣|毛衣|针织|西服|风衣|背心|半裙|短裤|羽绒)/.test(b.text)) score += 3;
      if (/(新款|同款|春夏|秋冬|修身|宽松|纯棉|男|女|款)/.test(b.text)) score += 1;
      if (b.text.length >= 8 && b.text.length <= 30) score += 1;
      score += Math.min(2, Math.max(0, (b.confidence || 0.6) - 0.6) * 5);
      score -= b.index * 0.35; // 越靠前越可能是标题
      return { ...b, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0].text;
}

/** 依据 OCR 置信度和命中上下文给出"提取强度"，仅供排序，不当概率用 */
function estimateConfidence(rawConfidence, { labelled }) {
  const base = typeof rawConfidence === 'number' ? rawConfidence : 0.6;
  const adjust = labelled ? 0.08 : 0;
  return Math.min(0.95, Math.max(0.3, Math.round((base + adjust) * 100) / 100));
}

/** 所有会被产出的字段（缺失时也要显式写 missing，界面才能区分"没提供"与"解析失败"） */
const EMPTY_KEYS = [
  'product_name', 'brand', 'category', 'price', 'fiber_composition', 'fabric_weight',
  'yarn_count', 'weave_structure', 'elasticity', 'fit_description', 'size_range', 'size_chart',
  'standard_code', 'safety_category', 'care_instructions', 'test_report'
];

/**
 * @param {{images: Array<{id:string, kind:string, blocks:Array<{text:string, confidence?:number, box?:number[]}>}>}} ocr
 * @returns {{fields: Object<string, object>, images: Array<object>, notes: string[]}}
 */
function extractFromOcr(ocr) {
  const images = (ocr && ocr.images) || [];
  const fields = {};
  const notes = [];

  // 汇总所有块，但保留 block -> image 的映射，便于记录 source_image_id
  const tagged = [];
  for (const img of images) {
    for (const b of img.blocks || []) {
      tagged.push({ text: b.text, confidence: b.confidence, box: b.box, image_id: img.id, kind: img.kind });
    }
  }
  const allText = tagged.map((b) => b.text).join(' ');
  const promoBlocks = tagged.filter((b) => b.kind === SOURCE_TYPE.PROMO_SCREENSHOT);
  const labelBlocks = tagged.filter((b) => b.kind === SOURCE_TYPE.PHYSICAL_LABEL);
  const chartBlocks = tagged.filter((b) => b.kind === SOURCE_TYPE.SIZE_CHART);

  if (!tagged.length) {
    notes.push('OCR 未返回任何文本块');
    for (const k of EMPTY_KEYS) {
      fields[k] = makeField({ field_key: k, status: FIELD_STATUS.MISSING, source_type: SOURCE_TYPE.NOT_PROVIDED });
    }
    return { fields, images, notes };
  }

  /* 品类 */
  const cat = guessCategory(allText);
  if (cat) {
    fields.category = makeField({
      field_key: 'category',
      normalized_value: cat.category,
      raw_text: cat.matched,
      status: FIELD_STATUS.EXTRACTED,
      source_type: (promoBlocks[0] || tagged[0]).kind,
      source_image_id: (promoBlocks[0] || tagged[0]).image_id,
      confidence: 0.7,
      evidence_note: `在文本中命中品类关键词「${cat.matched}」，属于关键词归类，不是官方类目`
    });
  }

  /* 商品名称（只在宣传页里找；吊牌/水洗标不提供商品名称） */
  const name = promoBlocks.length ? guessProductName(promoBlocks) : null;
  if (name) {
    fields.product_name = makeField({
      field_key: 'product_name',
      normalized_value: name,
      raw_text: name,
      status: FIELD_STATUS.EXTRACTED,
      source_type: SOURCE_TYPE.PROMO_SCREENSHOT,
      confidence: 0.55,
      evidence_note: '从标题类文本中选取，未经权威字段确认，建议核对'
    });
  }

  /* 品牌 */
  const brandBlock = findLabelled(tagged, LABELS.brand);
  if (brandBlock) {
    const value = brandBlock.raw.replace(/^.*?(品牌|品牌名)\s*[:：]?/, '').trim();
    if (value) {
      fields.brand = makeField({
        field_key: 'brand',
        normalized_value: value,
        raw_text: brandBlock.raw,
        status: FIELD_STATUS.EXTRACTED,
        source_type: SOURCE_TYPE.PROMO_SCREENSHOT,
        confidence: estimateConfidence(brandBlock.confidence, { labelled: true })
      });
    }
  }

  /* 价格 */
  const price = findPrice(tagged);
  if (price) {
    const p = normalizePrice(price.raw);
    if (p.value != null) {
      fields.price = makeField({
        field_key: 'price',
        normalized_value: p.value,
        raw_text: price.raw,
        unit: '元',
        status: FIELD_STATUS.EXTRACTED,
        source_type: SOURCE_TYPE.PROMO_SCREENSHOT,
        confidence: estimateConfidence(price.confidence, { labelled: true }),
        evidence_note: p.note || '价格来自当前截图，可能随促销变化'
      });
    }
  }

  /* 纤维成分：标签页优先于宣传页 */
  const fiber = findFiber(labelBlocks, promoBlocks, tagged);
  if (fiber) {
    const partsText =
      fiber.parsed.parts.length > 1
        ? fiber.parsed.parts
            .map((p) => `${p.part || '整体'} ${p.items.map((i) => `${i.fiber} ${i.percent}%`).join(' / ')}`)
            .join('；')
        : fiber.parsed.items.map((i) => `${i.fiber} ${i.percent}%`).join(' / ');
    fields.fiber_composition = makeField({
      field_key: 'fiber_composition',
      normalized_value: partsText,
      raw_text: fiber.raw,
      status: FIELD_STATUS.EXTRACTED,
      source_type: fiber.from_label ? SOURCE_TYPE.PHYSICAL_LABEL : SOURCE_TYPE.PROMO_SCREENSHOT,
      confidence: estimateConfidence(fiber.confidence, { labelled: true }),
      evidence_note:
        '这是商家标注的纤维含量；标注不等于实测，' +
        (fiber.parsed.complete ? '各部件比例合计约 100%' : fiber.parsed.note || '比例合计不完整')
    });
    if (!fiber.parsed.complete) fields.fiber_composition.status = FIELD_STATUS.PENDING_VERIFICATION;
    fields.fiber_composition.parsed = { items: fiber.parsed.items, parts: fiber.parsed.parts, total: fiber.parsed.total };
  }

  /* 克重 / 成衣重量 */
  const weightBlock = findLabelled(tagged, LABELS.weight);
  if (weightBlock) {
    const w = normalizeWeight(weightBlock.raw);
    if (w) {
      fields.fabric_weight = makeField({
        field_key: w.kind === 'garment_weight' ? 'garment_weight' : 'fabric_weight',
        normalized_value: w.value,
        raw_text: weightBlock.raw,
        unit: w.unit,
        status: w.kind === 'ambiguous' ? FIELD_STATUS.PENDING_VERIFICATION : FIELD_STATUS.EXTRACTED,
        source_type: SOURCE_TYPE.PROMO_SCREENSHOT,
        confidence: estimateConfidence(weightBlock.confidence, { labelled: true }),
        evidence_note: w.note
      });
    }
  }

  /* 支数 */
  const yarnBlock = findLabelled(tagged, LABELS.yarn);
  if (yarnBlock) {
    const y = normalizeYarnCount(yarnBlock.raw);
    if (y) {
      fields.yarn_count = makeField({
        field_key: 'yarn_count',
        normalized_value: `${y.value}${y.system ? ' ' + y.system : ''}`,
        raw_text: yarnBlock.raw,
        status: y.system ? FIELD_STATUS.EXTRACTED : FIELD_STATUS.PENDING_VERIFICATION,
        source_type: SOURCE_TYPE.PROMO_SCREENSHOT,
        confidence: estimateConfidence(yarnBlock.confidence, { labelled: true }),
        evidence_note: y.note
      });
    }
  }

  /* 执行标准号 */
  const codes = findStandardCode(labelBlocks, promoBlocks, tagged);
  if (codes.length) {
    const chosen = codes[0];
    const n = normalizeStandardCode(chosen.raw);
    fields.standard_code = makeField({
      field_key: 'standard_code',
      normalized_value: n.code,
      raw_text: chosen.text || chosen.raw,
      status: n.has_year ? FIELD_STATUS.EXTRACTED : FIELD_STATUS.PENDING_VERIFICATION,
      source_type: chosen.from_label ? SOURCE_TYPE.PHYSICAL_LABEL : SOURCE_TYPE.PROMO_SCREENSHOT,
      confidence: estimateConfidence(chosen.confidence, { labelled: true }),
      evidence_note: n.note || '标准号按原文记录；是否现行、是否适用于本品需另外核验',
      alternatives: codes.slice(1).map((c) => ({ raw_text: c.text || c.raw, normalized_value: normalizeStandardCode(c.raw).code }))
    });
  }

  /* 安全类别 */
  const safety = findSafetyCategory(tagged);
  if (safety) {
    fields.safety_category = makeField({
      field_key: 'safety_category',
      normalized_value: `${safety.level}类`,
      raw_text: safety.raw,
      status: FIELD_STATUS.EXTRACTED,
      source_type: SOURCE_TYPE.PHYSICAL_LABEL,
      confidence: estimateConfidence(safety.confidence, { labelled: true }),
      evidence_note: safety.basis
        ? `原文同时出现 ${safety.basis}，按原文记录；类别适用性需按标准正文核对`
        : '原文只出现类别字母，未出现标准号，需确认依据'
    });
  }

  /* 版型 */
  const fit = findFit(tagged);
  if (fit) {
    fields.fit_description = makeField({
      field_key: 'fit_description',
      normalized_value: fit.fit,
      raw_text: fit.raw,
      status: FIELD_STATUS.EXTRACTED,
      source_type: SOURCE_TYPE.PROMO_SCREENSHOT,
      confidence: estimateConfidence(fit.confidence, { labelled: false }),
      evidence_note: '版型描述来自商家文案，不等于实测成衣尺寸'
    });
  }

  /* 尺码范围 */
  const sizeRange = findSizeRange(tagged);
  if (sizeRange) {
    fields.size_range = makeField({
      field_key: 'size_range',
      normalized_value: sizeRange.range,
      raw_text: sizeRange.raw,
      status: FIELD_STATUS.EXTRACTED,
      source_type: SOURCE_TYPE.PROMO_SCREENSHOT,
      confidence: estimateConfidence(sizeRange.confidence, { labelled: false })
    });
  }

  /* 尺码表 */
  const chartBlocks2 = chartBlocks.length ? chartBlocks : tagged.filter((b) => /(胸围|肩宽|衣长|腰围|袖长)/.test(b.text) && /\d{2,3}/.test(b.text));
  if (chartBlocks2.length) {
    const chartText = chartBlocks2.map((b) => b.text).join('\n');
    const chart = normalizeSizeChart(chartText);
    if (chart.sizes.length) {
      fields.size_chart = makeField({
        field_key: 'size_chart',
        normalized_value: chart.sizes,
        raw_text: chartText.slice(0, 800),
        status: chart.sizes.some((s) => Object.keys(s.measurements).length === 0)
          ? FIELD_STATUS.PENDING_VERIFICATION
          : FIELD_STATUS.EXTRACTED,
        source_type: SOURCE_TYPE.SIZE_CHART,
        confidence: 0.6,
        evidence_note: chart.notes.length ? chart.notes.join('；') : '尺码表按文本行列还原，可能错列，请核对'
      });
    }
  }

  /* 洗护 */
  const careBlock = findLabelled(tagged, LABELS.care);
  if (careBlock) {
    fields.care_instructions = makeField({
      field_key: 'care_instructions',
      normalized_value: careBlock.raw,
      raw_text: careBlock.raw,
      status: FIELD_STATUS.EXTRACTED,
      source_type: labelBlocks.length ? SOURCE_TYPE.PHYSICAL_LABEL : SOURCE_TYPE.PROMO_SCREENSHOT,
      confidence: estimateConfidence(careBlock.confidence, { labelled: true }),
      evidence_note: '洗护信息按原文记录；符号含义解释见"洗护"区块'
    });
  }

  /* 检测报告提及 */
  const reportBlock = findLabelled(tagged, LABELS.report);
  if (reportBlock) {
    fields.test_report = makeField({
      field_key: 'test_report',
      normalized_value: '页面提及检测/质检信息',
      raw_text: reportBlock.raw,
      status: FIELD_STATUS.PENDING_VERIFICATION,
      source_type: SOURCE_TYPE.PROMO_SCREENSHOT,
      confidence: 0.5,
      evidence_note: '页面"提到"检测报告不等于报告已提供，需商家给出报告编号与检测机构'
    });
  }

  /* 未识别字段统一标 missing（不写臆造值） */
  for (const k of EMPTY_KEYS) {
    if (!fields[k]) {
      fields[k] = makeField({
        field_key: k,
        status: FIELD_STATUS.MISSING,
        source_type: SOURCE_TYPE.NOT_PROVIDED,
        updated_at: new Date().toISOString()
      });
    }
  }

  return { fields, images, notes };
}

module.exports = { extractFromOcr, guessCategory, CATEGORY_KEYWORDS };

  };
  defs["core/fields.js"] = function (module, exports, require) {
/**
 * 字段与状态字典 —— 全项目的唯一真源。
 *
 * 设计约束（对应产品规范 5.1）：
 * 1. 每个字段都必须落成结构化记录，禁止只产出一段自然语言；
 * 2. 状态是"证据状态"，不是"质量评价"；
 * 3. 置信度只是模型自评，不能当真实概率用（见 CONFIDENCE_NOTE）。
 */

'use strict';

/** 字段状态。缺省一律 missing，绝不留空字符串。 */
const FIELD_STATUS = Object.freeze({
  EXTRACTED: 'extracted', // 从图片识别得到
  USER_CONFIRMED: 'user_confirmed', // 用户确认或修正
  OFFICIAL_VERIFIED: 'official_verified', // 通过官方资料核验
  INFERRED: 'inferred', // 模型/规则推断
  MISSING: 'missing', // 当前材料未提供
  UNREADABLE: 'unreadable', // 图片中无法辨识
  CONFLICT: 'conflict', // 多来源冲突
  PENDING_VERIFICATION: 'pending_verification' // 需要进一步核实
});

/** 来源类型。证据效力排序见 SOURCE_RANK。 */
const SOURCE_TYPE = Object.freeze({
  PROMO_SCREENSHOT: 'promo_screenshot', // 商品宣传详情页截图
  PHYSICAL_LABEL: 'physical_label', // 实物吊牌 / 水洗标 / 检测报告照片
  SIZE_CHART: 'size_chart', // 尺码表截图
  DETAIL_PHOTO: 'detail_photo', // 实物或细节照片
  USER_INPUT: 'user_input', // 用户自己填写/修正
  OFFICIAL_LOOKUP: 'official_lookup', // 官方标准平台查询结果
  MODEL_INFERENCE: 'model_inference', // 模型推断
  NOT_PROVIDED: 'not_provided' // 未提供
});

/**
 * 来源证据效力（仅用于冲突时的展示排序与提示，不用于"判定真伪"）。
 * 实物标签 > 官方查询 > 尺码表 > 商品宣传页 > 模型推断。
 * 说明：宣传页是商家自述，实物标签是法定标识，二者效力不同，但都不等于检测结论。
 */
const SOURCE_RANK = Object.freeze({
  [SOURCE_TYPE.PHYSICAL_LABEL]: 40,
  [SOURCE_TYPE.OFFICIAL_LOOKUP]: 35,
  [SOURCE_TYPE.USER_INPUT]: 30,
  [SOURCE_TYPE.SIZE_CHART]: 25,
  [SOURCE_TYPE.PROMO_SCREENSHOT]: 20,
  [SOURCE_TYPE.DETAIL_PHOTO]: 15,
  [SOURCE_TYPE.MODEL_INFERENCE]: 5,
  [SOURCE_TYPE.NOT_PROVIDED]: 0
});

const STATUS_META = Object.freeze({
  [FIELD_STATUS.EXTRACTED]: { label: '已识别', tone: 'info', hint: '由图片识别得到，建议对照原图复核' },
  [FIELD_STATUS.USER_CONFIRMED]: { label: '已确认', tone: 'ok', hint: '你已确认或修正过该字段' },
  [FIELD_STATUS.OFFICIAL_VERIFIED]: { label: '已核验', tone: 'ok', hint: '已通过官方资料查询确认' },
  [FIELD_STATUS.INFERRED]: { label: '推断', tone: 'warn', hint: '由规则或模型推断，不是原文' },
  [FIELD_STATUS.MISSING]: { label: '未提供', tone: 'muted', hint: '当前材料中没有这一项' },
  [FIELD_STATUS.UNREADABLE]: { label: '识别不清', tone: 'warn', hint: '图片中的文字无法可靠辨识' },
  [FIELD_STATUS.CONFLICT]: { label: '信息冲突', tone: 'alert', hint: '不同来源的说法不一致，已保留双方证据' },
  [FIELD_STATUS.PENDING_VERIFICATION]: { label: '待核实', tone: 'warn', hint: '存在需要进一步确认的点' }
});

const SOURCE_META = Object.freeze({
  [SOURCE_TYPE.PROMO_SCREENSHOT]: { label: '商品宣传截图', is_claim: true },
  [SOURCE_TYPE.PHYSICAL_LABEL]: { label: '实物标签照片', is_claim: true },
  [SOURCE_TYPE.SIZE_CHART]: { label: '尺码表', is_claim: true },
  [SOURCE_TYPE.DETAIL_PHOTO]: { label: '实物照片', is_claim: false },
  [SOURCE_TYPE.USER_INPUT]: { label: '你填写', is_claim: false },
  [SOURCE_TYPE.OFFICIAL_LOOKUP]: { label: '官方查询', is_claim: false },
  [SOURCE_TYPE.MODEL_INFERENCE]: { label: '模型推断', is_claim: false },
  [SOURCE_TYPE.NOT_PROVIDED]: { label: '未提供', is_claim: false }
});

/** 置信度的口径声明，任何面向用户的置信度展示都必须带上它。 */
const CONFIDENCE_NOTE =
  '置信度是模型对本次提取的自评值，不是"猜对的概率"。本项目未建立校准测试集，因此不提供准确率数字。';

/**
 * 字段定义表。
 * required: 是否属于"关键信息"（影响结论强度，而不是强制用户填写）
 * group: 用于分析卡分组
 */
const FIELD_DEFS = Object.freeze([
  { key: 'product_name', name: '商品名称', group: 'basic', unit: null, required: false },
  { key: 'brand', name: '品牌', group: 'basic', unit: null, required: false },
  { key: 'category', name: '品类', group: 'basic', unit: null, required: true },
  { key: 'price', name: '价格', group: 'commerce', unit: '元', required: false },
  { key: 'fiber_composition', name: '纤维成分', group: 'fabric', unit: '%', required: true },
  { key: 'fabric_weight', name: '面料克重', group: 'fabric', unit: 'g/m²', required: false },
  { key: 'garment_weight', name: '成衣重量', group: 'fabric', unit: 'g', required: false },
  { key: 'yarn_count', name: '纱线支数', group: 'fabric', unit: null, required: false },
  { key: 'weave_structure', name: '织物组织/工艺', group: 'fabric', unit: null, required: false },
  { key: 'elasticity', name: '弹性', group: 'fabric', unit: null, required: false },
  { key: 'fit_description', name: '版型描述', group: 'size', unit: null, required: false },
  { key: 'size_range', name: '尺码范围', group: 'size', unit: null, required: false },
  { key: 'size_chart', name: '尺码表', group: 'size', unit: 'cm', required: true },
  { key: 'standard_code', name: '执行标准号', group: 'standard', unit: null, required: true },
  { key: 'safety_category', name: '产品安全类别', group: 'standard', unit: null, required: false },
  { key: 'care_instructions', name: '洗护信息', group: 'care', unit: null, required: false },
  { key: 'test_report', name: '检测报告/证书', group: 'standard', unit: null, required: false }
]);

const FIELD_DEF_MAP = FIELD_DEFS.reduce((acc, d) => {
  acc[d.key] = d;
  return acc;
}, {});

const GROUP_LABELS = Object.freeze({
  basic: '基本信息',
  commerce: '价格',
  fabric: '面料与工艺',
  size: '版型与尺码',
  standard: '标准与标识',
  care: '洗护'
});

/** 关键字段（缺失会直接降低结论强度） */
const KEY_FIELDS = FIELD_DEFS.filter((d) => d.required).map((d) => d.key);

function fieldDef(key) {
  return FIELD_DEF_MAP[key] || { key, name: key, group: 'basic', unit: null, required: false };
}

/**
 * 构造一条字段证据记录（对应规范 5.1 的全部字段）。
 * @param {object} input
 * @returns {object} 规范化的字段记录
 */
function makeField(input) {
  const def = fieldDef(input.field_key);
  const status = input.status || FIELD_STATUS.MISSING;
  const sourceType = input.source_type || SOURCE_TYPE.NOT_PROVIDED;
  return {
    field_key: input.field_key,
    field_name: input.field_name || def.name,
    group: input.group || def.group,
    raw_text: input.raw_text == null ? null : String(input.raw_text),
    normalized_value: input.normalized_value == null ? null : input.normalized_value,
    unit: input.unit === undefined ? def.unit : input.unit,
    status,
    source_type: sourceType,
    source_image_id: input.source_image_id || null,
    source_location: input.source_location || null,
    confidence: typeof input.confidence === 'number' ? clamp01(input.confidence) : null,
    evidence_note: input.evidence_note || (STATUS_META[status] ? STATUS_META[status].hint : null),
    alternatives: Array.isArray(input.alternatives) ? input.alternatives : [],
    updated_at: input.updated_at || new Date().toISOString()
  };
}

function clamp01(n) {
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

/** 是否为"有内容"的字段（可展示 normalized_value） */
function hasValue(field) {
  if (!field) return false;
  if (field.status === FIELD_STATUS.MISSING || field.status === FIELD_STATUS.UNREADABLE) return false;
  if (field.status === FIELD_STATUS.CONFLICT) {
    return Array.isArray(field.alternatives) && field.alternatives.length > 0;
  }
  const v = field.normalized_value;
  if (v == null) return false;
  if (typeof v === 'string' && v.trim() === '') return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

module.exports = {
  FIELD_STATUS,
  SOURCE_TYPE,
  SOURCE_RANK,
  STATUS_META,
  SOURCE_META,
  CONFIDENCE_NOTE,
  FIELD_DEFS,
  FIELD_DEF_MAP,
  GROUP_LABELS,
  KEY_FIELDS,
  fieldDef,
  makeField,
  hasValue
};

  };
  defs["core/normalize.js"] = function (module, exports, require) {
/**
 * 字段与单位规范化（field-validator 的纯函数部分）。
 *
 * 原则：
 * - 规范化的每一步都必须可解释，返回 note 说明"我做了什么假设"；
 * - 不做"补齐式猜测"：标准号缺年份就是缺年份，不补默认版本；
 * - 无法确定口径时返回低置信 + 明确 note，而不是硬给一个数字。
 */

'use strict';

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 全角转半角 + 常见 OCR 噪声归一 */
function tidy(text) {
  if (text == null) return '';
  return String(text)
    .replace(/\u3000/g, ' ')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/[：]/g, ':')
    .replace(/[％]/g, '%')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function toNumber(raw) {
  if (raw == null) return null;
  const s = tidy(raw).replace(/,/g, '.');
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/* ─────────────────────────── 标准号 ─────────────────────────── */

/**
 * 标准化标准号：`gb/t 5296.4—2012` → `GB/T 5296.4-2012`
 * 记录 ambiguous 标记，供规则引擎区分"原文模糊"与"模型补齐"。
 * @returns {{raw:string, code:string|null, prefix:string|null, number:string|null, year:string|null, valid:boolean, has_year:boolean, note:string}}
 */
function normalizeStandardCode(raw) {
  const original = raw == null ? '' : String(raw);
  let s = tidy(original).toUpperCase().replace(/\s+/g, ' ').trim();
  const out = { raw: original, code: null, prefix: null, number: null, year: null, valid: false, has_year: false, note: '' };
  if (!s) {
    out.note = '原文为空';
    return out;
  }

  // 统一分隔符与常见 OCR 误读
  s = s
    .replace(/[（(]/g, '')
    .replace(/[)）]/g, '')
    .replace(/[—–]/g, '-')
    .replace(/[／]/g, '/')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s*-+\s*/g, '-')
    .replace(/^GB\s*\/\s*T/, 'GB/T')
    .replace(/^(GB|FZ|QB|HG|SN|ISO|EN|AATCC|JIS)\s+/, '$1 ');

  const m = s.match(/^(GB\/T|GB\/Z|GB|FZ\/T|FZ|QB\/T|HG\/T|SN\/T|ISO|EN|AATCC|JIS)\s*(\d+(?:\.\d+)*)(?:-(\d{4}))?/);
  if (!m) {
    out.note = '不符合常见标准号格式，需人工确认';
    return out;
  }
  out.prefix = m[1];
  out.number = m[2];
  out.year = m[3] || null;
  out.has_year = Boolean(m[3]);
  out.code = `${out.prefix} ${out.number}${out.year ? '-' + out.year : ''}`;
  out.valid = true;
  if (!out.has_year) {
    out.note = '原文缺少年份，无法确定适用版本；已按原文保留，未自动补年份';
  }
  // 月份/连字符残缺的常见情形：GB 18401 2010（缺连字符）
  if (!out.has_year) {
    const loose = s.match(/(\d{4})\s*年?$/);
    if (loose) out.note += `；疑似年份 ${loose[1]}，需用户确认`;
  }
  return out;
}

/* ─────────────────────────── 纤维成分 ─────────────────────────── */

const FIBER_ALIASES = {
  棉: '棉',
  纯棉: '棉',
  全棉: '棉',
  羊毛: '羊毛',
  羊绒: '羊绒',
  山羊绒: '羊绒',
  涤纶: '聚酯纤维',
  聚酯: '聚酯纤维',
  聚酯纤维: '聚酯纤维',
  锦纶: '锦纶',
  尼龙: '锦纶',
  氨纶: '氨纶',
  莱卡: '氨纶',
  粘纤: '粘胶纤维',
  粘胶: '粘胶纤维',
  粘胶纤维: '粘胶纤维',
  莫代尔: '莫代尔',
  天丝: '莱赛尔纤维',
  莱赛尔: '莱赛尔纤维',
  莱赛尔纤维: '莱赛尔纤维',
  麻: '麻',
  亚麻: '亚麻',
  苎麻: '苎麻',
  真丝: '蚕丝',
  蚕丝: '蚕丝',
  桑蚕丝: '蚕丝',
  腈纶: '腈纶',
  醋酸: '醋酯纤维',
  醋酯纤维: '醋酯纤维',
  铜氨: '铜氨纤维'
};

/**
 * 解析纤维成分。
 * 支持的写法：`棉 95% 氨纶 5%`、`100%棉`、`棉95/氨纶5`、`面料:100%聚酯纤维 里料:100%棉`
 * @returns {{items:Array<{fiber:string, raw_fiber:string, percent:number|null}>, total:number|null, complete:boolean, parts:Array, note:string}}
 */
function normalizeFiberComposition(raw) {
  const text = tidy(raw);
  const result = { items: [], total: null, complete: false, parts: [], note: '' };
  if (!text) {
    result.note = '原文为空';
    return result;
  }

  // 拆分部面/里料/拼料
  const partRe = /(面料|里料|大身|配料|填充物|外层|内层)\s*[:：]?/g;
  const marks = [];
  let mm;
  while ((mm = partRe.exec(text)) !== null) marks.push({ name: mm[1], index: mm.index, end: mm.index + mm[0].length });

  const segments = [];
  if (marks.length === 0) {
    segments.push({ name: null, text });
  } else {
    for (let i = 0; i < marks.length; i += 1) {
      const start = marks[i].end;
      const stop = i + 1 < marks.length ? marks[i + 1].index : text.length;
      segments.push({ name: marks[i].name, text: text.slice(start, stop).trim() });
    }
  }

  const itemRe = /([\u4e00-\u9fa5A-Za-z]{1,8})\s*(\d{1,3}(?:\.\d+)?)\s*%|(\d{1,3}(?:\.\d+)?)\s*%\s*([\u4e00-\u9fa5A-Za-z]{1,8})/g;

  for (const seg of segments) {
    const items = [];
    let m;
    itemRe.lastIndex = 0;
    while ((m = itemRe.exec(seg.text)) !== null) {
      const rawFiber = (m[1] || m[4] || '').trim();
      const percent = Number(m[2] || m[3]);
      if (!rawFiber || !Number.isFinite(percent)) continue;
      items.push({ fiber: FIBER_ALIASES[rawFiber] || rawFiber, raw_fiber: rawFiber, percent });
    }
    if (items.length === 0) {
      // `100%棉` / `纯棉` 之类
      const pure = seg.text.match(/(100\s*%)?\s*([\u4e00-\u9fa5]{1,6})/);
      if (pure && /100\s*%/.test(seg.text) && pure[2]) {
        items.push({ fiber: FIBER_ALIASES[pure[2]] || pure[2], raw_fiber: pure[2], percent: 100 });
      }
    }
    if (items.length) {
      result.parts.push({ part: seg.name, items });
      result.items.push(...items.map((it, idx) => ({ ...it, part: seg.name, order: idx })));
    }
  }

  if (result.items.length === 0) {
    result.note = '未能解析出"纤维 + 百分比"结构，需人工确认';
    return result;
  }

  // 总比例：单部件时要求接近 100；多部件时逐部件校验
  const totals = result.parts.map((p) => ({
    part: p.part,
    total: p.items.reduce((s, it) => s + it.percent, 0)
  }));
  result.total = totals.length === 1 ? totals[0].total : null;
  result.complete = totals.every((t) => Math.abs(t.total - 100) <= 1.0);
  if (!result.complete) {
    const bad = totals.filter((t) => Math.abs(t.total - 100) > 1.0);
    result.note = bad.map((b) => `${b.part || '整体'}比例合计 ${round(b.total, 1)}%，不等于 100%`).join('；');
  }
  return result;
}

/* ─────────────────────────── 重量 / 克重 ─────────────────────────── */

/**
 * 区分"面料克重（g/m²）"和"成衣重量（g）"。
 * 单位缺失时不做换算，只标记 ambiguous —— 因为 g 与 g/m² 差 2 个数量级。
 * @returns {{value:number|null, unit:string|null, kind:'fabric_weight'|'garment_weight'|'ambiguous', note:string}|null}
 */
function normalizeWeight(raw) {
  const text = tidy(raw);
  if (!text) return null;
  const num = toNumber(text);
  if (num == null) return null;

  const hasPerArea = /(g\s*\/\s*m|克\s*\/\s*(平方米|平米)|克重\s*\/\s*(平方米|平米))/i.test(text);
  const hasGram = /(重量|净重)/i.test(text) || /(^|\s)\d+(\.\d+)?\s*(g|克)\s*$/i.test(text);

  if (hasPerArea) {
    return {
      value: num,
      unit: 'g/m²',
      kind: 'fabric_weight',
      note: '按每平方米克重记录（面料单位面积质量）'
    };
  }
  if (hasGram) {
    // 200g/m² 之类会被上面拦住；剩下的是单件重量
    if (num < 20) {
      return { value: num, unit: 'g', kind: 'ambiguous', note: '数值过小，可能是克重（g/m²）但单位缺失，需用户确认' };
    }
    return {
      value: num,
      unit: 'g',
      kind: 'garment_weight',
      note: '看起来是单件成衣重量，不能与面料克重直接比较'
    };
  }
  if (num >= 40 && num <= 800) {
    return {
      value: num,
      unit: null,
      kind: 'ambiguous',
      note: '未标注单位；若为面料克重应为 g/m²，若为成衣重量应为 g，需用户确认'
    };
  }
  return { value: num, unit: null, kind: 'ambiguous', note: '单位不明，未做换算' };
}

/* ─────────────────────────── 支数 ─────────────────────────── */

/**
 * 支数必须带体系，否则不同体系不可比。
 * 英制 S（棉纱 840 码/磅）、公制 Nm（1000m/kg）、特数 tex（g/1000m）、旦数 D（g/9000m）
 * @returns {{value:number|null, system:string|null, note:string}|null}
 */
function normalizeYarnCount(raw) {
  const text = tidy(raw);
  if (!text) return null;
  const num = toNumber(text);
  if (num == null) return null;

  let system = null;
  if (/\d\s*S\b|英支|支\s*S/i.test(text)) system = '英制支数(S)';
  else if (/NM|公支|公制支数/i.test(text)) system = '公制支数(Nm)';
  else if (/TEX|特数|特克斯/i.test(text)) system = '特数(tex)';
  else if (/DEN|D\b|旦/i.test(text)) system = '旦数(D)';

  if (!system) {
    return {
      value: num,
      system: null,
      note: '原文未标注支数体系（英制 S / 公制 Nm / 特数 tex / 旦数 D），不同体系不可直接比较，需用户确认'
    };
  }
  return { value: num, system, note: `按${system}记录；支数高不等于品质好，需结合纱线类型与织物组织看` };
}

/* ─────────────────────────── 价格 ─────────────────────────── */

/**
 * @returns {{value:number|null, currency:string, raw:string, note:string}}
 */
function normalizePrice(raw) {
  const text = tidy(raw);
  const out = { value: null, currency: 'CNY', raw: text, note: '' };
  if (!text) {
    out.note = '未提供价格';
    return out;
  }
  const num = toNumber(text.replace(/[¥￥]/g, ''));
  if (num == null || num <= 0) {
    out.note = '未能解析出价格数值';
    return out;
  }
  out.value = num;
  if (/[$]/.test(text)) out.currency = 'USD';
  if (/(折|券后|到手|预估|起|低至)/.test(text)) {
    out.note = '页面显示的是促销/区间价，实际成交价可能不同';
  }
  return out;
}

/* ─────────────────────────── 尺码表 ─────────────────────────── */

/**
 * 从文本重建尺码表。只接受"行列对齐"的朴素表格，不做猜测性对齐。
 * @returns {{sizes:Array<{size:string, measurements:Object<string,number>}>, unit:string, notes:string[]}}
 */
function normalizeSizeChart(raw) {
  const text = tidy(raw);
  const out = { sizes: [], unit: 'cm', notes: [] };
  if (!text) {
    out.notes.push('未提供尺码表');
    return out;
  }
  if (/inch|英寸|\"/i.test(text)) {
    out.notes.push('原文出现英寸单位，未自动换算，请核对');
  }
  const lines = text.split(/[\n;；]+/).map((l) => l.trim()).filter(Boolean);
  const sizeToken = /(?:^|\s)(XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL|4XL|\d{2,3}(?:码)?)(?=\s|:)/;
  for (const line of lines) {
    const sm = line.match(sizeToken);
    if (!sm) continue;
    const size = sm[1].replace(/码$/, '');
    const rest = line.slice(line.indexOf(sm[0]) + sm[0].length);
    const measurements = {};
    const pairRe = /([\u4e00-\u9fa5]{1,4})\s*[:]?\s*(\d+(?:\.\d+)?)/g;
    let pm;
    while ((pm = pairRe.exec(rest)) !== null) {
      measurements[pm[1]] = Number(pm[2]);
    }
    out.sizes.push({ size, measurements });
  }
  if (out.sizes.length === 0) {
    out.notes.push('未能从文本中解析出尺码行，需手工录入或补充清晰尺码表图片');
  } else if (out.sizes.some((s) => Object.keys(s.measurements).length === 0)) {
    out.notes.push('部分尺码行没有测量值，可能表格列错位');
  }
  return out;
}

/* ─────────────────────────── 数字工具 ─────────────────────────── */

function round(n, digits = 1) {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

module.exports = {
  tidy,
  toNumber,
  round,
  normalizeStandardCode,
  normalizeFiberComposition,
  normalizeWeight,
  normalizeYarnCount,
  normalizePrice,
  normalizeSizeChart,
  FIBER_ALIASES
};

  };
  defs["core/evidence.js"] = function (module, exports, require) {
/**
 * evidence-engine：多来源合并、冲突保留、用户修正留痕。
 *
 * 关键规则（规范 5.2 第 8、9 条）：
 * - 两张图冲突时，保留双方证据，不允许静默择一；
 * - 用户修正后，修正值成为 canonical，但原始证据必须保留在 alternatives 里。
 */

'use strict';

const { FIELD_STATUS, SOURCE_TYPE, SOURCE_RANK, makeField, hasValue } = require('./fields');

function rank(sourceType) {
  return SOURCE_RANK[sourceType] == null ? 0 : SOURCE_RANK[sourceType];
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 把 normalized_value 压成一个可比较的字符串 */
function fingerprint(field) {
  const v = field.normalized_value;
  if (v == null) return '';
  if (Array.isArray(v)) {
    return v
      .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
      .join('|')
      .replace(/\s+/g, '')
      .toLowerCase();
  }
  if (typeof v === 'object') return JSON.stringify(v).replace(/\s+/g, '').toLowerCase();
  return String(v).replace(/\s+/g, '').toLowerCase();
}

/** 两个值在业务上是否算"同一件事"（数字允许容差） */
function sameValue(a, b, fieldKey) {
  if (isNum(a) && isNum(b)) {
    const tolerance = fieldKey === 'price' ? 0.01 : fieldKey === 'fabric_weight' ? 0.05 : 0.001;
    const base = Math.max(Math.abs(a), Math.abs(b), 1);
    return Math.abs(a - b) / base <= tolerance;
  }
  const fa = fingerprint({ normalized_value: a });
  const fb = fingerprint({ normalized_value: b });
  if (!fa || !fb) return fa === fb;
  // 纤维成分允许顺序不同
  if (fieldKey === 'fiber_composition') {
    const norm = (s) => s.split(/[/、,，]|\|/).map((x) => x.trim()).filter(Boolean).sort().join('|');
    return norm(fa) === norm(fb);
  }
  return fa === fb;
}

/**
 * 合并同一字段的多个候选来源。
 * @param {string} fieldKey
 * @param {Array<object>} candidates 字段记录数组（来自不同图片/用户/官方）
 * @returns {object} 单个字段记录，冲突时 status=conflict 且 alternatives 含全部证据
 */
function mergeField(fieldKey, candidates) {
  const list = (candidates || []).filter(Boolean);
  if (!list.length) {
    return makeField({ field_key: fieldKey, status: FIELD_STATUS.MISSING, source_type: SOURCE_TYPE.NOT_PROVIDED });
  }

  // 用户确认优先级最高：用户说的话就是这个商品的"当前事实"，但保留历史证据
  const userConfirmed = list.filter((c) => c.status === FIELD_STATUS.USER_CONFIRMED && hasValue(c));
  const withValue = list.filter((c) => hasValue(c) && c.status !== FIELD_STATUS.USER_CONFIRMED);

  if (userConfirmed.length) {
    const canonical = userConfirmed[userConfirmed.length - 1];
    const others = list.filter((c) => c !== canonical && hasValue(c));
    return {
      ...canonical,
      alternatives: [
        ...(canonical.alternatives || []),
        ...others.map((c) => ({
          normalized_value: c.normalized_value,
          raw_text: c.raw_text,
          source_type: c.source_type,
          source_image_id: c.source_image_id,
          status: c.status
        }))
      ],
      evidence_note: others.length
        ? `已按你的修正记录；原始识别结果保留在来源里（${others.length} 条）`
        : canonical.evidence_note
    };
  }

  if (!withValue.length) {
    // 全是 missing/unreadable：优先报"识别不清"，因为它更有行动价值
    const unreadable = list.find((c) => c.status === FIELD_STATUS.UNREADABLE);
    const base = unreadable || list[0];
    return { ...base, alternatives: [] };
  }

  // 按来源效力排序
  const sorted = withValue.slice().sort((a, b) => rank(b.source_type) - rank(a.source_type));
  const best = sorted[0];
  const conflicting = sorted.filter((c) => !sameValue(c.normalized_value, best.normalized_value, fieldKey));

  if (conflicting.length) {
    return {
      ...best,
      status: FIELD_STATUS.CONFLICT,
      alternatives: sorted.map((c) => ({
        normalized_value: c.normalized_value,
        raw_text: c.raw_text,
        source_type: c.source_type,
        source_image_id: c.source_image_id,
        status: c.status,
        evidence_note: c.evidence_note
      })),
      evidence_note:
        `不同来源对「${best.field_name || fieldKey}」的说法不一致：` +
        sorted
          .map((c) => `${sourceLabel(c.source_type)}为 ${displayValue(c)}`)
          .join('；') +
        '。两侧证据都已保留，建议以实物标签为准并让商家确认'
    };
  }

  // 一致：合并证据数量，最高效力者为准
  const merged = { ...best };
  const supporting = sorted.filter((c) => c !== best);
  if (supporting.length) {
    merged.alternatives = supporting.map((c) => ({
      normalized_value: c.normalized_value,
      raw_text: c.raw_text,
      source_type: c.source_type,
      source_image_id: c.source_image_id,
      status: c.status
    }));
    merged.evidence_note = `${best.evidence_note || ''}${best.evidence_note ? '；' : ''}另有 ${supporting.length} 处来源与之一致`;
  }
  return merged;
}

function sourceLabel(sourceType) {
  const { SOURCE_META } = require('./fields');
  return (SOURCE_META[sourceType] || { label: sourceType }).label;
}

function displayValue(field) {
  const v = field.normalized_value;
  if (v == null) return '（空）';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : x && x.size ? x.size : JSON.stringify(x))).join('、');
  if (typeof v === 'object') return JSON.stringify(v);
  return `${v}${field.unit && field.unit !== '%' ? ' ' + field.unit : ''}`;
}

/**
 * 合并两组字段集合（例如：先宣传页提取，再补充标签页提取）。
 * @param {Object<string, object>} base
 * @param {Object<string, object>} extra
 * @returns {Object<string, object>}
 */
function mergeFieldSets(base, extra) {
  const keys = new Set([...Object.keys(base || {}), ...Object.keys(extra || {})]);
  const out = {};
  for (const key of keys) {
    const a = base ? base[key] : null;
    const b = extra ? extra[key] : null;
    if (a && b) out[key] = mergeField(key, [a, b]);
    else out[key] = a || b;
  }
  return out;
}

/**
 * 用户修正字段。保留原值与来源，修正值标记 user_confirmed。
 * @param {object} field 原字段
 * @param {object} patch { normalized_value, unit?, raw_text? }
 */
function applyUserCorrection(field, patch) {
  const prev = field || {};
  const original = {
    normalized_value: prev.normalized_value,
    raw_text: prev.raw_text,
    source_type: prev.source_type,
    source_image_id: prev.source_image_id,
    status: prev.status
  };
  const alternatives = (prev.alternatives || []).slice();
  if (prev.normalized_value != null) alternatives.unshift(original);
  return makeField({
    field_key: prev.field_key,
    normalized_value: patch.normalized_value,
    raw_text: patch.raw_text != null ? patch.raw_text : prev.raw_text,
    unit: patch.unit !== undefined ? patch.unit : prev.unit,
    status: FIELD_STATUS.USER_CONFIRMED,
    source_type: SOURCE_TYPE.USER_INPUT,
    confidence: null,
    evidence_note: patch.note || '你手动确认/修正过该字段',
    alternatives,
    updated_at: new Date().toISOString()
  });
}

module.exports = { mergeField, mergeFieldSets, applyUserCorrection, sameValue, rank, sourceLabel, displayValue };

  };
  defs["core/report.js"] = function (module, exports, require) {
/**
 * report-generator：把各个服务的输出组装成"分析卡"数据。
 *
 * 这一层不产生新事实，只负责：
 * - 决定"一句话结论"的措辞强度（必须和信息完整度、疑点等级匹配）；
 * - 组织 8 个区块的顺序与状态；
 * - 汇总需要向商家确认的问题；
 * - 输出边界声明（limits / disclaimer）。
 *
 * 禁止：质量评级、真伪判断、"符合标准"结论、准确率数字。
 */

'use strict';

const { FIELD_STATUS, hasValue, GROUP_LABELS, SOURCE_META, STATUS_META, CONFIDENCE_NOTE, KEY_FIELDS, fieldDef } = require('./fields');
const standards = require('./standards');
const { assessWeight, assessYarnCount } = require('./fabric');
const knowledge = require('./knowledge');
const { assessFit } = require('./fit');
const { computeCompleteness, buildDoubts } = require('./rules');
const { buildWearReport } = require('./wear/analyze');

const DISCLAIMER =
  '本卡基于你上传的图片做信息整理与规则提示，不是检测报告，也不构成质量、真伪或合规判定。' +
  '标注内容由商家提供，是否属实需以检测报告与实物为准。';

/**
 * @param {object} input
 * @param {object} input.fields 合并后的字段集合
 * @param {object} [input.profile] 个人资料（可选）
 * @param {string} [input.rawText] 原始 OCR 文本
 * @param {object} [input.meta] { images, mode, demo, created_at, analysis_id }
 */
function buildReport(input) {
  const fields = input.fields || {};
  const profile = input.profile || null;
  const meta = input.meta || {};
  const rawText = input.rawText || '';

  const category = hasValue(fields.category) ? String(fields.category.normalized_value) : '';
  const completeness = computeCompleteness(fields);
  const standard = standards.associate({
    standard_code_field: fields.standard_code,
    category_field: fields.category,
    safety_category_field: fields.safety_category,
    product_category: category
  });
  const weight = assessWeight({
    category,
    weightField: fields.fabric_weight && hasValue(fields.fabric_weight) ? fields.fabric_weight : null,
    garmentWeightField: fields.garment_weight && hasValue(fields.garment_weight) ? fields.garment_weight : null
  });
  const yarn = assessYarnCount(fields.yarn_count && hasValue(fields.yarn_count) ? fields.yarn_count : null);
  const fiberItems = fields.fiber_composition && fields.fiber_composition.parsed ? fields.fiber_composition.parsed.items : [];
  const fabricNotes = knowledge.composeFabricNotes(fiberItems);
  const care = knowledge.explainCare(hasValue(fields.care_instructions) ? fields.care_instructions.normalized_value : '');
  const fit = assessFit({ fields, profile });
  const wear = buildWearReport({ fields, rawText, profile });
  const doubts = buildDoubts({ fields, standard, weight, fit, wear, completeness, rawText });

  const conclusion = buildConclusion({ fields, completeness, standard, doubts, weight, fit });

  const sections = [
    basicSection(fields),
    standardSection(standard),
    fabricSection({ fields, weight, yarn, fabricNotes }),
    fitSection(fit),
    wearSection(wear),
    doubtSection(doubts),
    careSection({ fields, care, fiberItems })
  ];

  return {
    analysis_id: meta.analysis_id || null,
    created_at: meta.created_at || new Date().toISOString(),
    mode: meta.mode || 'local',
    demo: Boolean(meta.demo),
    demo_note: meta.demo
      ? '当前结果由演示数据（模拟 OCR/示例商品）生成，用于验证流程，不能作为真实商品分析。'
      : meta.mode === 'mock'
        ? '当前处于模型模拟模式：图片由示例 OCR 数据代替，结果仅用于流程验证。'
        : null,

    header: {
      product_name: valueOf(fields.product_name) || '未识别商品名称',
      category: category || null,
      price: priceOf(fields.price),
      price_note: fields.price ? fields.price.evidence_note : null,
      image_count: (meta.images || []).length,
      images: (meta.images || []).map((img) => ({ id: img.id, kind: img.kind, preview: img.preview || null })),
      conclusion: conclusion.one_line,
      conclusion_detail: conclusion.detail,
      completeness
    },

    sections,
    doubts: doubts.items,
    doubt_counts: doubts.counts,
    questions: doubts.questions,
    wear,
    evidence: buildEvidence(fields),
    limits: buildLimits({ completeness, standard, weight, fit, wear }),
    disclaimer: DISCLAIMER,
    standard,
    fit,
    weight,
    yarn,
    confidence_note: CONFIDENCE_NOTE
  };
}

/* ─────────────────────── 一句话结论 ─────────────────────── */

function buildConclusion({ fields, completeness, standard, doubts, weight, fit }) {
  const name = valueOf(fields.product_name);
  const category = valueOf(fields.category);
  const fiberText = fields.fiber_composition && fields.fiber_composition.parsed
    ? fiberSummary(fields.fiber_composition.parsed)
    : null;

  const parts = [];
  const subject = name ? `这件${category ? category + '「' + truncate(name, 18) + '」' : '商品'}` : category ? `这件${category}` : '这件商品';

  if (completeness.level === 'high') {
    parts.push(`${subject}的可核实信息比较齐全`);
  } else if (completeness.level === 'medium') {
    parts.push(`${subject}的部分信息可以核实，但还有关键项缺失`);
  } else {
    parts.push(`目前只有${subject}的部分信息，结论会明显受限`);
  }

  if (fiberText) parts.push(`标注成分为 ${fiberText}（商家标注，非实测）`);
  if (weight.status === 'reference_only') {
    parts.push(`克重 ${weight.value} g/m² 落在同类参考区间内`);
  } else if (weight.status === 'known_unrated' || weight.status === 'insufficient_reference') {
    parts.push(`克重仅有原始数值，缺少同类参考`);
  }

  if (standard.registry_match) {
    parts.push(
      `执行标准 ${standard.normalized_code} 在官方平台可查，状态为${standard.official_status_label || '未知'}` +
        `（核验时间 ${shortDate(standard.last_verified_at)}）`
    );
    if (standard.applicability === 'unlikely') parts.push('但该标准名称与品类可能不匹配，值得确认');
  } else if (standard.appears_in_product) {
    parts.push(`标准号 ${standard.normalized_code || '（原文）'} 暂未核验，系统不判断其状态`);
  } else {
    parts.push('截图中没有执行标准号');
  }

  const attention = doubts.counts.attention;
  const verify = doubts.counts.verify;
  if (attention > 0) parts.push(`有 ${attention} 处信息冲突/需重点核实的地方`);
  else if (verify > 0) parts.push(`有 ${verify} 个点建议向商家确认`);
  else if (doubts.items.length === 0) parts.push('暂未发现需要特别核实的点');

  const oneLine = parts.join('，') + '。';

  const detailBits = [];
  if (fit && fit.status === 'heuristic') {
    detailBits.push(`尺码按尺码表与你的偏好推算为 ${fit.recommended_size}，理由见下方版型区块。`);
  } else if (fit && fit.status === 'chart_missing') {
    detailBits.push('缺尺码表，未给具体尺码。');
  }
  if (attention > 0) detailBits.push('标"需重点核实"的条目会影响判断，建议先处理再下单。');
  if (completeness.level === 'low') detailBits.push('补齐关键信息（尤其成分、标准、尺码表）后再做购买决定更稳妥。');

  return {
    one_line: oneLine,
    detail: detailBits.join(' '),
    disclaimer: '以上为信息整理，不代表质量或真伪判断。'
  };
}

/* ─────────────────────── 区块 ─────────────────────── */

function basicSection(fields) {
  const keys = ['product_name', 'brand', 'category', 'price'];
  return {
    key: 'basic',
    title: '基本信息',
    subtitle: '图片里写明的内容，逐项标注来源与状态',
    items: keys.map((k) => fieldItem(fields[k], k))
  };
}

function standardSection(standard) {
  return {
    key: 'standard',
    title: '标准解读',
    subtitle: '标准号只是"声称执行"，不等于"已符合"',
    items: [
      { key: 'appears', label: '商品中出现的标准号', value: standard.normalized_code || (standard.appears_in_product ? '原文无法规范化' : '未出现'), status: standard.appears_in_product ? 'extracted' : 'missing' },
      { key: 'name', label: '标准名称', value: standard.standard_name || '—', status: standard.registry_match ? 'official_verified' : 'pending_verification' },
      { key: 'type', label: '标准性质', value: standard.standard_type || '—', status: standard.registry_match ? 'official_verified' : 'missing' },
      { key: 'status', label: '状态', value: standard.official_status_label || '未核验', status: standard.registry_match ? 'official_verified' : 'pending_verification' },
      { key: 'dates', label: '发布/实施日期', value: standard.registry_match ? `${standard.publication_date || '—'} / ${standard.implementation_date || '—'}` : '—', status: standard.registry_match ? 'official_verified' : 'missing' },
      { key: 'applicability', label: '与本商品的关系', value: applicabilityText(standard.applicability), status: standard.applicability === 'likely' ? 'inferred' : standard.applicability === 'unlikely' ? 'conflict' : 'pending_verification', note: standard.applicability_reason },
      { key: 'topics', label: '主要管控内容（类别）', value: (standard.key_requirement_topics || []).join('、') || '未录入', status: standard.key_requirements_verified ? 'official_verified' : 'pending_verification', note: standard.key_requirements_verified ? null : '仅标准摘要层面的项目类别，未逐条核对正文条款' },
      { key: 'compliance', label: '是否符合标准', value: '未评估（需检测报告与实物核对）', status: 'missing' }
    ],
    official_source_url: standard.official_source_url,
    last_verified_at: standard.last_verified_at,
    versions: standard.versions,
    caveats: standard.caveats,
    scope_note: standard.scope_note
  };
}

function fabricSection({ fields, weight, yarn, fabricNotes }) {
  return {
    key: 'fabric',
    title: '面料与工艺参考',
    subtitle: '通用纤维特性 + 已知参数，不是实测结论',
    composition: fieldItem(fields.fiber_composition, 'fiber_composition'),
    items: [
      fieldItem(fields.fabric_weight, 'fabric_weight'),
      fieldItem(fields.garment_weight, 'garment_weight'),
      fieldItem(fields.yarn_count, 'yarn_count'),
      fieldItem(fields.weave_structure, 'weave_structure'),
      fieldItem(fields.elasticity, 'elasticity')
    ],
    weight_assessment: weight,
    yarn_assessment: yarn,
    fiber_notes: fabricNotes,
    disclaimer: fabricNotes.disclaimer
  };
}

function fitSection(fit) {
  return {
    key: 'fit',
    title: '版型与尺码',
    subtitle: '人体尺寸 ≠ 成衣尺寸；缺尺码表时不给具体尺码',
    status: fit.status,
    summary: fit.summary || '',
    recommended_size: fit.recommended_size,
    reasons: fit.reasons,
    limits: fit.limits,
    fit_match: fit.fit_match,
    chart_sizes: fit.chart_sizes,
    missing_profile: fit.missing_profile,
    missing_product: fit.missing_product,
    questions: fit.questions
  };
}

function wearSection(wear) {
  return {
    key: 'wear',
    title: wear.title,
    subtitle: wear.subtitle,
    available: wear.available,
    summary: wear.summary,
    counts: wear.counts,
    items: wear.items,
    timeline: wear.timeline,
    appearance: wear.appearance,
    regions: wear.regions,
    evidence_gaps: wear.evidence_gaps,
    seller_questions: wear.seller_questions,
    features: wear.features,
    disclaimer: wear.disclaimer,
    confidence_note: wear.confidence_note,
    updated_at: wear.updated_at
  };
}

function doubtSection(doubts) {
  return {
    key: 'doubts',
    title: '信息可信度与疑点',
    subtitle: '每条都写明依据与下一步，不做定性指控',
    counts: doubts.counts,
    items: doubts.items
  };
}

function careSection({ fields, care, fiberItems }) {
  const fiberCare = fiberItems
    .map((i) => ({ fiber: i.fiber, advice: knowledge.findByName(i.fiber) ? require('./data/knowledge.data').CARE_BY_FIBER[knowledge.findByName(i.fiber).name] || [] : [] }))
    .filter((x) => x.advice.length);
  return {
    key: 'care',
    title: '穿着与洗护',
    subtitle: '标签要求优先，成分建议只作参考',
    label_item: fieldItem(fields.care_instructions, 'care_instructions'),
    symbols: care.symbols,
    keywords: care.keywords,
    note: care.note,
    fiber_care: fiberCare,
    caution: '洗护标签没写的项目，本系统不会替你补；不确定时按更保守的方式处理。'
  };
}

/* ─────────────────────── 工具 ─────────────────────── */

function fieldItem(field, key) {
  const def = fieldDef(key);
  if (!field) {
    return { key, label: def.name, value: '未提供', status: FIELD_STATUS.MISSING, raw_text: null, source: null, confidence: null, note: null };
  }
  const value = formatValue(field);
  return {
    key,
    label: field.field_name || def.name,
    value: hasValue(field) ? value : '',
    placeholder: hasValue(field) ? null : STATUS_META[field.status] ? STATUS_META[field.status].label : '未提供',
    status: field.status,
    status_label: STATUS_META[field.status] ? STATUS_META[field.status].label : field.status,
    raw_text: field.raw_text,
    unit: field.unit,
    source: SOURCE_META[field.source_type] ? SOURCE_META[field.source_type].label : field.source_type,
    source_type: field.source_type,
    confidence: field.confidence,
    note: field.evidence_note,
    alternatives: field.alternatives || [],
    editable: true
  };
}

function formatValue(field) {
  const v = field.normalized_value;
  if (v == null) return '';
  if (Array.isArray(v)) {
    if (v.length && typeof v[0] === 'object' && v[0].size) return `${v.map((x) => x.size).join(' / ')}`;
    return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' / ');
  }
  if (typeof v === 'object') return JSON.stringify(v);
  if (field.unit === '%' || !field.unit) return String(v);
  return `${v} ${field.unit}`;
}

function valueOf(field) {
  if (!field || !hasValue(field)) return null;
  const v = field.normalized_value;
  return typeof v === 'string' ? v : String(v);
}

function priceOf(field) {
  if (!field || !hasValue(field)) return null;
  const n = Number(field.normalized_value);
  return Number.isFinite(n) ? n : null;
}

function applicabilityText(a) {
  return a === 'likely' ? '可能适用（依标准名称推导）' : a === 'unlikely' ? '可能不适用' : '无法判断（缺范围条款）';
}

/** 成分摘要：有面料/里料分段时按段展示，不把里料混进主成分 */
function fiberSummary(parsed) {
  const parts = (parsed && parsed.parts) || [];
  if (parts.length > 1) {
    return parts
      .map((p) => `${p.part || '整体'}${p.items.map((i) => `${i.fiber}${i.percent}%`).join('+')}`)
      .join('，');
  }
  return ((parsed && parsed.items) || []).map((i) => `${i.fiber}${i.percent}%`).join('+');
}

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function shortDate(iso) {
  if (!iso) return '未记录';
  return String(iso).slice(0, 10);
}

function buildEvidence(fields) {
  return Object.keys(fields).map((k) => {
    const f = fields[k];
    const def = fieldDef(k);
    return {
      field_key: k,
      field_name: (f && f.field_name) || def.name,
      group: def.group,
      group_label: GROUP_LABELS[def.group] || def.group,
      is_key: KEY_FIELDS.includes(k),
      status: f ? f.status : FIELD_STATUS.MISSING,
      status_label: f && STATUS_META[f.status] ? STATUS_META[f.status].label : '未提供',
      source_type: f ? f.source_type : 'not_provided',
      source_label: f && SOURCE_META[f.source_type] ? SOURCE_META[f.source_type].label : '未提供',
      source_image_id: f ? f.source_image_id : null,
      raw_text: f ? f.raw_text : null,
      value: f ? formatValue(f) : '',
      confidence: f ? f.confidence : null,
      note: f ? f.evidence_note : null
    };
  });
}

function buildLimits({ completeness, standard, weight, fit, wear }) {
  const limits = [
    '只分析你上传的图片内容；图片没拍到的，系统不会补',
    '识别结果可能出错，标注"已识别"的字段也需要你对照原图复核',
    '标注成分、执行标准属于商家自述，不等于实测或认证结果',
    '未做任何化学、物理性能检测，无法确认实物是否符合标准'
  ];
  if (completeness.level !== 'high') limits.push(`关键字段缺失 ${completeness.key_missing.length} 项，结论强度相应降低`);
  if (!standard.registry_match) limits.push('该标准号未在本地官方核验库中查到，状态未核验');
  if (weight.status !== 'reference_only') limits.push('没有可用的克重同类参考，未做厚薄评级');
  if (fit.status !== 'heuristic') limits.push('缺尺码表或个人尺寸，未给出具体尺码建议');
  if (wear && wear.counts && wear.counts.insufficient > 0) {
    limits.push(`老化风险中 ${wear.counts.insufficient} 项因缺少材料/结构/检测信息标为「证据不足」，这不等于低风险`);
  }
  limits.push('老化与耐久提示来自文字描述与通用工艺知识，没有做任何耐洗、耐磨、抗起球或色牢度测试');
  limits.push('本系统没有同类产品样本库，因此不提供"品质评分"或"性价比排名"');
  return limits;
}

module.exports = { buildReport, DISCLAIMER, fieldItem, formatValue };

  };
  defs["core/standards.js"] = function (module, exports, require) {
/**
 * standard-service：标准查询与"商品—标准"关联判断。
 *
 * 这一层最重要的职责不是"给出结论"，而是**把六种不同的说法分开**（规范 6.4）：
 *   1. 商品截图出现了该标准号            → appears_in_product
 *   2. 该标准号能在官方检索到            → registry_match
 *   3. 官方资料表明其当前状态与范围      → official_status / official_dates
 *   4. 该标准可能适用于当前商品          → applicability（仅"可能"，由名称/品类推导）
 *   5. 商品标注与标准之间存在疑点        → issues（交给 rule-engine 汇总）
 *   6. 商品实际是否符合标准              → compliance: 永远 'not_assessed'
 *
 * 任何函数都不允许返回"符合/合格"的判断。
 */

'use strict';

const verifiedData = require('./data/standards.verified');
const { META, CATEGORY_STANDARD_HINTS } = require('./data/standards.meta');
const { normalizeStandardCode } = require('./normalize');

const STATUS_LABELS = {
  current: '现行',
  upcoming: '即将实施',
  abolished: '已废止',
  superseded: '已被代替',
  under_revision: '修订中',
  unknown: '状态未知'
};

/** 规范化到可比较的索引键（去掉年份） */
function baseKey(code) {
  const n = normalizeStandardCode(code);
  if (!n.valid) return null;
  return `${n.prefix} ${n.number}`;
}

function buildIndex() {
  const idx = {};
  for (const rec of Object.values(verifiedData.records || {})) {
    const key = baseKey(rec.standard_number);
    if (!key) continue;
    if (!idx[key]) idx[key] = [];
    idx[key].push(rec);
  }
  // 同号多个版本：现行优先，其次日期最新
  for (const key of Object.keys(idx)) {
    idx[key].sort((a, b) => {
      const rank = (r) => (r.status === 'current' ? 0 : r.status === 'upcoming' ? 1 : 2);
      return rank(a) - rank(b) || String(b.publication_date || '').localeCompare(String(a.publication_date || ''));
    });
  }
  return idx;
}

const INDEX = buildIndex();

/**
 * 查询一个标准号（可带或不带年份）。
 * @returns {{
 *   query: string, normalized: object,
 *   result: 'official_verified'|'pending_verification'|'not_found',
 *   record: object|null, versions: Array<object>, meta: object|null,
 *   label: string, message: string, last_verified_at: string|null, official_source_url: string|null
 * }}
 */
function lookup(codeText) {
  const normalized = normalizeStandardCode(codeText);
  const out = {
    query: String(codeText || ''),
    normalized,
    result: 'not_found',
    record: null,
    versions: [],
    meta: null,
    label: '未找到',
    message: '',
    last_verified_at: null,
    official_source_url: null
  };

  if (!normalized.valid) {
    out.result = 'pending_verification';
    out.label = '标准号无法确认';
    out.message = normalized.note || '标准号格式无法识别，需人工核对';
    out.official_source_url = 'https://openstd.samr.gov.cn/bzgk/gb/std_list';
    return out;
  }

  const key = `${normalized.prefix} ${normalized.number}`;
  const versions = INDEX[key] || [];
  out.versions = versions;

  if (!versions.length) {
    out.result = 'pending_verification';
    out.label = '暂未核验';
    out.message =
      '本地核验库中没有这个标准号的官方查询结果，系统不判断其是否存在或是否现行。' +
      '请用官方平台链接自行确认。';
    out.official_source_url = `https://openstd.samr.gov.cn/bzgk/gb/std_list?p.p1=0&p.p2=${encodeURIComponent(normalized.number || '')}`;
    return out;
  }

  // 指定年份时精确匹配，否则取现行/最新
  let record = null;
  if (normalized.has_year) {
    record =
      versions.find((v) => String(v.standard_number).endsWith(`-${normalized.year}`)) || null;
    if (!record) {
      out.result = 'pending_verification';
      out.label = '该版本未核验';
      out.message =
        `官方库中能核验到 ${key} 的其他版本，但没有 ${normalized.year} 版的记录。` +
        '可能该年份不存在、或已从公开库下线，需人工确认。';
      out.record = versions[0];
      out.last_verified_at = versions[0].last_verified_at || null;
      out.official_source_url = versions[0].official_source_url || null;
      out.meta = META[key] || null;
      return out;
    }
  } else {
    record = versions[0];
  }

  out.record = record;
  out.meta = META[key] || null;
  out.result = record.verification_status === 'official_verified' ? 'official_verified' : 'pending_verification';
  out.label = out.result === 'official_verified' ? STATUS_LABELS[record.status] || '已核验' : '待核验';
  out.last_verified_at = record.last_verified_at || null;
  out.official_source_url = record.official_source_url || null;
  if (record.verification_status !== 'official_verified') {
    out.message = record.note || '未从官方平台获取到数据';
  }
  return out;
}

/**
 * 判断标准与商品的关联。
 * @param {{standard_code_field?: object, category_field?: object, safety_category_field?: object, product_category?: string}} input
 */
function associate(input) {
  const input_ = input || {};
  const codeField = input_.standard_code_field || null;
  const category = (input_.product_category || (input_.category_field && input_.category_field.normalized_value) || '').toString();

  if (!codeField || !codeField.normalized_value) {
    return {
      appears_in_product: false,
      registry_match: false,
      applicability: 'unknown',
      applicability_reason: '商品资料中没有出现执行标准号',
      compliance: 'not_assessed',
      suggested_standards: CATEGORY_STANDARD_HINTS[category] || [],
      official_status: null,
      last_verified_at: null,
      official_source_url: null,
      caveats: ['没有标准号，无法做任何"符合性"讨论；可向商家索要吊牌或水洗标照片。']
    };
  }

  const looked = lookup(codeField.normalized_value);
  const meta = looked.meta;
  const record = looked.record;

  let applicability = 'unknown';
  let reason = '';
  if (meta && Array.isArray(meta.applicable_categories) && meta.applicable_categories.length) {
    if (category && meta.applicable_categories.includes(category)) {
      applicability = 'likely';
      reason = `标准名称与品类「${category}」相符（依据标准名称推导，不是正文范围条款）`;
    } else if (category) {
      applicability = 'unlikely';
      reason = `该标准名称限定为「${meta.applicable_categories.join('、')}」，与当前品类「${category}」不一致，值得向商家确认`;
    } else {
      applicability = 'unknown';
      reason = '未识别出商品品类，无法判断标准是否适用';
    }
  } else if (meta && meta.applies_to_all_textiles) {
    applicability = 'likely';
    reason = '该标准名称表明覆盖纺织产品/使用说明类要求，通常与服装相关（具体条款仍需查正文）';
  } else {
    applicability = 'unknown';
    reason = '缺少可用的适用范围信息（公开页面不含范围条款，需人工查阅标准正文）';
  }

  const caveats = [];
  if (record && record.status === 'abolished') {
    caveats.push('该版本状态为已废止；若商品近期生产仍标注此版本，属于值得核实的信息。');
  }
  if (record && record.status === 'upcoming') {
    caveats.push('该版本尚未到实施日期，标注此版本的合规意义需按实施日期判断。');
  }
  if (looked.result === 'pending_verification') {
    caveats.push('标准状态暂未核验，系统不给出"现行/废止"结论。');
  }
  caveats.push('商品页面出现标准号 ≠ 商品经检测符合该标准；本系统不做符合性判定。');
  if (meta && meta.notes && meta.notes.length) caveats.push(...meta.notes);

  return {
    appears_in_product: true,
    raw_code: codeField.raw_text || null,
    normalized_code: looked.normalized.code,
    registry_match: Boolean(record),
    registry_result: looked.result,
    registry_label: looked.label,
    official_status: record ? record.status : null,
    official_status_label: record ? STATUS_LABELS[record.status] || record.status : null,
    official_status_text: record ? record.status_text : null,
    publication_date: record ? record.publication_date : null,
    implementation_date: record ? record.implementation_date : null,
    standard_name: record ? record.name : null,
    standard_type: record ? record.standard_type : null,
    scope_summary: null,
    scope_note: '范围条款需查阅标准正文（官方"在线预览"），本项目不代填',
    key_requirement_topics: meta ? meta.key_requirement_topics || [] : [],
    key_requirements_verified: meta ? Boolean(meta.key_requirements_verified) : false,
    applicability,
    applicability_reason: reason,
    compliance: 'not_assessed',
    compliance_note: '是否符合标准需要检测报告与实物核对，本系统只做信息提示',
    last_verified_at: record ? record.last_verified_at || null : null,
    official_source_url: looked.official_source_url,
    versions: (looked.versions || []).map((v) => ({
      standard_number: v.standard_number,
      status: v.status,
      publication_date: v.publication_date,
      implementation_date: v.implementation_date
    })),
    caveats,
    message: looked.message || null
  };
}

/** 标准详情页数据 */
function detail(codeText) {
  const looked = lookup(codeText);
  const record = looked.record;
  const meta = looked.meta;
  return {
    standard_number: looked.normalized.code || looked.query,
    found: Boolean(record),
    verified: looked.result === 'official_verified',
    registry_result: looked.result,
    label: looked.label,
    record: record
      ? {
          standard_number: record.standard_number,
          name: record.name,
          name_en: record.name_en,
          standard_type: record.standard_type,
          status: record.status,
          status_label: STATUS_LABELS[record.status] || record.status,
          publication_date: record.publication_date,
          implementation_date: record.implementation_date,
          ccs: record.ccs,
          ics: record.ics,
          competent_department: record.competent_department,
          issuing_body: record.issuing_body,
          official_source_url: record.official_source_url,
          last_verified_at: record.last_verified_at,
          verification_status: record.verification_status
        }
      : null,
    editorial: meta
      ? {
          role: meta.role,
          applicability_by_name: meta.applicability_by_name || [],
          applicable_categories: meta.applicable_categories || [],
          applicability_basis: meta.applicability_basis,
          key_requirement_topics: meta.key_requirement_topics || [],
          key_requirements_verified: Boolean(meta.key_requirements_verified),
          notes: meta.notes || []
        }
      : null,
    versions: looked.versions.map((v) => ({
      standard_number: v.standard_number,
      status: v.status,
      status_label: STATUS_LABELS[v.status] || v.status,
      publication_date: v.publication_date,
      implementation_date: v.implementation_date,
      official_source_url: v.official_source_url,
      last_verified_at: v.last_verified_at,
      verification_status: v.verification_status
    })),
    message: looked.message || null,
    official_source_url: looked.official_source_url,
    last_verified_at: looked.last_verified_at,
    dataset: {
      generated_at: verifiedData.generated_at,
      source: verifiedData.source,
      disclaimer: verifiedData.disclaimer
    }
  };
}

/** 关键字搜索（本地核验库 + 品类提示），不联网 */
function search(keyword) {
  const q = String(keyword || '').trim();
  if (!q) return { query: '', results: [], hints: [] };
  const upper = q.toUpperCase();
  const results = [];
  for (const rec of Object.values(verifiedData.records || {})) {
    const name = rec.name || '';
    const num = rec.standard_number || '';
    if (num.toUpperCase().includes(upper) || name.includes(q)) {
      results.push({
        standard_number: num,
        name,
        status: rec.status,
        status_label: STATUS_LABELS[rec.status] || rec.status,
        verification_status: rec.verification_status,
        official_source_url: rec.official_source_url,
        last_verified_at: rec.last_verified_at
      });
    }
  }
  const hints = Object.entries(CATEGORY_STANDARD_HINTS)
    .filter(([cat]) => cat.includes(q) || q.includes(cat))
    .map(([cat, codes]) => ({ category: cat, standards: codes.map((c) => (INDEX[baseKey(c)] || [])[0] ? INDEX[baseKey(c)][0].standard_number : c) }));
  return { query: q, results, hints };
}

module.exports = { lookup, associate, detail, search, STATUS_LABELS, CATEGORY_STANDARD_HINTS, dataset: verifiedData };

  };
  defs["core/data/standards.verified.js"] = function (module, exports, require) {
/**
 * 自动生成，请勿手工编辑：node scripts/verify-standards.js
 * 生成时间：2026-10-23T06:30:17.461Z
 * 数据来源：国家标准全文公开系统/全国标准信息公共服务平台 (openstd.samr.gov.cn)
 */

'use strict';

module.exports = {
  "generated_at": "2026-10-23T06:30:17.461Z",
  "source": "国家标准全文公开系统/全国标准信息公共服务平台 (openstd.samr.gov.cn)",
  "disclaimer": "本文件由脚本实时抓取官方公开页面生成，只记录页面上可见的字段。标准正文范围条款与全文内容不在公开页面上，需人工查阅。状态可能随官方更新变化，展示时必须带上 last_verified_at。",
  "records": {
    "GB 18401-2010": {
      "standard_number": "GB 18401-2010",
      "name": "国家纺织产品基本安全技术规范",
      "name_en": "National general safety technical code for textile products",
      "standard_type": "强制性国家标准",
      "status": "current",
      "status_text": "现行",
      "publication_date": "2011-01-14",
      "implementation_date": "2011-08-01",
      "ccs": "W09",
      "ics": "59.080.01",
      "competent_department": "工业和信息化部",
      "issuing_body": "中华人民共和国国家质量监督检验检疫总局、中国国家标准化管理委员会",
      "remarks": null,
      "official_source_url": "https://openstd.samr.gov.cn/bzgk/gb/showGb?type=online&hcno=52C1F4CBDE863F5095D7C9D17F8E3F71",
      "search_url": "https://openstd.samr.gov.cn/bzgk/gb/std_list?p.p1=0&p.p90=circulation_date&p.p91=desc&p.p2=GB%2018401",
      "scope_summary": null,
      "scope_note": "公开页面不提供标准正文范围条款，需在官方\"在线预览\"中查阅原文后人工补录",
      "verification_status": "official_verified",
      "last_verified_at": "2026-10-23T06:29:39.611Z",
      "source_excerpt": null
    },
    "GB 31701-2015": {
      "standard_number": "GB 31701-2015",
      "name": "婴幼儿及儿童纺织产品安全技术规范",
      "name_en": "The safety technical code for infants and children textile products",
      "standard_type": "强制性国家标准",
      "status": "current",
      "status_text": "现行",
      "publication_date": "2015-05-26",
      "implementation_date": "2016-06-01",
      "ccs": "W09",
      "ics": "59.080.01",
      "competent_department": "工业和信息化部",
      "issuing_body": "中华人民共和国国家质量监督检验检疫总局、中国国家标准化管理委员会",
      "remarks": null,
      "official_source_url": "https://openstd.samr.gov.cn/bzgk/gb/showGb?type=online&hcno=1698157554F00EED2E79EC6BFF7F4DF0",
      "search_url": "https://openstd.samr.gov.cn/bzgk/gb/std_list?p.p1=0&p.p90=circulation_date&p.p91=desc&p.p2=GB%2031701",
      "scope_summary": null,
      "scope_note": "公开页面不提供标准正文范围条款，需在官方\"在线预览\"中查阅原文后人工补录",
      "verification_status": "official_verified",
      "last_verified_at": "2026-10-23T06:29:42.686Z",
      "source_excerpt": null
    },
    "GB/T 5296.4-2012": {
      "standard_number": "GB/T 5296.4-2012",
      "name": "消费品使用说明 第4部分：纺织品和服装",
      "name_en": "Instructions for use of products of consumer interest - Part 4: Textiles and apparel",
      "standard_type": "推荐性国家标准",
      "status": "current",
      "status_text": "现行",
      "publication_date": "2012-12-31",
      "implementation_date": "2014-05-01",
      "ccs": "A12",
      "ics": "59.080.01;03.080.30",
      "competent_department": "国家标准委",
      "issuing_body": "中华人民共和国国家质量监督检验检疫总局、中国国家标准化管理委员会",
      "remarks": "2012年第42号公告 根据2017年第7号公告和强制性标准整合精简结论，自2017年3月23日起,该标准转化为推荐性标准，不再强制执行。",
      "official_source_url": "https://openstd.samr.gov.cn/bzgk/gb/showGb?type=online&hcno=E143935EB536F1260D189F833BA98302",
      "search_url": "https://openstd.samr.gov.cn/bzgk/gb/std_list?p.p1=0&p.p90=circulation_date&p.p91=desc&p.p2=GB%2FT%205296.4",
      "scope_summary": null,
      "scope_note": "公开页面不提供标准正文范围条款，需在官方\"在线预览\"中查阅原文后人工补录",
      "verification_status": "official_verified",
      "last_verified_at": "2026-10-23T06:29:46.716Z",
      "source_excerpt": null
    },
    "GB/T 29862-2013": {
      "standard_number": "GB/T 29862-2013",
      "name": "纺织品  纤维含量的标识",
      "name_en": "Textiles - Identification of fiber content",
      "standard_type": "推荐性国家标准",
      "status": "current",
      "status_text": "现行",
      "publication_date": "2013-11-12",
      "implementation_date": "2014-05-01",
      "ccs": "W04",
      "ics": "59.080.01",
      "competent_department": "中国纺织工业联合会",
      "issuing_body": "中华人民共和国国家质量监督检验检疫总局、中国国家标准化管理委员会",
      "remarks": null,
      "official_source_url": "https://openstd.samr.gov.cn/bzgk/gb/showGb?type=online&hcno=78E12DC297A27F3AB95C25986FD71586",
      "search_url": "https://openstd.samr.gov.cn/bzgk/gb/std_list?p.p1=0&p.p90=circulation_date&p.p91=desc&p.p2=GB%2FT%2029862",
      "scope_summary": null,
      "scope_note": "公开页面不提供标准正文范围条款，需在官方\"在线预览\"中查阅原文后人工补录",
      "verification_status": "official_verified",
      "last_verified_at": "2026-10-23T06:29:50.502Z",
      "source_excerpt": null
    },
    "GB/T 22849-2024": {
      "standard_number": "GB/T 22849-2024",
      "name": "针织T恤衫",
      "name_en": "Knitted T-shirt",
      "standard_type": "推荐性国家标准",
      "status": "current",
      "status_text": "现行",
      "publication_date": "2024-03-15",
      "implementation_date": "2024-10-01",
      "ccs": "W63",
      "ics": "59.080.30",
      "competent_department": "中国纺织工业联合会",
      "issuing_body": "国家市场监督管理总局        国家标准化管理委员会",
      "remarks": null,
      "official_source_url": "https://openstd.samr.gov.cn/bzgk/gb/showGb?type=online&hcno=0D814A3BC1F06628D101E8535F6C7997",
      "search_url": "https://openstd.samr.gov.cn/bzgk/gb/std_list?p.p1=0&p.p90=circulation_date&p.p91=desc&p.p2=GB%2FT%2022849",
      "scope_summary": null,
      "scope_note": "公开页面不提供标准正文范围条款，需在官方\"在线预览\"中查阅原文后人工补录",
      "verification_status": "official_verified",
      "last_verified_at": "2026-10-23T06:29:54.985Z",
      "source_excerpt": null
    },
    "GB/T 2660-2017": {
      "standard_number": "GB/T 2660-2017",
      "name": "衬衫",
      "name_en": "Shirts and blouses",
      "standard_type": "推荐性国家标准",
      "status": "current",
      "status_text": "现行",
      "publication_date": "2017-05-12",
      "implementation_date": "2017-12-01",
      "ccs": "Y76",
      "ics": "61.020",
      "competent_department": "中国纺织工业联合会",
      "issuing_body": "中华人民共和国国家质量监督检验检疫总局、中国国家标准化管理委员会",
      "remarks": null,
      "official_source_url": "https://openstd.samr.gov.cn/bzgk/gb/showGb?type=online&hcno=1A332C5B802EC31E7C1ED95E2E174C4B",
      "search_url": "https://openstd.samr.gov.cn/bzgk/gb/std_list?p.p1=0&p.p90=circulation_date&p.p91=desc&p.p2=GB%2FT%202660",
      "scope_summary": null,
      "scope_note": "公开页面不提供标准正文范围条款，需在官方\"在线预览\"中查阅原文后人工补录",
      "verification_status": "official_verified",
      "last_verified_at": "2026-10-23T06:29:58.183Z",
      "source_excerpt": null
    },
    "GB/T 2664-2017": {
      "standard_number": "GB/T 2664-2017",
      "name": "男西服、大衣",
      "name_en": "Men's suits and coats",
      "standard_type": "推荐性国家标准",
      "status": "current",
      "status_text": "现行",
      "publication_date": "2017-12-29",
      "implementation_date": "2018-07-01",
      "ccs": "Y76",
      "ics": "61.020",
      "competent_department": "中国纺织工业联合会",
      "issuing_body": "中华人民共和国国家质量监督检验检疫总局、中国国家标准化管理委员会",
      "remarks": null,
      "official_source_url": "https://openstd.samr.gov.cn/bzgk/gb/showGb?type=online&hcno=346466004A5CD694BACB0721FB80733E",
      "search_url": "https://openstd.samr.gov.cn/bzgk/gb/std_list?p.p1=0&p.p90=circulation_date&p.p91=desc&p.p2=GB%2FT%202664",
      "scope_summary": null,
      "scope_note": "公开页面不提供标准正文范围条款，需在官方\"在线预览\"中查阅原文后人工补录",
      "verification_status": "official_verified",
      "last_verified_at": "2026-10-23T06:30:01.489Z",
      "source_excerpt": null
    },
    "GB/T 2665-2017": {
      "standard_number": "GB/T 2665-2017",
      "name": "女西服、大衣",
      "name_en": "Women’s suits and coats",
      "standard_type": "推荐性国家标准",
      "status": "current",
      "status_text": "现行",
      "publication_date": "2017-12-29",
      "implementation_date": "2018-07-01",
      "ccs": "Y76",
      "ics": "61.020",
      "competent_department": "中国纺织工业联合会",
      "issuing_body": "中华人民共和国国家质量监督检验检疫总局、中国国家标准化管理委员会",
      "remarks": null,
      "official_source_url": "https://openstd.samr.gov.cn/bzgk/gb/showGb?type=online&hcno=0D9CDD6CBC5C2C789E3E74B1448AA139",
      "search_url": "https://openstd.samr.gov.cn/bzgk/gb/std_list?p.p1=0&p.p90=circulation_date&p.p91=desc&p.p2=GB%2FT%202665",
      "scope_summary": null,
      "scope_note": "公开页面不提供标准正文范围条款，需在官方\"在线预览\"中查阅原文后人工补录",
      "verification_status": "official_verified",
      "last_verified_at": "2026-10-23T06:30:04.611Z",
      "source_excerpt": null
    },
    "GB/T 14272-2021": {
      "standard_number": "GB/T 14272-2021",
      "name": "羽绒服装",
      "name_en": "Down garments",
      "standard_type": "推荐性国家标准",
      "status": "current",
      "status_text": "现行",
      "publication_date": "2021-03-09",
      "implementation_date": "2022-04-01",
      "ccs": "Y76",
      "ics": "61.020",
      "competent_department": "中国纺织工业联合会",
      "issuing_body": "国家市场监督管理总局、中国国家标准化管理委员会",
      "remarks": null,
      "official_source_url": "https://openstd.samr.gov.cn/bzgk/gb/showGb?type=online&hcno=4C8640CD45AB3F46C5D9A990D4E8DC2F",
      "search_url": "https://openstd.samr.gov.cn/bzgk/gb/std_list?p.p1=0&p.p90=circulation_date&p.p91=desc&p.p2=GB%2FT%2014272",
      "scope_summary": null,
      "scope_note": "公开页面不提供标准正文范围条款，需在官方\"在线预览\"中查阅原文后人工补录",
      "verification_status": "official_verified",
      "last_verified_at": "2026-10-23T06:30:08.311Z",
      "source_excerpt": null
    },
    "GB/T 22700-2016": {
      "standard_number": "GB/T 22700-2016",
      "name": "水洗整理服装",
      "name_en": "Washed garments",
      "standard_type": "推荐性国家标准",
      "status": "current",
      "status_text": "现行",
      "publication_date": "2016-12-13",
      "implementation_date": "2017-07-01",
      "ccs": "Y76",
      "ics": "61.020",
      "competent_department": "中国纺织工业联合会",
      "issuing_body": "中华人民共和国国家质量监督检验检疫总局、中国国家标准化管理委员会",
      "remarks": null,
      "official_source_url": "https://openstd.samr.gov.cn/bzgk/gb/showGb?type=online&hcno=920090D54B2EB3F364F633585CFCA78D",
      "search_url": "https://openstd.samr.gov.cn/bzgk/gb/std_list?p.p1=0&p.p90=circulation_date&p.p91=desc&p.p2=GB%2FT%2022700",
      "scope_summary": null,
      "scope_note": "公开页面不提供标准正文范围条款，需在官方\"在线预览\"中查阅原文后人工补录",
      "verification_status": "official_verified",
      "last_verified_at": "2026-10-23T06:30:12.181Z",
      "source_excerpt": null
    },
    "FZ/T 73020": {
      "standard_number": "FZ/T 73020",
      "verification_status": "pending_verification",
      "note": "行业标准（FZ/QB 等）不在\"国家标准全文公开系统\"范围内，需到行业标准信息服务平台 hbba.sacinfo.org.cn 或发布部门官网核验；本次未获取到官方数据",
      "official_source_url": "https://hbba.sacinfo.org.cn/",
      "search_url": "https://openstd.samr.gov.cn/bzgk/gb/std_list?p.p1=0&p.p90=circulation_date&p.p91=desc&p.p2=FZ%2FT%2073020",
      "last_verified_at": "2026-10-23T06:30:14.560Z"
    },
    "FZ/T 81007": {
      "standard_number": "FZ/T 81007",
      "verification_status": "pending_verification",
      "note": "行业标准（FZ/QB 等）不在\"国家标准全文公开系统\"范围内，需到行业标准信息服务平台 hbba.sacinfo.org.cn 或发布部门官网核验；本次未获取到官方数据",
      "official_source_url": "https://hbba.sacinfo.org.cn/",
      "search_url": "https://openstd.samr.gov.cn/bzgk/gb/std_list?p.p1=0&p.p90=circulation_date&p.p91=desc&p.p2=FZ%2FT%2081007",
      "last_verified_at": "2026-10-23T06:30:17.461Z"
    }
  }
};

  };
  defs["core/data/standards.meta.js"] = function (module, exports, require) {
/**
 * 标准的人工编辑元数据（不是官方页面字段）。
 *
 * 为什么要单独一个文件：
 * - openstd 的公开页面只给"标准号/名称/状态/日期/主管单位"，**不给**范围条文和条款内容；
 * - 所以凡是"适用范围""管控项目"这类信息，要么来自标准正文（需人工查阅后录入），
 *   要么只能从**标准名称**做保守推断。两者必须分开标注，不能混成"官方核验"。
 *
 * 字段口径：
 * - applicability_by_name: 仅由标准名称推导，applicability_basis = 'standard_name'
 * - key_requirement_topics: 公开科普/标准摘要层面常见的管控项目类别，**不含条款号与限值**，
 *   key_requirements_verified=false 表示未逐条核对正文
 */

'use strict';

const META = {
  'GB 18401': {
    role: '基本安全要求（强制性）',
    applies_to_all_textiles: true,
    applicability_by_name: ['纺织产品（服装、家用纺织品等）'],
    applicability_basis: 'standard_name',
    key_requirement_topics: [
      '甲醛含量',
      'pH 值',
      '色牢度（耐水、耐汗渍、耐干摩擦等）',
      '异味',
      '可分解致癌芳香胺染料'
    ],
    key_requirements_verified: false,
    notes: [
      '产品标注 GB 18401 只说明商家声称执行该强制性标准，不构成"实物已检测合格"的证明。',
      '安全类别（A/B/C 类）与产品用途相关，具体判定需按标准正文与产品实际用途核对。'
    ]
  },
  'GB 31701': {
    role: '婴幼儿及儿童纺织产品安全要求（强制性）',
    applicable_categories: ['童装', '婴幼儿服装'],
    applicability_by_name: ['婴幼儿及儿童纺织产品'],
    applicability_basis: 'standard_name',
    key_requirement_topics: ['绳带要求', '附件抗拉强力', '重金属', '燃烧性能', '基本安全项目'],
    key_requirements_verified: false,
    notes: ['只适用于婴幼儿及儿童纺织产品；成人服装不应引用本标准作为安全类别依据。']
  },
  'GB/T 5296.4': {
    role: '使用说明（标识）要求（推荐性）',
    applies_to_all_textiles: true,
    applicability_by_name: ['纺织品和服装的使用说明'],
    applicability_basis: 'standard_name',
    key_requirement_topics: ['制造者名称与地址', '产品名称', '号型或规格', '纤维成分及含量', '维护方法', '执行的产品标准', '安全类别'],
    key_requirements_verified: false,
    notes: ['这是"标签该怎么写"的标准，不是"衣服质量好不好"的标准。']
  },
  'GB/T 29862': {
    role: '纤维含量标识要求（推荐性）',
    applies_to_all_textiles: true,
    applicability_by_name: ['纺织品纤维含量的标识'],
    applicability_basis: 'standard_name',
    key_requirement_topics: ['纤维名称规范', '含量允差', '标识方式'],
    key_requirements_verified: false,
    notes: ['标注的纤维含量是否真实，需要检测才能确认；本标准规定的是"如何标识"。']
  },
  'GB/T 22849': {
    role: '产品标准（推荐性）',
    applicable_categories: ['T恤'],
    applicability_by_name: ['针织T恤衫'],
    applicability_basis: 'standard_name',
    key_requirement_topics: ['内在质量（如顶破强力、起球、水洗尺寸变化率等）', '外观质量', '标识要求'],
    key_requirements_verified: false,
    notes: ['2024 版已发布，旧版（2014）在此日期后标注的商品需要留意版本。']
  },
  'GB/T 2660': {
    role: '产品标准（推荐性）',
    applicable_categories: ['衬衫'],
    applicability_by_name: ['衬衫'],
    applicability_basis: 'standard_name',
    key_requirement_topics: ['理化性能', '外观质量', '标识'],
    key_requirements_verified: false,
    notes: []
  },
  'GB/T 2664': {
    role: '产品标准（推荐性）',
    applicable_categories: ['西装', '大衣'],
    applicability_by_name: ['男西服、大衣'],
    applicability_basis: 'standard_name',
    key_requirement_topics: ['理化性能', '外观质量', '标识'],
    key_requirements_verified: false,
    notes: ['名称限定"男"，女装对应 GB/T 2665。']
  },
  'GB/T 2665': {
    role: '产品标准（推荐性）',
    applicable_categories: ['西装', '大衣'],
    applicability_by_name: ['女西服、大衣'],
    applicability_basis: 'standard_name',
    key_requirement_topics: ['理化性能', '外观质量', '标识'],
    key_requirements_verified: false,
    notes: ['名称限定"女"，男装对应 GB/T 2664。']
  },
  'GB/T 14272': {
    role: '产品标准（推荐性）',
    applicable_categories: ['羽绒服'],
    applicability_by_name: ['羽绒服装'],
    applicability_basis: 'standard_name',
    key_requirement_topics: ['羽绒品质相关项目', '理化性能', '外观质量', '标识'],
    key_requirements_verified: false,
    notes: ['填充物为羽绒的服装才适用；棉服、夹棉外套不应引用本标准。']
  },
  'GB/T 22700': {
    role: '产品标准（推荐性）',
    applicable_categories: ['牛仔裤', '休闲裤'],
    applicability_by_name: ['水洗整理服装'],
    applicability_basis: 'standard_name',
    key_requirement_topics: ['水洗尺寸变化率', '理化性能', '外观质量'],
    key_requirements_verified: false,
    notes: ['适用于经水洗整理的服装，不是所有牛仔类商品的通用标准。']
  },
  'FZ/T 73020': {
    role: '行业产品标准（推荐性）',
    applicable_categories: ['T恤', '卫衣'],
    applicability_by_name: ['针织休闲服装'],
    applicability_basis: 'standard_name',
    key_requirement_topics: ['未录入（需查阅行业标准正文）'],
    key_requirements_verified: false,
    notes: ['行业标准不在国家标准全文公开系统范围内，状态需在行业标准平台人工核验。']
  },
  'FZ/T 81007': {
    role: '行业产品标准（推荐性）',
    applicable_categories: ['休闲裤', '半身裙'],
    applicability_by_name: ['单、夹服装'],
    applicability_basis: 'standard_name',
    key_requirement_topics: ['未录入（需查阅行业标准正文）'],
    key_requirements_verified: false,
    notes: ['行业标准不在国家标准全文公开系统范围内，状态需在行业标准平台人工核验。']
  }
};

/** 常见品类 → 可能被引用的产品标准（顺序即建议优先度），仅作"该查哪些标准"的提示 */
const CATEGORY_STANDARD_HINTS = {
  T恤: ['GB/T 22849', 'FZ/T 73020', 'GB 18401', 'GB/T 5296.4'],
  衬衫: ['GB/T 2660', 'GB 18401', 'GB/T 5296.4'],
  西装: ['GB/T 2664', 'GB/T 2665', 'GB 18401'],
  大衣: ['GB/T 2664', 'GB/T 2665', 'GB 18401'],
  羽绒服: ['GB/T 14272', 'GB 18401', 'GB/T 5296.4'],
  牛仔裤: ['GB/T 22700', 'GB 18401', 'GB/T 5296.4'],
  休闲裤: ['FZ/T 81007', 'GB/T 22700', 'GB 18401'],
  半身裙: ['FZ/T 81007', 'GB 18401', 'GB/T 5296.4'],
  连衣裙: ['GB 18401', 'GB/T 5296.4', 'GB/T 29862'],
  卫衣: ['FZ/T 73020', 'GB 18401', 'GB/T 5296.4'],
  羊毛衫: ['GB 18401', 'GB/T 5296.4', 'GB/T 29862'],
  风衣: ['FZ/T 81007', 'GB 18401'],
  内衣: ['GB 18401', 'GB/T 5296.4'],
  童装: ['GB 31701', 'GB 18401', 'GB/T 5296.4']
};

module.exports = { META, CATEGORY_STANDARD_HINTS };

  };
  defs["core/fabric.js"] = function (module, exports, require) {
/**
 * fabric-reference：克重/支数的"同类参考"评估。
 *
 * 这一层刻意**不给高/中/低品质评级**：
 * - 克重参考区间来自公开资料，不是本项目抽样实测，因此只能标 reference_only；
 * - 支数连参考区间都不给（不同体系不可比、样本不足），只做"已知信息 + 口径提醒"。
 * 规范 7.1/7.2/7.3/7.5 的要求都落在这里。
 */

'use strict';

/**
 * 参考区间表。samples=0 表示本项目没有实测样本，只有公开资料区间。
 * 更新时必须同步 updated_at。
 */
const WEIGHT_REFERENCES = {
  T恤: {
    label: '短袖T恤（针织，单面/双面）',
    min: 140,
    max: 240,
    typical: '150–200',
    samples: 0,
    source: '公开纺织/电商科普中的常见克重描述区间',
    updated_at: '2026-10-20'
  },
  卫衣: {
    label: '卫衣（针织，抓绒/毛圈）',
    min: 240,
    max: 420,
    typical: '280–380',
    samples: 0,
    source: '公开纺织/电商科普中的常见克重描述区间',
    updated_at: '2026-10-20'
  },
  衬衫: {
    label: '衬衫（梭织）',
    min: 100,
    max: 180,
    typical: '110–140',
    samples: 0,
    source: '公开纺织/电商科普中的常见克重描述区间',
    updated_at: '2026-10-20'
  },
  牛仔裤: {
    label: '牛仔（梭织，斜纹）',
    min: 280,
    max: 480,
    typical: '320–400',
    samples: 0,
    source: '公开纺织/电商科普中的常见克重描述区间',
    updated_at: '2026-10-20'
  }
};

/**
 * @param {{category?:string, weightField?:object, garmentWeightField?:object}} input
 */
function assessWeight(input) {
  const { category, weightField, garmentWeightField } = input || {};
  const base = {
    status: 'insufficient_reference',
    value: null,
    unit: null,
    category: category || null,
    reference: null,
    position: null,
    message: '',
    limits: [
      '克重是面料单位面积质量，不能直接等同"厚不厚""暖不暖"；组织与纤维同样重要',
      '不同品类的克重不可横向比较（短袖T恤与羊毛大衣没有可比性）'
    ]
  };

  if (garmentWeightField && garmentWeightField.normalized_value != null && !weightField) {
    return {
      ...base,
      status: 'incomparable',
      value: garmentWeightField.normalized_value,
      unit: garmentWeightField.unit,
      message: '截图里只有"成衣重量"，没有"面料克重"，两者量纲不同，不能换算也不做评级',
      reference: null
    };
  }

  if (!weightField || weightField.normalized_value == null) {
    return {
      ...base,
      status: 'missing',
      message: '当前材料没有提供面料克重，系统不会估算具体数值；可向商家索取克重或面料参数'
    };
  }

  const value = Number(weightField.normalized_value);
  const unit = weightField.unit;
  if (weightField.status === 'pending_verification' || !unit) {
    return {
      ...base,
      status: 'ambiguous',
      value,
      unit: unit || null,
      message: weightField.evidence_note || '数值单位不明确，无法判断是 g/m² 还是成衣克重'
    };
  }
  if (unit !== 'g/m²') {
    return {
      ...base,
      status: 'incomparable',
      value,
      unit,
      message: '这不是面料单位面积质量（g/m²），不参与同类克重比较'
    };
  }

  const ref = WEIGHT_REFERENCES[category];
  if (!ref) {
    return {
      ...base,
      status: 'insufficient_reference',
      value,
      unit,
      message: `已记录克重 ${value} g/m²，但「${category || '该品类'}」没有可用的同类参考区间，因此不给评级`,
      reference: null
    };
  }

  let position = 'in_range';
  if (value < ref.min) position = 'below_range';
  else if (value > ref.max) position = 'above_range';

  return {
    ...base,
    status: 'reference_only',
    value,
    unit,
    position,
    reference: {
      label: ref.label,
      min: ref.min,
      max: ref.max,
      typical: ref.typical,
      samples: ref.samples,
      source: ref.source,
      updated_at: ref.updated_at
    },
    message:
      `已记录克重 ${value} g/m²，落在公开资料给出的 ${ref.label} 参考区间 ${ref.min}–${ref.max} g/m² 之${position === 'in_range' ? '内' : position === 'below_range' ? '下' : '上'}。` +
      '这是区间对照，不是品质评级（本项目没有实测样本）。',
    limits: [
      ...base.limits,
      '参考区间 samples=0，仅来自公开资料，未经本项目抽样验证',
      '未考虑纤维种类、组织密度与后整理，不能据此判断保暖或耐用'
    ]
  };
}

/**
 * 支数：只做"已知/口径"说明，绝不给高低。
 */
function assessYarnCount(yarnField) {
  const out = {
    status: 'insufficient_reference',
    value: null,
    system: null,
    message: '',
    limits: [
      '支数体系（英制 S / 公制 Nm / 特数 tex / 旦数 D）不同，数值不可直接排名',
      '支数高只说明纱线更细，不代表更耐穿或更好；细纱更柔软但强度与起球表现取决于原料与捻度',
      '本项目没有同类样本数据库，不提供支数评级'
    ]
  };
  if (!yarnField || yarnField.normalized_value == null) {
    return { ...out, status: 'missing', message: '当前材料没有支数信息，系统不做推测' };
  }
  const system = /英制|\(S\)/.test(String(yarnField.normalized_value)) ? '英制支数(S)' : /Nm/.test(String(yarnField.normalized_value)) ? '公制支数(Nm)' : /tex/.test(String(yarnField.normalized_value)) ? '特数(tex)' : /\(D\)/.test(String(yarnField.normalized_value)) ? '旦数(D)' : null;
  return {
    ...out,
    status: system ? 'known_unrated' : 'ambiguous_system',
    value: yarnField.normalized_value,
    system,
    message: system
      ? `已记录 ${yarnField.normalized_value}；仅有口径信息，不做品质评级`
      : '支数体系不明，不同体系不可比，需向商家确认口径'
  };
}

module.exports = { assessWeight, assessYarnCount, WEIGHT_REFERENCES };

  };
  defs["core/knowledge.js"] = function (module, exports, require) {
/**
 * textile-knowledge-service：面料知识查询与"成分 → 特性/洗护提示"的映射。
 *
 * 注意：这里给的是**通用纤维特性**，不是当前单件衣服的实测表现（规范 5.2 第 10 条）。
 * 所有输出都带 disclaimer，展示层必须保留。
 */

'use strict';

const { FIBERS, STRUCTURES, CARE_SYMBOLS, CARE_BY_FIBER, UPDATED_AT } = require('./data/knowledge.data');

const DISCLAIMER = '以下为该纤维/组织的通用特性，不是对这件衣服的实测结论；实际表现受纱线、密度、后整理影响。';

function allEntries() {
  return [
    ...FIBERS.map((f) => ({ ...f, kind: 'fiber' })),
    ...STRUCTURES.map((s) => ({ ...s, kind: 'structure' }))
  ];
}

function findByName(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const entries = allEntries();
  const exact = entries.find((e) => e.name === n || e.name.indexOf(n) >= 0);
  if (exact) return exact;
  const aliasMap = {
    涤纶: '聚酯纤维',
    尼龙: '锦纶',
    天丝: '莱赛尔纤维',
    人造棉: '粘胶纤维',
    人棉: '粘胶纤维',
    桑蚕丝: '蚕丝',
    真丝: '蚕丝',
    棉麻: null
  };
  const alias = aliasMap[n];
  if (alias) return entries.find((e) => e.name.indexOf(alias) >= 0) || null;
  return null;
}

function search(keyword) {
  const q = String(keyword || '').trim().toLowerCase();
  const entries = allEntries();
  if (!q) return entries;
  return entries.filter(
    (e) =>
      e.name.toLowerCase().includes(q) ||
      (e.plain || '').toLowerCase().includes(q) ||
      (e.common_uses || []).some((u) => u.toLowerCase().includes(q))
  );
}

/**
 * 成分列表 → 面料参考区块数据。
 * @param {Array<{fiber:string, percent:number}>} items
 */
function composeFabricNotes(items) {
  const list = Array.isArray(items) ? items : [];
  const notes = [];
  for (const item of list) {
    const entry = findByName(item.fiber);
    if (!entry) {
      notes.push({
        fiber: item.fiber,
        percent: item.percent,
        found: false,
        plain: '知识库暂未收录该纤维，未做特性推断',
        pros: [],
        cons: [],
        care: [],
        needs_review: true
      });
      continue;
    }
    notes.push({
      fiber: entry.name,
      percent: item.percent,
      found: true,
      plain: entry.plain,
      pros: entry.pros,
      cons: entry.cons,
      factors: entry.factors,
      note_on_quality: entry.note_on_quality || null,
      care: CARE_BY_FIBER[entry.name] || [],
      sources: entry.sources,
      needs_review: entry.needs_review
    });
  }

  const dominant = list.slice().sort((a, b) => (b.percent || 0) - (a.percent || 0))[0] || null;
  const hasSpandex = list.some((i) => /氨纶/.test(i.fiber));
  const allNatural = list.length > 0 && list.every((i) => /棉|羊毛|羊绒|蚕丝|亚麻|麻/.test(i.fiber));

  const summary = [];
  if (dominant) {
    summary.push(`主要成分是${dominant.fiber}（${dominant.percent}%），它的特性在很大程度上决定这件衣服的手感与洗护方式。`);
  }
  if (hasSpandex) {
    const pct = list.filter((i) => /氨纶/.test(i.fiber)).reduce((s, i) => s + (i.percent || 0), 0);
    summary.push(`含氨纶 ${pct}%，会有一定弹性；氨纶怕高温，熨烫与烘干温度要控制。`);
  }
  if (allNatural) {
    summary.push('成分均为天然纤维，通常吸湿透气较好，但抗皱与尺寸稳定性一般需要靠后整理或混纺改善。');
  }
  if (list.length >= 3) {
    summary.push('成分较复杂（三种及以上），不同部位/批次的表现可能不一致，建议核对各部件标注。');
  }

  return {
    items: notes,
    summary,
    disclaimer: DISCLAIMER,
    updated_at: UPDATED_AT,
    coverage: {
      known: notes.filter((n) => n.found).length,
      unknown: notes.filter((n) => !n.found).length
    }
  };
}

/** 根据洗护文本/符号给解释 */
function explainCare(careText) {
  const text = String(careText || '');
  const matched = CARE_SYMBOLS.filter((s) => text.includes(s.text));
  const keywords = [
    { re: /不可水洗/, text: '不可水洗' },
    { re: /手洗/, text: '手洗' },
    { re: /干洗/, text: '干洗' },
    { re: /不可漂白|勿漂白/, text: '不可漂白' },
    { re: /低温熨烫|中温熨烫|熨烫/, text: '熨烫' },
    { re: /悬挂晾干|晾干/, text: '晾干' },
    { re: /平摊|平铺/, text: '平摊晾干' },
    { re: /不可烘干/, text: '不可烘干' },
    { re: /分开洗涤|单独洗涤/, text: '分开洗涤' },
    { re: /30|40|30℃|40℃/, text: '水温限制' }
  ];
  const hits = keywords.filter((k) => k.re.test(text)).map((k) => k.text);
  return {
    raw: text || null,
    has_text: Boolean(text.trim()),
    symbols: matched,
    keywords: hits,
    from_label: Boolean(text.trim()),
    note: text.trim()
      ? '以上为标签原文的解释；标签没写的项目，本系统不会替你补。'
      : '当前材料没有洗护标签信息；下面是基于成分的一般参考，不能替代商品标签。'
  };
}

module.exports = { allEntries, findByName, search, composeFabricNotes, explainCare, CARE_SYMBOLS, DISCLAIMER, UPDATED_AT };

  };
  defs["core/data/knowledge.data.js"] = function (module, exports, require) {
/**
 * 面料知识库（fabric knowledge）。
 *
 * 口径声明（很重要）：
 * - 这里是**通用纤维特性**，不是对某件衣服的实测结论；
 * - 内容来自公开纺织科普与行业通行解释，不含标准条款原文；
 * - needs_review=true 表示尚未经过纺织专业人员逐条审校，界面上必须显示这一点；
 * - 每条都带 sources 与 updated_at，便于追溯。
 */

'use strict';

const UPDATED_AT = '2026-10-20';

const FIBERS = [
  {
    id: 'cotton',
    name: '棉',
    definition: '从棉属植物种子表面取得的天然纤维素纤维。',
    plain: '最常见的天然纤维，贴身、吸汗、洗得动，但容易皱、干得慢。',
    common_uses: ['T恤', '衬衫', '内衣', '牛仔', '床品'],
    pros: ['吸湿性较好，出汗后相对不闷', '亲肤，敏感肌常见选择', '耐碱，常规洗涤方便', '湿强度尚可'],
    cons: ['容易起皱，需要熨烫', '缩水风险取决于面料是否预缩', '长时间潮湿环境易滋生微生物', '深色棉易掉色/泛白'],
    factors: ['纱线支数与捻度', '针织还是梭织', '是否丝光/预缩整理', '克重与密度', '染色工艺'],
    note_on_quality: '棉不等于好，也不等于差；同样是纯棉，纱线、组织和后整理差别很大。',
    sources: ['公开纺织材料学与行业科普资料（非标准条文）'],
    needs_review: true
  },
  {
    id: 'polyester',
    name: '聚酯纤维（涤纶）',
    definition: '以聚对苯二甲酸乙二醇酯为主的合成纤维。',
    plain: '强度高、抗皱、干得快，价格稳定；但吸湿差，闷汗，易起静电和起球。',
    common_uses: ['运动服', '外套', '里料', '填充物', '快干衣'],
    pros: ['强度与耐磨性好', '不易皱，形状稳定', '干得快', '成本低，色泽牢度较好'],
    cons: ['吸湿性差，闷热时体感不佳', '易起静电、吸灰', '部分结构易起球', '热定型不当会发硬'],
    factors: ['是否异形截面（导湿）', '是否与棉/氨纶混纺', '织物密度', '后整理（亲水、抗静电、抗起球）'],
    note_on_quality: '聚酯纤维本身不是缺点，运动/外套场景常是合理选择；问题在于用在贴身夏装且无导湿整理。',
    sources: ['公开纺织材料学与行业科普资料（非标准条文）'],
    needs_review: true
  },
  {
    id: 'wool',
    name: '羊毛',
    definition: '从绵羊身上取得的动物毛纤维。',
    plain: '保暖、有弹性、回潮率高；但会扎、会缩绒，洗护要求高。',
    common_uses: ['毛衣', '大衣', '西服', '围巾'],
    pros: ['保暖性好', '弹性与回复性好，不易变形', '吸湿后仍有一定保暖性', '天然抗异味能力较好'],
    cons: ['部分纤维直径较粗，贴身可能刺痒', '机洗易缩绒（毡化）', '易被虫蛀，需存放注意', '起球较常见'],
    factors: ['纤维细度（微米数）', '纱线捻度', '是否防缩处理', '织物结构（针织/精纺）'],
    note_on_quality: '羊毛品质与纤维细度、长度、纺纱工艺关系密切，仅看"100% 羊毛"不足以判断手感与耐用度。',
    sources: ['公开纺织材料学与行业科普资料（非标准条文）'],
    needs_review: true
  },
  {
    id: 'cashmere',
    name: '羊绒',
    definition: '山羊体表底层细绒纤维。',
    plain: '更细更轻更软，保暖好但强度低、易起球，价格高，需要谨慎洗护。',
    common_uses: ['羊绒衫', '围巾', '大衣面料'],
    pros: ['纤维细，手感柔软', '同等保暖下更轻', '垂坠感好'],
    cons: ['耐磨性弱，易起球', '价格高，真假混杂风险大', '洗护要求高'],
    factors: ['纤维细度与长度', '混纺比例', '纺纱方式'],
    note_on_quality: '"羊绒感"是营销词，不等于含羊绒；需看成分标注与检测报告。',
    sources: ['公开纺织材料学与行业科普资料（非标准条文）'],
    needs_review: true
  },
  {
    id: 'silk',
    name: '蚕丝（真丝）',
    definition: '由蚕茧缫得的天然蛋白质纤维。',
    plain: '光泽好、轻薄顺滑、吸湿透气；但怕晒、怕汗、易勾丝，洗护讲究。',
    common_uses: ['衬衫', '连衣裙', '睡衣', '围巾'],
    pros: ['手感顺滑，悬垂性好', '吸湿透气', '光泽自然'],
    cons: ['强度在湿态下降，易勾丝', '耐光性差，久晒易泛黄', '洗护要求高，多需手洗或干洗'],
    factors: ['桑蚕丝/柞蚕丝', '织物组织（电力纺、雪纺、缎面）', '后整理'],
    note_on_quality: '"真丝"标注也需要区分桑蚕丝与柞蚕丝，两者手感与价格差别明显。',
    sources: ['公开纺织材料学与行业科普资料（非标准条文）'],
    needs_review: true
  },
  {
    id: 'linen',
    name: '亚麻',
    definition: '亚麻茎部韧皮纤维。',
    plain: '夏天凉快、吸湿快干、强度高；但易皱、手感偏硬，缩水与色牢度需留意。',
    common_uses: ['衬衫', '连衣裙', '裤子'],
    pros: ['导热性好，接触凉感明显', '吸湿快干', '强度高，耐用'],
    cons: ['极易起皱', '初次穿着手感偏硬', '缩水率与水洗尺寸变化需关注'],
    factors: ['纱线细度', '是否混纺（棉麻、粘麻）', '水洗/柔软整理'],
    note_on_quality: '棉麻混纺常用来改善手感，混纺比例直接影响体验。',
    sources: ['公开纺织材料学与行业科普资料（非标准条文）'],
    needs_review: true
  },
  {
    id: 'viscose',
    name: '粘胶纤维',
    definition: '以纤维素为原料经再生纺丝得到的纤维。',
    plain: '手感柔软、悬垂好、吸湿强；但湿态强度低、易缩水、易皱。',
    common_uses: ['衬衫', '连衣裙', '里料', '针织衫'],
    pros: ['柔软亲肤', '悬垂性好', '吸湿性优于多数合成纤维'],
    cons: ['湿态强度低，拧干易变形', '缩水与尺寸稳定性需注意', '易皱'],
    factors: ['纺丝工艺', '是否与涤纶/氨纶混纺', '织物结构'],
    note_on_quality: '"人棉""冰丝"常指粘胶类，术语不统一，需看成分标注。',
    sources: ['公开纺织材料学与行业科普资料（非标准条文）'],
    needs_review: true
  },
  {
    id: 'modal',
    name: '莫代尔',
    definition: '以木浆为原料的高湿模量再生纤维素纤维。',
    plain: '比普通粘胶更柔软、更耐洗一些，贴身舒适，但同样怕热水与大力拧绞。',
    common_uses: ['内衣', 'T恤', '家居服'],
    pros: ['柔软顺滑', '吸湿透气', '尺寸稳定性优于普通粘胶'],
    cons: ['长期摩擦仍可能起球', '需低温洗护', '深色易掉色'],
    factors: ['原料与工艺', '混纺比例', '织物密度'],
    note_on_quality: '莫代尔是商品名类别，不同厂商品质差异来自工艺而非名称。',
    sources: ['公开纺织材料学与行业科普资料（非标准条文）'],
    needs_review: true
  },
  {
    id: 'lyocell',
    name: '莱赛尔纤维（天丝类）',
    definition: '以纤维素为原料、用溶剂法纺丝的再生纤维。',
    plain: '吸湿好、柔软有光泽、垂坠感强；但同样怕热水与摩擦起毛。',
    common_uses: ['衬衫', '连衣裙', '家居服'],
    pros: ['干湿强度较好', '悬垂与光泽好', '吸湿透气'],
    cons: ['摩擦后易起毛/起球', '需温和洗护', '价格高于普通粘胶'],
    factors: ['纤维规格', '织物组织', '后整理'],
    note_on_quality: '"天丝"是商标名，标注莱赛尔才是纤维名称。',
    sources: ['公开纺织材料学与行业科普资料（非标准条文）'],
    needs_review: true
  },
  {
    id: 'spandex',
    name: '氨纶',
    definition: '以聚氨酯为主的弹性纤维。',
    plain: '少量加入就能让衣服有弹性；但怕高温、怕氯，久了会失去弹性。',
    common_uses: ['紧身衣', '牛仔裤', '运动服', '内衣'],
    pros: ['高弹性回复', '少量添加即可改善活动度', '与外层纤维混纺方便'],
    cons: ['耐热性差，高温熨烫易损伤', '长期使用弹性衰减', '耐氯性差（泳池）'],
    factors: ['添加比例', '包覆工艺', '使用与洗护方式'],
    note_on_quality: '2%~5% 氨纶与 10% 以上氨纶的手感与用途完全不同，比例比"有没有"更重要。',
    sources: ['公开纺织材料学与行业科普资料（非标准条文）'],
    needs_review: true
  },
  {
    id: 'nylon',
    name: '锦纶（尼龙）',
    definition: '聚酰胺类合成纤维。',
    plain: '耐磨、强度高、轻；但吸湿差、易起静电、怕长时间日晒。',
    common_uses: ['运动外套', '泳衣', '袜子', '羽绒服面料'],
    pros: ['耐磨性突出', '强度高、重量轻', '弹性回复较好'],
    cons: ['吸湿差', '耐光性一般', '易起静电'],
    factors: ['纤维规格', '织物结构', '涂层/后整理'],
    note_on_quality: '锦纶常用于需要耐磨的面料，贴身舒适性要看具体组织与后整理。',
    sources: ['公开纺织材料学与行业科普资料（非标准条文）'],
    needs_review: true
  },
  {
    id: 'acrylic',
    name: '腈纶',
    definition: '聚丙烯腈类合成纤维。',
    plain: '像羊毛的合成纤维，轻、保暖、便宜；但易起球、易静电、吸湿差。',
    common_uses: ['毛衣', '仿羊毛外套', '围巾'],
    pros: ['保暖性较好', '色泽鲜艳、耐光', '成本低'],
    cons: ['易起球', '吸湿差，静电明显', '高温易变形'],
    factors: ['纤维规格', '混纺比例', '后整理'],
    note_on_quality: '腈纶常替代羊毛降低成本，标注"羊毛感"不等于含羊毛。',
    sources: ['公开纺织材料学与行业科普资料（非标准条文）'],
    needs_review: true
  },
  {
    id: 'acetate',
    name: '醋酯纤维',
    definition: '纤维素醋酸酯纤维。',
    plain: '光泽像丝绸、悬垂好；但强度较低、怕热、怕强碱。',
    common_uses: ['里料', '连衣裙', '礼服'],
    pros: ['光泽与悬垂好', '手感柔软'],
    cons: ['强度低，易勾丝', '耐热差', '洗护要求高'],
    factors: ['织物组织', '后整理'],
    note_on_quality: '多用于里料或需要光泽感的单品，耐用性预期要放低。',
    sources: ['公开纺织材料学与行业科普资料（非标准条文）'],
    needs_review: true
  }
];

const STRUCTURES = [
  {
    id: 'knit',
    name: '针织',
    definition: '由线圈相互串套形成的织物。',
    plain: '有弹性、贴身、活动方便；但易变形、易勾丝。',
    common_uses: ['T恤', '卫衣', '毛衣', '内衣'],
    pros: ['弹性与延伸性好', '手感柔软', '透气性通常较好'],
    cons: ['尺寸稳定性较弱', '易勾丝/起球', '悬挂久了会拉长'],
    factors: ['针距与密度', '纱线捻度', '是否罗纹/双面组织'],
    sources: ['公开纺织材料学与行业科普资料（非标准条文）'],
    needs_review: true
  },
  {
    id: 'woven',
    name: '梭织',
    definition: '由经纱与纬纱交织形成的织物。',
    plain: '结构稳定、挺括、不易变形；但弹性差，活动度靠版型补偿。',
    common_uses: ['衬衫', '西裤', '外套', '牛仔'],
    pros: ['尺寸稳定', '挺括、不易拉伸变形'],
    cons: ['弹性差', '部分组织手感偏硬', '缝口强力依赖工艺'],
    factors: ['组织（平纹/斜纹/缎纹）', '经纬密度', '纱线规格'],
    sources: ['公开纺织材料学与行业科普资料（非标准条文）'],
    needs_review: true
  },
  {
    id: 'twill',
    name: '斜纹',
    definition: '经（或纬）浮长线连续形成斜向纹路的织物组织。',
    plain: '比平纹更柔软、更耐磨，牛仔和风衣面料常见。',
    common_uses: ['牛仔', '风衣', '工装裤'],
    pros: ['密度高、耐磨', '手感比平纹柔软', '纹理明显'],
    cons: ['比平纹更重', '部分斜纹易磨白'],
    factors: ['纱线规格', '密度', '水洗整理'],
    sources: ['公开纺织材料学与行业科普资料（非标准条文）'],
    needs_review: true
  },
  {
    id: 'rib',
    name: '罗纹',
    definition: '由正面线圈纵行与反面线圈纵行相间配置的针织组织。',
    plain: '横向弹性很好，常用在领口、袖口、下摆。',
    common_uses: ['领口', '袖口', '下摆', '紧身针织'],
    pros: ['弹性回复好', '贴合不松垮'],
    cons: ['长期拉伸会疲劳', '易起球'],
    factors: ['针距', '氨纶添加', '纱线捻度'],
    sources: ['公开纺织材料学与行业科普资料（非标准条文）'],
    needs_review: true
  },
  {
    id: 'fleece',
    name: '抓绒/起绒',
    definition: '经起绒或磨毛整理形成绒毛表面的织物。',
    plain: '保暖、柔软；但容易吸附灰尘与起球。',
    common_uses: ['卫衣', '外套内里', '家居服'],
    pros: ['保暖性好', '手感柔软'],
    cons: ['易起球、掉毛', '易吸灰'],
    factors: ['起绒工艺', '纤维类型', '洗涤方式'],
    sources: ['公开纺织材料学与行业科普资料（非标准条文）'],
    needs_review: true
  }
];

const CARE_SYMBOLS = [
  { symbol: '水洗盆', text: '可水洗', meaning: '可按标签标注的水温机洗或手洗', common_source: '洗护标签' },
  { symbol: '水洗盆+手', text: '手洗', meaning: '建议手洗，水温不宜高，避免机洗搅动', common_source: '洗护标签' },
  { symbol: '水洗盆+×', text: '不可水洗', meaning: '不可水洗，通常需干洗', common_source: '洗护标签' },
  { symbol: '三角', text: '可漂白', meaning: '可使用漂白剂（含氯与否按具体符号）', common_source: '洗护标签' },
  { symbol: '三角+×', text: '不可漂白', meaning: '不可使用漂白剂', common_source: '洗护标签' },
  { symbol: '熨斗', text: '可熨烫', meaning: '可按标注温度熨烫（点数表示温度上限）', common_source: '洗护标签' },
  { symbol: '熨斗+×', text: '不可熨烫', meaning: '不可熨烫', common_source: '洗护标签' },
  { symbol: '圆圈', text: '可干洗', meaning: '可干洗（字母表示溶剂类型）', common_source: '洗护标签' },
  { symbol: '圆圈+×', text: '不可干洗', meaning: '不可干洗', common_source: '洗护标签' },
  { symbol: '正方形+圆', text: '可烘干', meaning: '可滚筒烘干（点数表示温度）', common_source: '洗护标签' },
  { symbol: '正方形+×', text: '不可烘干', meaning: '不可滚筒烘干，建议悬挂或平摊晾干', common_source: '洗护标签' }
];

/** 通用洗护注意（按纤维，非针对具体商品） */
const CARE_BY_FIBER = {
  棉: ['深色棉首次单独洗涤，可能掉色', '避免长时间浸泡', '中温熨烫'],
  聚酯纤维: ['低温洗涤，避免高温熨烫导致发硬', '易起静电，可少用柔顺剂（部分导湿整理会被削弱）'],
  羊毛: ['建议手洗或羊毛程序，冷水、少搅动', '不可拧绞，平摊晾干', '避免烘干'],
  羊绒: ['冷水轻柔手洗或专业干洗', '平铺晾干，避免悬挂拉伸'],
  蚕丝: ['建议手洗或干洗，避免暴晒', '不可用含氯漂白剂'],
  亚麻: ['可机洗但易皱，洗后及时整理', '避免高温烘干造成缩水'],
  粘胶纤维: ['湿态强度低，不可大力拧绞', '建议低温洗、平摊晾干'],
  莫代尔: ['低温温和洗护', '避免长时间浸泡与高温烘干'],
  莱赛尔纤维: ['温和洗护，避免与粗糙衣物同洗以减少起毛'],
  氨纶: ['避免高温熨烫与高温烘干', '泳池氯化水会加速老化'],
  锦纶: ['避免长时间暴晒', '低温熨烫'],
  腈纶: ['低温洗护，避免高温变形', '易起静电，可适当使用柔顺剂'],
  醋酯纤维: ['建议干洗或极轻柔手洗', '不可高温熨烫']
};

module.exports = { FIBERS, STRUCTURES, CARE_SYMBOLS, CARE_BY_FIBER, UPDATED_AT };

  };
  defs["core/fit.js"] = function (module, exports, require) {
/**
 * fit-advisor：版型与尺码建议。
 *
 * 硬性约束（规范 5.2 第 7 条 / 8.1–8.3）：
 * - 缺尺码表时**不给**具体尺码，只说明缺什么；
 * - 人体尺寸与成衣尺寸必须分开表述，不混用；
 * - 建议必须给理由，不能只输出一个 M/L/XL；
 * - 不使用身材评价性语言。
 *
 * 这里的放量（ease）是**经验启发式**，不是标准条款，也不是人体工程学测量结论。
 */

'use strict';

const { FIELD_STATUS, hasValue } = require('./fields');

const EASE = {
  修身: { bust: 4, waist: 2 },
  合体: { bust: 9, waist: 6 },
  宽松: { bust: 14, waist: 10 }
};

const PROFILE_LABELS = {
  height: '身高',
  weight: '体重',
  bust: '胸围',
  waist: '腰围',
  hip: '臀围',
  shoulder: '肩宽',
  usual_size: '常穿尺码',
  looseness: '喜欢的宽松程度'
};

function normalizeLooseness(value) {
  const v = String(value || '');
  if (/修身|紧身|贴身/.test(v)) return '修身';
  if (/宽松|oversize|Oversize|廓形/.test(v)) return '宽松';
  if (/合体|常规|适中/.test(v)) return '合体';
  return null;
}

function chartArray(fields) {
  const f = fields && fields.size_chart;
  if (!f || !hasValue(f)) return [];
  const v = f.normalized_value;
  if (Array.isArray(v)) return v;
  return [];
}

function measurementOf(row, keys) {
  if (!row || !row.measurements) return null;
  for (const k of keys) {
    if (row.measurements[k] != null) return { key: k, value: Number(row.measurements[k]) };
  }
  return null;
}

const BUST_KEYS = ['胸围', '胸宽', 'Bust', 'bust', ' Chest', 'chest'];
const WAIST_KEYS = ['腰围', 'Waist', 'waist'];
const SHOULDER_KEYS = ['肩宽', 'Shoulder', 'shoulder'];
const LENGTH_KEYS = ['衣长', 'Length', 'length'];

/**
 * @param {{fields: object, profile?: object}} input
 * @returns {object}
 */
function assessFit(input) {
  const fields = (input && input.fields) || {};
  const profile = (input && input.profile) || {};
  const chart = chartArray(fields);
  const preview = {
    status: 'unknown',
    recommendation: null,
    recommended_size: null,
    fit_description: hasValue(fields.fit_description) ? fields.fit_description.normalized_value : null,
    size_range: hasValue(fields.size_range) ? fields.size_range.normalized_value : null,
    chart_available: chart.length > 0,
    chart_sizes: chart.map((c) => c.size),
    profile_used: {},
    reasons: [],
    limits: [
      '人体测量值（你的身体）与成衣测量值（衣服平铺/围度）不是同一个口径，不能直接相等',
      '不同品牌同一标码的实际尺寸差异很大，建议以成衣尺寸为准',
      '本建议是启发式推断，不是试穿结果'
    ],
    missing_profile: [],
    missing_product: [],
    questions: []
  };

  const looseness = normalizeLooseness(profile.looseness);
  const bodyBust = profile.bust != null && profile.bust !== '' ? Number(profile.bust) : null;
  const bodyWaist = profile.waist != null && profile.waist !== '' ? Number(profile.waist) : null;
  const bodyShoulder = profile.shoulder != null && profile.shoulder !== '' ? Number(profile.shoulder) : null;

  preview.profile_used = {
    bust: bodyBust,
    waist: bodyWaist,
    shoulder: bodyShoulder,
    usual_size: profile.usual_size || null,
    looseness: looseness || null
  };

  const neededProfile = [];
  if (bodyBust == null) neededProfile.push('胸围');
  if (looseness == null) neededProfile.push('喜欢的宽松程度');
  preview.missing_profile = neededProfile;
  if (!chart.length) preview.missing_product.push('尺码表（成衣尺寸）');

  /* 先给版型描述与偏好的匹配（这个不需要尺码表） */
  const fitDesc = preview.fit_description;
  let fitMatch = 'unknown';
  if (fitDesc && looseness) {
    const sameDirection =
      (looseness === '宽松' && /宽松|oversize|廓形|落肩/i.test(lit(fitDesc))) ||
      (looseness === '修身' && /修身|紧身|贴身/.test(lit(fitDesc))) ||
      (looseness === '合体' && /合体|常规|直筒|正肩/.test(lit(fitDesc)));
    const opposite =
      (looseness === '宽松' && /修身|紧身|贴身/.test(lit(fitDesc))) ||
      (looseness === '修身' && /宽松|oversize|廓形/.test(lit(fitDesc)));
    fitMatch = sameDirection ? 'match' : opposite ? 'mismatch' : 'unclear';
  }
  preview.fit_match = fitMatch;
  if (fitDesc && looseness) {
    preview.reasons.push(
      fitMatch === 'match'
        ? `商品版型描述为「${fitDesc}」，与你偏好的「${looseness}」方向一致。`
        : fitMatch === 'mismatch'
          ? `商品版型描述为「${fitDesc}」，与你偏好的「${looseness}」方向相反，穿着效果可能不符合预期。`
          : `商品版型描述为「${fitDesc}」，与「${looseness}」的对应关系不明确，需要看具体尺寸。`
    );
  }

  /* 没有尺码表：明确拒绝给尺码 */
  if (!chart.length) {
    preview.status = 'chart_missing';
    preview.reasons.push('没有尺码表或成衣尺寸，无法把标码对应到具体厘米数，因此不给出确定尺码。');
    preview.questions.push('能提供各尺码的成衣平铺尺寸（肩宽/胸围/衣长）吗？');
    preview.summary =
      `目前只能根据版型描述判断风格倾向${fitDesc ? `（${fitDesc}）` : ''}，` +
      '缺少成衣尺寸时给出具体尺码并不可靠。建议先核对肩宽、胸围与衣长。';
    return preview;
  }

  /* 没有个人数据：给"怎么读尺码表"，不给尺码 */
  if (bodyBust == null || !looseness) {
    preview.status = 'profile_incomplete';
    preview.reasons.push(
      `缺少你的${neededProfile.join('、')}，系统不会推测你的身体数据；下面只解释这张尺码表怎么读。`
    );
    const bustRow = chart.find((c) => measurementOf(c, BUST_KEYS));
    if (bustRow) {
      const m = measurementOf(bustRow, BUST_KEYS);
      preview.reasons.push(`例如「${bustRow.size}」码的成衣${m.key}为 ${m.value} cm，你可以用自己的常穿成衣尺寸对照。`);
    }
    preview.summary = '补充胸围与偏好后可以给出建议尺码；在此之前只做尺码表解读。';
    return preview;
  }

  /* 两个输入都有：按放量选择 */
  const ease = EASE[looseness];
  const targetBust = bodyBust + ease.bust;
  const rows = chart
    .map((c) => {
      const b = measurementOf(c, BUST_KEYS);
      const w = measurementOf(c, WAIST_KEYS);
      const s = measurementOf(c, SHOULDER_KEYS);
      const l = measurementOf(c, LENGTH_KEYS);
      return { size: c.size, bust: b ? b.value : null, waist: w ? w.value : null, shoulder: s ? s.value : null, length: l ? l.value : null };
    })
    .filter((r) => r.bust != null);

  if (!rows.length) {
    preview.status = 'chart_missing';
    preview.reasons.push('尺码表里没有可靠的胸围数值（可能列错位），无法计算。');
    preview.questions.push('尺码表能单独发一张清晰的胸围列吗？');
    preview.summary = '尺码表缺少胸围数值，无法给出建议尺码。';
    return preview;
  }

  const sorted = rows.slice().sort((a, b) => a.bust - b.bust);
  let pick = sorted.find((r) => r.bust >= targetBust) || null;
  let basis = 'body_bust_plus_ease';
  if (!pick) {
    pick = sorted[sorted.length - 1];
    basis = 'largest_available';
  }

  preview.recommendation = {
    size: pick.size,
    target_bust: Math.round(targetBust * 10) / 10,
    garment_bust: pick.bust,
    ease_applied: ease.bust,
    body_bust: bodyBust,
    basis,
    row: pick
  };
  preview.recommended_size = pick.size;
  preview.status = 'heuristic';

  preview.reasons.push(
    `你的胸围 ${bodyBust} cm，加上「${looseness}」偏好对应的经验放量 ${ease.bust} cm，目标是成衣胸围约 ${Math.round(targetBust)} cm。`
  );
  preview.reasons.push(`尺码表中「${pick.size}」的成衣胸围为 ${pick.bust} cm，是第一个不小于目标值的尺码。`);
  if (pick.shoulder != null && bodyShoulder != null) {
    const delta = Math.round((pick.shoulder - bodyShoulder) * 10) / 10;
    preview.reasons.push(
      `肩宽对照：成衣 ${pick.shoulder} cm，你的肩宽 ${bodyShoulder} cm，差 ${delta > 0 ? '+' : ''}${delta} cm` +
        (Math.abs(delta) > 4 ? '；差值较大，肩线位置可能明显偏移，建议再确认。' : '。')
    );
  }
  if (pick.length != null) preview.reasons.push(`「${pick.size}」的成衣衣长为 ${pick.length} cm。`);
  if (profile.usual_size) {
    if (String(profile.usual_size).toUpperCase() === String(pick.size).toUpperCase()) {
      preview.reasons.push(`与你常穿的「${profile.usual_size}」一致，风险较低。`);
    } else {
      preview.reasons.push(
        `与你常穿的「${profile.usual_size}」不同，这是按尺码表算出来的结果；若你平时习惯在某品牌买大一码，请以成衣尺寸为准。`
      );
    }
  }
  if (basis === 'largest_available') {
    preview.reasons.push('按目标胸围计算已超出尺码表最大码，最大码可能仍偏紧。');
  }

  preview.summary = `建议参考「${pick.size}」码：成衣胸围 ${pick.bust} cm，接近你需要的 ${Math.round(targetBust)} cm。这是按尺码表与你的偏好做的经验推算，建议下单前再核对一遍肩宽与衣长。`;
  preview.limits.push('放量数值是经验启发式（修身/合体/宽松分别 4/9/14 cm），不是标准规定，也未考虑面料弹性与版型差异');

  if (hasValue(fields.elasticity) === false && /氨纶|弹性/.test(JSON.stringify(fields.fiber_composition || {}))) {
    preview.reasons.push('成分里含弹性纤维，实际可穿范围可能比尺码表更宽；但具体回弹量需要看面料参数。');
  }

  return preview;
}

function lit(v) {
  return v == null ? '' : String(v);
}

module.exports = { assessFit, EASE, PROFILE_LABELS, normalizeLooseness };

  };
  defs["core/rules.js"] = function (module, exports, require) {
/**
 * rule-engine：确定性规则判断 —— 信息完整度 + 疑点清单。
 *
 * 设计原则（规范 5.2 / 页面 C 疑点区域）：
 * - 每条疑点必须有：具体依据(basis) + 下一步(action)，禁止"可能有问题"这种空话；
 * - 疑点 ≠ 指控：不使用"违规""假货""不合格"等定性词；
 * - 信息缺失只说明"无法判断什么"，不推断成负面评价。
 */

'use strict';

const { FIELD_STATUS, hasValue, KEY_FIELDS, fieldDef } = require('./fields');

const SEVERITY_ORDER = { attention: 0, verify: 1, info: 2 };

function present(field) {
  return hasValue(field);
}

/** 信息完整度：关键字段 2 分，辅助字段 1 分 */
function computeCompleteness(fields) {
  const f = fields || {};
  const keys = Object.keys(f);
  let totalWeight = 0;
  let presentWeight = 0;
  const missing = [];
  const unresolved = [];

  for (const key of keys) {
    const field = f[key];
    const def = fieldDef(key);
    const weight = KEY_FIELDS.includes(key) ? 2 : 1;
    totalWeight += weight;
    if (present(field)) {
      presentWeight += weight;
    } else if (field && field.status === FIELD_STATUS.UNREADABLE) {
      unresolved.push(key);
    } else {
      missing.push(key);
    }
  }

  const keyMissing = KEY_FIELDS.filter((k) => !present(f[k]));
  const ratio = totalWeight ? presentWeight / totalWeight : 0;
  const keyRatio = KEY_FIELDS.length ? (KEY_FIELDS.length - keyMissing.length) / KEY_FIELDS.length : 0;

  let level = 'low';
  if (keyMissing.length === 0 && ratio >= 0.8) level = 'high';
  else if (keyMissing.length <= 1 && ratio >= 0.55) level = 'medium';

  return {
    ratio: Math.round(ratio * 100) / 100,
    key_ratio: Math.round(keyRatio * 100) / 100,
    level,
    level_label: level === 'high' ? '较完整' : level === 'medium' ? '部分完整' : '信息不足',
    key_missing: keyMissing,
    missing,
    unresolved,
    note:
      level === 'high'
        ? '关键字段齐全，结论可以写得具体一些，但仍不代表实物已检测。'
        : level === 'medium'
          ? '还缺部分关键信息，结论会保留更多不确定性，并列出需要确认的问题。'
          : '关键信息明显不足，本卡只描述"已知内容"，不给合身或质量结论。'
  };
}

function labelOf(key) {
  return fieldDef(key).name;
}

function basisOf(fields, keys) {
  return (keys || [])
    .map((k) => {
      const f = fields[k];
      if (!f) return null;
      return {
        type: 'field',
        field_key: k,
        field_name: labelOf(k),
        status: f.status,
        source_type: f.source_type,
        source_image_id: f.source_image_id || null,
        raw_text: f.raw_text || null
      };
    })
    .filter(Boolean);
}

const CLAIM_RULES = [
  {
    id: 'claim-functional',
    re: /(抗菌|抑菌|防螨|除螨|防霉|抗病毒|防紫外线|UPF|远红外|负离子|抗氧化)/,
    title: '功能性宣称需要具体依据',
    reason: (m) => `页面出现「${m[0]}」这类功能性宣称。功能宣称通常需要有对应标准与检测报告支撑，仅靠文案无法确认。`,
    action: '向商家索取：检测机构名称、报告编号、依据的标准号（例如 UPF 值对应 GB/T 18830 类标准），并核对报告上的样品与批次。',
    question: '这款商品的功能性（如抗菌/防晒）有对应的检测报告吗？报告编号和检测机构是什么？'
  },
  {
    id: 'claim-chemical',
    re: /(零甲醛|无甲醛|0甲醛|不含甲醛|无荧光|无致癌|食品级|医用级|婴儿级)/,
    title: '绝对化安全宣称无法由页面证明',
    reason: (m) => `「${m[0]}」属于绝对化/安全类宣称。纺织品化学指标需要按标准方法检测，页面文案不能作为证据。`,
    action: '请商家提供近期的检测报告（含样品名称、报告编号、检测项目）。不要仅凭文案判断安全性。',
    question: '页面写的"零甲醛/婴儿级"有第三方检测报告吗？能提供报告首页和结论页吗？'
  },
  {
    id: 'claim-permanent',
    re: /(绝不|永久|100%\s*不起球|永不起球|不掉色|永不褪色|绝对)/,
    title: '绝对化承诺需要谨慎看待',
    reason: (m) => `页面出现「${m[0]}」。起球、掉色与穿着方式、洗涤方式相关，通常无法做到绝对。`,
    action: '把关注点放在检测报告与洗护说明上；如果商家给出绝对承诺，建议保留聊天记录以便售后。',
    question: '如果出现起球/掉色，售后按什么标准判定和处理？'
  },
  {
    id: 'claim-origin',
    re: /(进口面料|意大利面料|德国机器|日本工艺|原单|专柜同款|大牌同款)/,
    title: '产地/工艺类说法缺少可核验信息',
    reason: (m) => `页面出现「${m[0]}」，但截图中没有对应的可核验信息（如产地标注、报关信息、品牌授权）。`,
    action: '可要求商家提供进货凭证或标注信息；宣传用词本身不构成商品参数。',
    question: '提到的面料产地/工艺有凭证可以在售前提供吗？'
  }
];

/**
 * 生成疑点清单。
 * @param {object} ctx
 * @param {object} ctx.fields
 * @param {object} [ctx.standard] associate() 的返回
 * @param {object} [ctx.weight] assessWeight() 的返回
 * @param {object} [ctx.yarn] assessYarnCount() 的返回
 * @param {object} [ctx.fit] assessFit() 的返回
 * @param {object} [ctx.completeness] computeCompleteness() 的返回
 * @param {string} [ctx.rawText] 原始 OCR 文本（用于功能性宣称扫描）
 */
function buildDoubts(ctx) {
  const fields = (ctx && ctx.fields) || {};
  const standard = ctx && ctx.standard;
  const weight = ctx && ctx.weight;
  const fit = ctx && ctx.fit;
  const completeness = (ctx && ctx.completeness) || computeCompleteness(fields);
  const rawText = (ctx && ctx.rawText) || '';
  const doubts = [];
  const push = (d) => doubts.push({ severity: 'info', ...d });

  const covered = new Set();

  /* 1. 识别不清 */
  if (completeness.unresolved.length) {
    push({
      id: 'unreadable',
      severity: 'verify',
      category: '识别受限',
      title: `${completeness.unresolved.map(labelOf).join('、')}在图中无法辨识`,
      reason: '图片分辨率、反光或排版导致文字无法可靠识别。系统没有猜测内容。',
      basis: completeness.unresolved.map((k) => ({ type: 'field', field_key: k, field_name: labelOf(k), status: FIELD_STATUS.UNREADABLE })),
      action: '重新拍摄/截取更清晰的局部图后补充上传。',
      question: null
    });
  }

  /* 3. 字段冲突 */
  for (const [key, field] of Object.entries(fields)) {
    if (!field || field.status !== FIELD_STATUS.CONFLICT) continue;
    push({
      id: `conflict-${key}`,
      severity: 'attention',
      category: '信息冲突',
      title: `${labelOf(key)}在不同来源中说法不一致`,
      reason: field.evidence_note || '两个来源给出的值不同，系统保留了双方证据，没有替你选一个。',
      basis: (field.alternatives || []).map((a) => ({
        type: 'alternative',
        value: a.normalized_value,
        raw_text: a.raw_text,
        source_type: a.source_type,
        source_image_id: a.source_image_id
      })),
      action: '以实物标签为准；截图与页面描述不一致时，让商家确认哪个是最终参数。',
      question: `${labelOf(key)}在页面和吊牌上写的不一样，以哪个为准？能发吊牌照片确认吗？`
    });
    covered.add(key);
  }

  /* 4. 标准相关 */
  if (standard) {
    covered.add('standard_code');
    if (!standard.appears_in_product) {
      push({
        id: 'standard-missing',
        severity: 'verify',
        category: '标准与标识',
        title: '没有看到执行标准号',
        reason: '商品截图中没有出现执行标准号，因此无法核对它声称执行的是哪个标准、是否现行。',
        basis: basisOf(fields, ['standard_code']),
        action: '吊牌/水洗标通常会印执行标准与安全类别；补一张标签照片即可补齐。',
        question: '这款商品的执行标准号和安全类别是什么？能发吊牌照片吗？'
      });
    } else if (standard.registry_result === 'pending_verification') {
      push({
        id: 'standard-unverified',
        severity: 'verify',
        category: '标准与标识',
        title: `标准 ${standard.normalized_code || ''} 暂未核验`,
        reason: standard.message || '本级核验库中没有该标准号的官方查询结果。系统不判断它是否现行，也不补齐版本。',
        basis: basisOf(fields, ['standard_code']),
        action: '点开"官方查询来源"自行核对，或让商家提供标注该标准的吊牌照片。',
        question: `商品标注的 ${standard.normalized_code || '执行标准'} 是现行版本吗？`
      });
    } else if (standard.official_status === 'abolished') {
      push({
        id: 'standard-abolished',
        severity: 'attention',
        category: '标准与标识',
        title: `标注的标准版本已废止（${standard.normalized_code}）`,
        reason: '官方平台显示该版本状态为已废止。已废止版本可能在旧库存上出现，但不应用于新生产商品。',
        basis: basisOf(fields, ['standard_code']),
        action: '确认生产日期与批次；要求商家提供现行版本标注或检测报告。',
        question: `${standard.normalized_code} 已废止，这款是旧库存吗？现行版本标注是什么？`
      });
    } else if (standard.official_status === 'upcoming') {
      push({
        id: 'standard-upcoming',
        severity: 'info',
        category: '标准与标识',
        title: `标注的标准尚未到实施日期（${standard.normalized_code}）`,
        reason: '官方平台显示该版本尚未实施，是否已可标注取决于实施日期。',
        basis: basisOf(fields, ['standard_code']),
        action: '核对实施日期与商品生产日期。',
        question: null
      });
    }

    if (standard.registry_match && standard.applicability === 'unlikely') {
      push({
        id: 'standard-applicability',
        severity: 'verify',
        category: '标准与标识',
        title: '标准与品类可能不匹配',
        reason: standard.applicability_reason || '标准名称限定的产品与该商品品类不一致。',
        basis: basisOf(fields, ['standard_code', 'category']),
        action: '请商家说明该标准为何适用于此商品，或提供正确的产品标准号。',
        question: '这个标准号与该品类不太对应，能确认一下正确的执行标准吗？'
      });
    }

    if (standard.applies_to_all_textiles === false && standard.key_requirements_verified === false) {
      push({
        id: 'standard-topics',
        severity: 'info',
        category: '标准与标识',
        title: '标准的具体条款未逐条核对',
        reason: '公开平台只提供标准号、名称、状态和日期；条款内容与限值需查阅标准正文，本系统没有替你引用条款。',
        basis: [{ type: 'standard', standard_number: standard.normalized_code, registry_result: standard.registry_result }],
        action: '如需逐条核对，可在官方"在线预览"查阅正文，或索取检测报告中的检测依据。',
        question: null
      });
    }
  }

  /* 5. 成分比例 */
  const fiber = fields.fiber_composition;
  if (fiber && fiber.parsed && fiber.parsed.total != null && Math.abs(fiber.parsed.total - 100) > 1) {
    push({
      id: 'fiber-sum',
      severity: 'attention',
      category: '面料参数',
      title: '纤维比例合计不等于 100%',
      reason: `标注的百分比合计约 ${fiber.parsed.total}%，可能是漏识别或页面本身漏写。`,
      basis: basisOf(fields, ['fiber_composition']),
      action: '核对水洗标原文；标注不完整时建议让商家确认各部分（面料/里料/填充物）的完整比例。',
      question: '面料的完整成分比例是多少？里料和填充物分别是什么？'
    });
    covered.add('fiber_composition');
  }

  /* 6. 克重 / 支数 */
  if (weight) {
    if (weight.status === 'missing') {
      push({
        id: 'weight-missing',
        severity: 'info',
        category: '面料参数',
        title: '没有克重信息，不做厚薄评级',
        reason: '截图未提供克重，系统不会估算具体数值，也不给"厚/薄"评级。',
        basis: basisOf(fields, ['fabric_weight', 'garment_weight']),
        action: '可向商家索取面料克重（g/m²）；注意"成衣重量 g"不能等同于克重。',
        question: '这款面料克重是多少 g/m²？'
      });
    } else if (weight.status === 'ambiguous' || weight.status === 'incomparable') {
      push({
        id: 'weight-ambiguous',
        severity: 'verify',
        category: '面料参数',
        title: '重量口径需要确认',
        reason: weight.message,
        basis: basisOf(fields, ['fabric_weight', 'garment_weight']),
        action: '确认是"每平方米克重(g/m²)"还是"单件重量(g)"，两者不能互相换算比较。',
        question: '客服说的克重是 g/m² 还是单件重量 g？'
      });
    }
    covered.add('fabric_weight');
    covered.add('garment_weight');
  }

  /* 7. 尺码表 */
  if (!present(fields.size_chart)) {
    push({
      id: 'size-chart-missing',
      severity: 'verify',
      category: '版型与尺码',
      title: '没有尺码表，无法给出确定尺码',
      reason: '没有成衣尺寸（肩宽/胸围/衣长），任何具体尺码建议都是猜的，系统不猜。',
      basis: basisOf(fields, ['size_chart', 'size_range', 'fit_description']),
      action: '补一张尺码表截图，或索取成衣平铺尺寸。',
      question: '能提供各尺码的成衣平铺尺寸（肩宽/胸围/衣长/袖长）吗？'
    });
    covered.add('size_chart');
  }

  /* 8. 安全类别 */
  if (!present(fields.safety_category)) {
    push({
      id: 'safety-category-missing',
      severity: 'info',
      category: '标准与标识',
      title: '没有看到产品安全类别',
      reason: '安全类别（A/B/C 类）通常与执行标准一起印在吊牌或水洗标上，截图里缺失。',
      basis: basisOf(fields, ['safety_category']),
      action: '补吊牌照片即可核对。',
      question: '吊牌上的安全类别是哪一类？'
    });
    covered.add('safety_category');
  }

  /* 9. 洗护 */
  if (!present(fields.care_instructions)) {
    push({
      id: 'care-missing',
      severity: 'info',
      category: '洗护',
      title: '没有洗护标签信息',
      reason: '系统只给基于成分的一般参考，不能替代商品标签上的洗护要求。',
      basis: basisOf(fields, ['care_instructions']),
      action: '补一张水洗标照片；洗护符号含义见"洗护"区块。',
      question: '能把水洗标拍一下吗？'
    });
    covered.add('care_instructions');
  }

  /* 10. 检测报告仅"提及" */
  if (fields.test_report && fields.test_report.status === FIELD_STATUS.PENDING_VERIFICATION) {
    push({
      id: 'test-report-claim',
      severity: 'verify',
      category: '证据',
      title: '页面提到检测/质检，但没有报告信息',
      reason: '截图中出现检测类字样，但没有报告编号、检测机构或检测项目，无法确认检测对象与结论。',
      basis: basisOf(fields, ['test_report']),
      action: '索取报告首页（含报告编号、机构、样品名称、检测依据）与结论页。',
      question: '检测报告的编号和检测机构是什么？检测项目包含哪些？'
    });
    covered.add('test_report');
  }

  /* 11. 宣称类 */
  for (const rule of CLAIM_RULES) {
    const m = rawText.match(rule.re);
    if (!m) continue;
    push({
      id: `claim-${rule.id}`,
      severity: 'verify',
      category: '宣传宣称',
      title: rule.title,
      reason: rule.reason(m),
      basis: [{ type: 'text', match: m[0], source_type: 'promo_screenshot' }],
      action: rule.action,
      question: rule.question
    });
  }

  /* 12. 标准号缺年份 */
  const std = fields.standard_code;
  if (std && present(std) && !/\d{4}/.test(String(std.normalized_value || ''))) {
    push({
      id: 'standard-year-missing',
      severity: 'verify',
      category: '标准与标识',
      title: '标准号缺少年份',
      reason: '原文没有年份，无法确定引用的是哪一版；系统没有自动补年份。',
      basis: basisOf(fields, ['standard_code']),
      action: '核对吊牌原文；同一标准号不同年份版本要求不同。',
      question: '吊牌上执行标准的完整写法（含年份）是什么？'
    });
    covered.add('standard_code');
  }

  /* 13. 品类未识别 */
  if (!present(fields.category)) {
    push({
      id: 'category-missing',
      severity: 'info',
      category: '基础信息',
      title: '没有识别出品类',
      reason: '品类决定适用哪些产品标准、如何比较克重，缺失会让后续判断变弱。',
      basis: basisOf(fields, ['category']),
      action: '在"基本信息"里手动选择品类（下拉项均可选择）。',
      question: null
    });
    covered.add('category');
  }

  /* 14. 版型信息不足（有 fit 结果时） */
  if (fit && fit.status === 'profile_incomplete') {
    push({
      id: 'fit-profile-incomplete',
      severity: 'info',
      category: '版型与尺码',
      title: '个人身材资料不完整',
      reason: `缺少：${fit.missing_profile.join('、')}。系统不会推测你的身体数据。`,
      basis: [],
      action: '在"身材与偏好"里自愿补充需要的字段（不必填全）。',
      question: null
    });
  }

  /* 14b. 老化风险：只在高风险时提示，避免与「穿久了会怎么样？」区块重复 */
  const wear = ctx && ctx.wear;
  if (wear && wear.available) {
    const high = wear.items.filter((i) => i.overall_risk === 'high');
    if (high.length) {
      push({
        id: 'wear-high-risk',
        severity: 'attention',
        category: '长期穿着',
        title: `「${high[0].garment_area}」存在需要重点核实的老化风险：${high[0].item_name}`,
        reason:
          `${high[0].possible_failure}。` +
          (high[0].evidence_level === 'observed_defect'
            ? '这是图片/描述中**已经存在**的迹象，不是预测。'
            : '这是基于已识别结构与材料的风险提示，不是实测结论。'),
        basis: (high[0].evidence || []).map((e) => ({ type: 'feature', field_name: e.label, raw_text: e.text, status: 'extracted' })),
        action: '看「穿久了会怎么样？」区块：那里写了成因、影响程度、判断置信度与补图/询问建议。',
        question: (high[0].seller_questions && high[0].seller_questions[0]) || null
      });
    }
  }

  /* 15. 其余关键字段缺失：只对没被上面具体规则覆盖的字段给一条通用提示 */
  const leftover = completeness.key_missing.filter((k) => !covered.has(k));
  if (leftover.length) {
    const byGroup = {};
    for (const key of leftover) {
      const def = fieldDef(key);
      byGroup[def.group] = byGroup[def.group] || [];
      byGroup[def.group].push(key);
    }
    for (const [group, keys] of Object.entries(byGroup)) {
      push({
        id: `missing-${group}`,
        severity: group === 'fabric' || group === 'standard' ? 'verify' : 'info',
        category: '信息缺失',
        title: `缺少${keys.map(labelOf).join('、')}`,
        reason: '当前截图/照片里没有识别到这些关键字段，系统不会替它填一个数值。缺它们会直接影响结论强度。',
        basis: keys.map((k) => ({ type: 'field', field_key: k, field_name: labelOf(k), status: FIELD_STATUS.MISSING })),
        action:
          group === 'standard'
            ? '补一张吊牌或水洗标照片（上面通常有执行标准、安全类别、成分、洗护）。'
            : group === 'fabric'
              ? '补一张"成分/面料参数"详情页截图，或向客服索取纤维含量与克重。'
              : '补一张尺码表截图，或向客服索取成衣尺寸（肩宽/胸围/衣长）。',
        question: null
      });
    }
  }

  const rankOf = (d) => (SEVERITY_ORDER[d.severity] === undefined ? 9 : SEVERITY_ORDER[d.severity]);
  doubts.sort((a, b) => rankOf(a) - rankOf(b));
  return {
    items: doubts,
    counts: {
      attention: doubts.filter((d) => d.severity === 'attention').length,
      verify: doubts.filter((d) => d.severity === 'verify').length,
      info: doubts.filter((d) => d.severity === 'info').length
    },
    questions: doubts.map((d) => d.question).filter(Boolean)
  };
}

module.exports = { computeCompleteness, buildDoubts, CLAIM_RULES, SEVERITY_ORDER };

  };
  defs["core/wear/analyze.js"] = function (module, exports, require) {
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

  };
  defs["core/wear/features.js"] = function (module, exports, require) {
/**
 * wear/features.js —— 从"已识别的字段 + OCR 原文"里提出**设计特征**。
 *
 * 为什么单独一层：
 *   老化风险规则不应该直接读原始文本（那样每条规则都要写一遍正则），
 *   也不应该直接读字段（字段里没有"罗纹领口"这种设计信息）。
 *   所以先把文本/字段提炼成一组带证据来源的特征，规则只对特征做匹配。
 *
 * 三原则：
 *   1. 特征只记录"文中/图里出现了什么"，不记录"所以质量如何"；
 *   2. 每条特征都带 evidence（原句）与 source（promo_screenshot / physical_label / user_input）；
 *   3. 没识别到的特征一律不假设存在（不推断"应该有罗纹领口"）。
 */

'use strict';

const { hasValue } = require('../fields');

/** 特征定义：key / 中文名 / 匹配文本 / 说明 */
const FEATURE_DEFS = [
  {
    key: 'rib_collar',
    label: '罗纹领口',
    re: /(罗纹.{0,4}领|领口.{0,4}罗纹|罗纹领口|rib\s*collar)/i,
    note: '领口采用罗纹针织（线圈纵行相间），横向弹性好但长期拉伸会疲劳'
  },
  {
    key: 'rib_cuff_hem',
    label: '罗纹袖口/下摆',
    re: /(罗纹.{0,4}(袖口|下摆|裤脚)|(袖口|下摆|裤脚).{0,4}罗纹|收口|束口)/,
    note: '边缘用罗纹或弹性收口，反复拉伸后可能出现松弛'
  },
  {
    key: 'big_print',
    label: '大面积印花/胶印',
    re: /(大面积.{0,4}(印花|图案|胶印)|胶印|丝印|厚板|发泡印|烫画|热转印|满印)/,
    note: '塑胶类印花覆盖在面料表面，弯折与洗涤后可能开裂或翘边'
  },
  {
    key: 'print_any',
    label: '有印花/图案',
    re: /(印花|印图|图案|logo|LOGO|Logo|刺绣图案)/,
    note: '存在表面图案工艺，耐久性取决于工艺与洗护'
  },
  {
    key: 'coating_faux_leather',
    label: '涂层/仿皮结构',
    re: /(仿皮|PU皮|PU|聚氨酯涂层|涂层|覆膜|贴膜|防水涂层|皮革)/,
    note: '表面有高分子涂层或膜层，弯折处与接缝边缘是常见失效起点'
  },
  {
    key: 'brushed_surface',
    label: '磨毛/绒面',
    re: /(磨毛|拉绒|绒面|仿麂皮|麂皮绒|摇粒绒|抓绒|珊瑚绒|法兰绒)/,
    note: '表面纤维被拉起形成绒感，摩擦后可能起球、压亮或局部倒绒'
  },
  {
    key: 'fleece_lining',
    label: '起绒内里',
    re: /(内里.{0,4}(抓绒|起绒|加绒)|加绒|抓绒内里|摇粒绒内里)/,
    note: '内里起绒保暖，但容易掉毛、吸灰、与粗糙衣物摩擦起球'
  },
  {
    key: 'embroidery_beads',
    label: '刺绣/珠片/装饰件',
    re: /(刺绣|珠片|亮片|钉珠|水钻|铆钉|贴布|布贴|流苏|挂饰|五金装饰)/,
    note: '装饰件与底布的连接处是受力集中点，洗护时还可能勾挂'
  },
  {
    key: 'metal_hardware',
    label: '金属五金（拉链/扣）',
    re: /(金属拉链|金属扣|五金|拉链|YKK|铜扣|铆钉扣)/,
    note: '金属件与面料摩擦、以及镀层磨损，是常见的外观老化点'
  },
  {
    key: 'drawstring_hood',
    label: '帽绳/连帽结构',
    re: /(连帽|帽绳|抽绳|卫衣帽)/,
    note: '帽绳孔、帽与衣身连接处是拉扯与磨损集中区'
  },
  {
    key: 'splice_multi',
    label: '拼接/拼色/异材质',
    re: /(拼接|拼色|撞色|异材质|复合面料)/,
    note: '不同材质/颜色的拼接处，收缩率与色牢度差异会放大老化差异'
  },
  {
    key: 'elastic_waist',
    label: '松紧腰/弹性腰头',
    re: /(松紧腰|弹力腰|橡筋腰|抽绳腰)/,
    note: '橡筋长期受热与拉伸会衰减，腰头可能出现松弛与卷边'
  },
  {
    key: 'stretch_fabric',
    label: '弹力/紧身结构',
    re: /(弹力|高弹|紧身|瑜伽|速干|压缩|氨纶)/,
    note: '高伸展区域的接缝与弹性纤维承受反复拉伸'
  },
  {
    key: 'pleats_structure',
    label: '褶裥/定型结构',
    re: /(褶|压褶|定型|烫衬|粘合衬|硬挺)/,
    note: '定型与粘合结构依赖工艺，洗护不当可能失去形状'
  },
  {
    key: 'long_knit',
    label: '长款针织/垂坠结构',
    re: /(长款|中长|垂坠|针织衫|毛衣|毛衣裙)/,
    note: '针织长款受重力影响更明显，悬挂储存会拉伸'
  },
  {
    key: 'thin_fabric',
    label: '偏薄面料',
    re: /(轻薄|薄款|超薄|透气网眼|冰丝)/,
    note: '薄面料单位面积纤维少，耐磨与抗勾丝余量较小'
  },
  {
    key: 'performance_claim',
    label: '性能宣称（抗起球/耐磨/防水等）',
    re: /(抗起球|不易起球|耐磨|防泼水|防水|抗皱|免烫|抗静电|防紫外线|抗菌)/,
    note: '性能宣称需要检测报告支撑，页面文案本身不是证据'
  },
  {
    key: 'visible_defect',
    label: '已存在的损伤迹象',
    re: /(起球|勾丝|开裂|脱层|掉皮|开线|脱线|破损|破洞|掉色|发白|变形|磨损)/,
    note: '这是**当前已经存在**的迹象，与"未来可能发生"必须分开表述'
  }
];

/** 由字段直接得出的结构特征（不依赖文本） */
function structureFromFields(fields) {
  const out = [];
  const knit = /针织|T恤|卫衣|毛衣|针织衫|打底/.test(String(fields.category && fields.category.normalized_value || ''));
  const woven = /牛仔|衬衫|西服|西装|大衣|风衣|休闲裤|西裤/.test(String(fields.category && fields.category.normalized_value || ''));
  if (knit) out.push({ key: 'knit_structure', label: '针织结构', note: '线圈串套，有弹性、易变形', evidence: '品类', source: 'field' });
  if (woven) out.push({ key: 'woven_structure', label: '梭织结构', note: '经纬交织，尺寸稳定、弹性差', evidence: '品类', source: 'field' });

  const fiber = fields.fiber_composition;
  if (fiber && fiber.parsed && Array.isArray(fiber.parsed.items)) {
    const spandex = fiber.parsed.items.filter((i) => /氨纶|弹性/.test(i.fiber)).reduce((s, i) => s + (i.percent || 0), 0);
    if (spandex >= 5) {
      out.push({ key: 'high_spandex', label: `高氨纶（${spandex}%）`, note: '弹性好，但耐热与长期回弹需要关注', evidence: fiber.normalized_value, source: 'field' });
    } else if (spandex > 0) {
      out.push({ key: 'spandex_low', label: `含氨纶（${spandex}%）`, note: '少量弹性纤维，改善活动度', evidence: fiber.normalized_value, source: 'field' });
    }
    const wool = fiber.parsed.items.filter((i) => /羊毛|羊绒/.test(i.fiber)).reduce((s, i) => s + (i.percent || 0), 0);
    if (wool >= 30) out.push({ key: 'wool_rich', label: `羊毛/羊绒 ${wool}%`, note: '动物纤维，缩绒与起球风险与工艺相关', evidence: fiber.normalized_value, source: 'field' });
    const cotton = fiber.parsed.items.filter((i) => i.fiber === '棉').reduce((s, i) => s + (i.percent || 0), 0);
    if (cotton >= 50) out.push({ key: 'cotton_rich', label: `棉 ${cotton}%`, note: '吸湿亲肤，但易皱、缩水与显旧取决于整理工艺', evidence: fiber.normalized_value, source: 'field' });
    const cellulosic = fiber.parsed.items.filter((i) => /粘胶|莫代尔|莱赛尔/.test(i.fiber)).reduce((s, i) => s + (i.percent || 0), 0);
    if (cellulosic >= 30) out.push({ key: 'regenerated_cellulose', label: `再生纤维素 ${cellulosic}%`, note: '湿态强度低，易缩水与变形', evidence: fiber.normalized_value, source: 'field' });
  }

  const weight = fields.fabric_weight;
  if (hasValue(weight) && weight.unit === 'g/m²' && typeof weight.normalized_value === 'number') {
    if (weight.normalized_value >= 300) out.push({ key: 'heavy_fabric', label: `克重较高（${weight.normalized_value} g/m²）`, note: '厚实，但弯折处更易形成硬折痕', evidence: weight.raw_text, source: 'field' });
    if (weight.normalized_value <= 150) out.push({ key: 'light_fabric', label: `克重较低（${weight.normalized_value} g/m²）`, note: '偏薄，耐磨余量较小', evidence: weight.raw_text, source: 'field' });
  }

  if (hasValue(fields.care_instructions)) {
    const care = String(fields.care_instructions.normalized_value || '');
    if (/干洗/.test(care)) out.push({ key: 'dry_clean_only', label: '需干洗', note: '干洗依赖度高的商品，日常维护成本更高', evidence: care, source: 'field' });
    if (/不可漂白|勿漂白/.test(care)) out.push({ key: 'no_bleach', label: '不可漂白', note: '漂白限制通常与染料/纤维稳定性相关', evidence: care, source: 'field' });
  }

  return out;
}

/**
 * 识别特征。
 * @param {{fields: object, rawText?: string}} input
 * @returns {{features: Array<object>, byKey: Object<string, object>, text_hits: Array<object>}}
 */
function detectFeatures(input) {
  const fields = (input && input.fields) || {};
  const rawText = String((input && input.rawText) || '');
  const features = [];
  const byKey = {};

  for (const def of FEATURE_DEFS) {
    const m = rawText.match(def.re);
    if (!m) continue;
    const feat = {
      key: def.key,
      label: def.label,
      note: def.note,
      evidence: String(m[0]),
      source: 'text',
      from_observed_text: true
    };
    features.push(feat);
    byKey[def.key] = feat;
  }

  for (const feat of structureFromFields(fields)) {
    if (byKey[feat.key]) continue;
    features.push(feat);
    byKey[feat.key] = feat;
  }

  return { features, byKey, text_hits: features.filter((f) => f.source === 'text') };
}

module.exports = { detectFeatures, FEATURE_DEFS, structureFromFields };

  };
  defs["core/wear/rules.js"] = function (module, exports, require) {
/**
 * wear/rules.js —— 服装设计与老化风险知识库（数据，不是代码逻辑）。
 *
 * 每条规则的结构（与规范 §3 一致）：
 *   id / name              规则标识与名称
 *   categories             适用品类（空数组 = 不限）
 *   requires_features      必须全部命中的设计特征（features.js 的 key）
 *   any_features           命中其一即可
 *   text_regex             额外的原文匹配（用于颜色、纽扣等无对应特征的场景）
 *   area                   衣服的具体位置
 *   failure_modes          潜在失效方式（数组，具体到可观察）
 *   mechanism              形成机制（为什么）
 *   impact                 low | medium | high（影响程度，与发生可能性分开）
 *   likelihood_when_known  材料与结构已知时的可能性基准
 *   evidence_needed        需要什么证据才能更进一步
 *   mitigation             可以降低风险的洗护/使用方式
 *   seller_questions       购买前可以问商家的问题
 *   verification           自己如何核实
 *   not_applicable         什么情况下这条不适用
 *   evidence_level         general_knowledge | industry_practice | observed_defect
 *   sources                信息来源（本项目没有检测数据，一律标明是通用知识/行业惯例）
 *   limitations            这条规则本身的局限
 *   updated_at             更新时间
 *
 * 新增规则只需往这个数组里加数据；analyze.js 不需要改。
 */

'use strict';

const UPDATED_AT = '2026-10-23';
const SRC = '通用纺织与服装工艺知识（非标准条文、非检测数据）';

const RULES = [
  /* ───────── 一、领口、袖口与弹性部位 ───────── */
  {
    id: 'rib-collar-relax',
    name: '罗纹领口反复拉伸后松弛',
    categories: ['T恤', '卫衣', '羊毛衫', '内衣'],
    requires_features: ['rib_collar'],
    area: '领口',
    failure_modes: ['领口扩张、不能回弹', '领口边缘波浪化', '领口与衣身接缝扭曲'],
    mechanism: '罗纹靠线圈纵行相间提供横向弹性；纱线捻度、氨纶比例、针距与缝合工艺决定回弹保持能力，反复穿脱与热水洗涤会加速弹性疲劳。',
    impact: 'medium',
    likelihood_when_known: 'medium',
    evidence_needed: ['领口近景（能看到罗纹与接缝）', '成分中氨纶比例', '洗护标签'],
    mitigation: ['低温、温和程序洗涤，避免热水与烘干', '不要挂着领口晾晒，平摊或对折悬挂', '穿脱时避免抓住领口拉扯'],
    seller_questions: ['领口是否做过拉伸回复或洗后尺寸稳定性测试？有可查看的结果吗？', '领口罗纹的氨纶比例是多少？'],
    verification: '拉伸领口后松手，观察 10 秒内回复程度；与同价位商品对比。',
    not_applicable: '高领/翻领等非罗纹结构不适用本条。',
    evidence_level: 'general_knowledge',
    sources: [SRC],
    limitations: '照片无法判断罗纹的纱线与弹性纤维比例，也无法测出实际回弹；本条只说明机制与观察点。',
    updated_at: UPDATED_AT
  },
  {
    id: 'collar-seam-strain',
    name: '领口拼缝与异材质连接的受力风险',
    categories: ['T恤', '卫衣', '羊毛衫'],
    requires_features: ['rib_collar'],
    any_features: ['splice_multi'],
    area: '领口接缝',
    failure_modes: ['缝线断裂、出现小裂口', '接缝处起皱或扭曲', '深浅拼接处先显旧'],
    mechanism: '罗纹与衣身的弹性差异会在接缝处形成集中应力；包边/压条工艺与缝线张力决定它能承受多少次拉伸。',
    impact: 'medium',
    likelihood_when_known: 'medium',
    evidence_needed: ['领口内侧接缝近景', '是否有包边/压条'],
    mitigation: ['洗涤时翻面、装洗衣袋', '避免与其他带钩挂件同洗'],
    seller_questions: ['领口接缝是包边还是直接锁边？可以做拉扯检查吗？'],
    verification: '轻拉领口接缝，看针脚是否均匀、有无跳针。',
    not_applicable: '一体成型（无缝）领口不适用。',
    evidence_level: 'industry_practice',
    sources: [SRC],
    limitations: '缝线强度无法从照片判断。',
    updated_at: UPDATED_AT
  },
  {
    id: 'cuff-hem-relax',
    name: '罗纹袖口/下摆松弛',
    categories: ['卫衣', 'T恤', '运动裤', '夹克'],
    requires_features: ['rib_cuff_hem'],
    area: '袖口 / 下摆',
    failure_modes: ['袖口变松、失去收口感', '下摆波浪化、不平整', '边缘磨损起毛'],
    mechanism: '收口部位长期承受拉伸与摩擦，弹性纤维疲劳后回复力下降；边缘还直接接触桌面与包带。',
    impact: 'medium',
    likelihood_when_known: 'medium',
    evidence_needed: ['袖口/下摆近景', '是否含氨纶及比例'],
    mitigation: ['避免长时间挂着袖口受力', '洗涤后整理平整再晾干'],
    seller_questions: ['袖口和下摆的罗纹是否含氨纶？比例多少？'],
    verification: '拉伸后观察回复；看边缘是否有起毛。',
    not_applicable: '无收口设计的直筒袖口/下摆不适用。',
    evidence_level: 'general_knowledge',
    sources: [SRC],
    limitations: '仅凭外观不能判断具体回弹寿命。',
    updated_at: UPDATED_AT
  },

  /* ───────── 二、起球、磨损、褪色、缩水、变形 ───────── */
  {
    id: 'knit-pilling',
    name: '针织物起球',
    categories: ['T恤', '卫衣', '羊毛衫', '运动裤'],
    requires_features: ['knit_structure'],
    area: '腋下 / 袖子内侧 / 衣身侧面 / 腰部',
    failure_modes: ['局部起球（腋下、袖内侧最先）', '绒面不均匀、视觉发毛'],
    mechanism: '短纤维或低捻纱在摩擦中迁移到表面并纠缠成球；针织结构蓬松、摩擦面积大，比紧密梭织更容易起球。',
    impact: 'low',
    likelihood_when_known: 'medium',
    evidence_needed: ['面料近景（能看清表面平整度）', '是否标注抗起球等级或检测报告'],
    mitigation: ['翻面洗涤、减少与粗糙面料摩擦', '不要用刷子或强力搓洗', '起球后用毛球修剪器处理，不要硬扯'],
    seller_questions: ['有抗起球测试结果吗（如 GB/T 4802 系列的测试等级）？'],
    verification: '用指腹在袖内侧来回摩擦数十次，观察是否起毛。',
    not_applicable: '紧密光滑的梭织面料（如府绸、牛仔）不适用。',
    evidence_level: 'general_knowledge',
    sources: [SRC],
    limitations: '起球程度取决于纱线结构与整理工艺，成分单一（如纯棉）并不保证不起球，反之亦然。',
    updated_at: UPDATED_AT
  },
  {
    id: 'wool-acrylic-pilling',
    name: '羊毛/腈纶混纺的起球与毡化',
    categories: ['羊毛衫', '大衣', '围巾/披肩'],
    requires_features: ['wool_rich'],
    area: '腋下 / 袖内侧 / 腰部',
    failure_modes: ['起球', '洗后毡化、尺寸缩小', '表面失去原有纹理'],
    mechanism: '动物纤维表面有鳞片，湿热与机械作用会互相纠缠（毡化）；纤维越细越软，耐磨与抗起球表现越依赖纺纱结构。',
    impact: 'medium',
    likelihood_when_known: 'medium',
    evidence_needed: ['成分比例', '是否防缩处理', '洗护标签'],
    mitigation: ['冷水手洗或羊毛程序，不要搓揉', '平摊晾干，不要悬挂', '避免烘干'],
    seller_questions: ['是否做过防缩处理？可以冷水手洗吗？'],
    verification: '查看洗护标签是否明确"不可机洗"；询问成分中的羊毛细度。',
    not_applicable: '含毛量很低（<10%）的混纺不适用本条。',
    evidence_level: 'general_knowledge',
    sources: [SRC],
    limitations: '无法从照片判断纤维细度与防缩工艺。',
    updated_at: UPDATED_AT
  },
  {
    id: 'brushed-surface-change',
    name: '磨毛/绒面的绒感变化与压亮',
    categories: [],
    requires_features: ['brushed_surface'],
    area: '衣身正面 / 袖内侧 / 臀部（坐压处）',
    failure_modes: ['局部压亮、倒绒', '绒面不均匀', '纤维脱落、掉毛'],
    mechanism: '起绒面料的表面纤维方向与密度决定观感；长期受压与摩擦会让绒毛倒伏，形成"压亮"的区域。',
    impact: 'low',
    likelihood_when_known: 'medium',
    evidence_needed: ['面料近景', '是否有绒面梳理说明'],
    mitigation: ['避免长时间局部受压', '低温轻柔洗涤，不要拧绞', '顺着绒毛方向熨烫（低温）'],
    seller_questions: ['面料是否有抗起球或绒面稳定性说明？'],
    verification: '用手掌在面料上单向抚过，观察是否出现明显色差带。',
    not_applicable: '光滑面、涂层光面不适用。',
    evidence_level: 'general_knowledge',
    sources: [SRC],
    limitations: '绒面变化属于正常现象与实质损伤之间的灰色地带，本工具不据此判定质量。',
    updated_at: UPDATED_AT
  },
  {
    id: 'dark-color-fade',
    name: '深色/高饱和色的褪色与磨白',
    categories: ['牛仔裤', '休闲裤', 'T恤', '卫衣', '外套'],
    any_features: ['knit_structure', 'woven_structure'],
    text_regex: /(黑色|深灰|藏青|深蓝|酒红|墨绿|深咖|黑)/,
    area: '领口 / 腋下 / 裤脚 / 膝盖 / 臀部 / 背包肩带接触处',
    failure_modes: ['高摩擦处先泛白', '洗后整体色光变化', '拼接处出现明显色差'],
    mechanism: '染料上染深度与色牢度决定抗磨白能力；深色面料一旦局部磨损，反差比浅色更明显。',
    impact: 'medium',
    likelihood_when_known: 'medium',
    evidence_needed: ['色牢度检测结果（耐摩擦、耐洗）', '是否做过固色处理'],
    mitigation: ['翻面洗涤、冷水、短周期', '深浅分开洗', '减少与背包带、粗糙表面的摩擦'],
    seller_questions: ['有耐摩擦色牢度与耐洗色牢度的检测结果吗？'],
    verification: '用白色湿布在面料上摩擦数次，看是否明显沾色。',
    not_applicable: '浅色/白色商品不适用本条；牛仔的预设水洗做旧效果不属于缺陷。',
    evidence_level: 'general_knowledge',
    sources: [SRC],
    limitations: '没有检测数据时只能说"值得关注"，不能断言一定褪色。',
    updated_at: UPDATED_AT
  },
  {
    id: 'cellulosic-shrinkage',
    name: '棉/再生纤维素的缩水与尺寸变化',
    categories: ['T恤', '衬衫', '连衣裙', '卫衣'],
    requires_features: ['knit_structure'],
    any_features: ['regenerated_cellulose', 'cotton_rich'],
    area: '衣长 / 袖长 / 整体廓形',
    failure_modes: ['衣长、袖长缩短', '衣身变窄', '下摆变形'],
    mechanism: '纤维素纤维在湿热与机械作用下会释放纺纱/织造时积累的内应力，产生收缩；是否预缩整理决定程度。',
    impact: 'medium',
    likelihood_when_known: 'medium',
    evidence_needed: ['是否标注预缩/水洗尺寸变化率', '洗护标签温度要求'],
    mitigation: ['按标签温度洗涤，避免高温烘干', '洗后立即整理形状再晾干'],
    seller_questions: ['面料是否做过预缩？水洗尺寸变化率是多少？'],
    verification: '查看详情页是否有"洗后尺寸变化率"说明或检测结果。',
    not_applicable: '标注"预缩处理"且有检测数据的商品，风险明显降低（但仍需按标签洗护）。',
    evidence_level: 'general_knowledge',
    sources: [SRC],
    limitations: '不能从成分标签预测具体缩水百分比；任何量化结论都需要检测数据。',
    updated_at: UPDATED_AT
  },
  {
    id: 'bias-distortion',
    name: '针织衣物的扭曲与版型走样',
    categories: ['T恤', '连衣裙', '卫衣'],
    requires_features: ['knit_structure'],
    any_features: ['splice_multi', 'long_knit'],
    area: '衣身侧缝 / 下摆 / 拼接处',
    failure_modes: ['侧缝扭转前移', '下摆不平', '拼接区域收缩不一致'],
    mechanism: '针织线圈在洗涤与悬挂中会沿受力方向发生位移；不同组织的拼接区域收缩率不同，差异会被放大。',
    impact: 'medium',
    likelihood_when_known: 'medium',
    evidence_needed: ['侧缝近景', '洗护标签', '是否标注尺寸稳定性'],
    mitigation: ['平摊晾干，不要湿挂', '不要用力拧绞'],
    seller_questions: ['是否做过洗后扭曲/尺寸稳定性测试？'],
    verification: '把衣服平铺，看侧缝是否明显斜向偏移。',
    not_applicable: '梭织衬衫类不适用（梭织更稳定）。',
    evidence_level: 'industry_practice',
    sources: [SRC],
    limitations: '轻微斜向在针织中属常见现象，本工具不据此判定为质量问题。',
    updated_at: UPDATED_AT
  },
  {
    id: 'long-knit-sag',
    name: '长款针织的垂坠拉伸',
    categories: ['羊毛衫', '连衣裙', '针织衫'],
    requires_features: ['long_knit'],
    area: '肩部 / 衣长 / 下摆',
    failure_modes: ['衣长被拉长', '肩线变形', '下摆松垮'],
    mechanism: '针织结构在自重下会缓慢变形，长款与宽松肩型受力更大；悬挂储存会加速这一过程。',
    impact: 'low',
    likelihood_when_known: 'medium',
    evidence_needed: ['克重与组织密度', '肩部结构'],
    mitigation: ['折叠收纳而不是长时间悬挂', '洗涤后平摊定型'],
    seller_questions: ['克重与针距是多少？是否有洗后尺寸稳定性说明？'],
    verification: '新衣量一次衣长，洗后复量对比。',
    not_applicable: '短款、紧身针织不适用。',
    evidence_level: 'general_knowledge',
    sources: [SRC],
    limitations: '设计本身的宽松垂坠风格 ≠ 使用后失去形状，本工具区分这两者。',
    updated_at: UPDATED_AT
  },

  /* ───────── 三、印花、涂层、装饰件 ───────── */
  {
    id: 'print-crack',
    name: '胶印/大面积印花开裂与翘边',
    categories: ['T恤', '卫衣', '外套'],
    requires_features: ['big_print'],
    area: '前胸图案 / 图案边缘 / 跨越接缝处',
    failure_modes: ['图案边角翘起', '弯折处出现细裂纹', '局部脱落'],
    mechanism: '塑胶类印花是覆盖在面料上的膜层，其延展性与面料不一致；弯折、洗涤摩擦与高温会让膜层疲劳。',
    impact: 'medium',
    likelihood_when_known: 'medium',
    evidence_needed: ['图案近景（边缘是否平整）', '印花工艺说明', '耐洗/耐摩擦测试结果'],
    mitigation: ['翻面洗涤、装洗衣袋', '不要用热水与烘干', '熨烫时避开图案或垫布低温'],
    seller_questions: ['印花是胶印、发泡还是热转印？有耐洗测试结果吗？'],
    verification: '沿图案边缘轻折，观察是否出现白痕或翘边。',
    not_applicable: '刺绣、水浆印等无膜层工艺不适用。',
    evidence_level: 'industry_practice',
    sources: [SRC],
    limitations: '印花的真实耐久性取决于浆料、固化条件与洗护，照片无法判断。',
    updated_at: UPDATED_AT
  },
  {
    id: 'print-on-stretch',
    name: '弹力面料上的印花更易开裂',
    categories: ['卫衣', '运动裤', 'T恤', '瑜伽/运动紧身衣'],
    requires_features: ['print_any'],
    any_features: ['stretch_fabric', 'high_spandex'],
    area: '图案覆盖的高伸展区域',
    failure_modes: ['拉伸处优先出现裂纹', '图案边缘与面料分离'],
    mechanism: '弹性面料在穿着中反复伸展，膜层印花延展性不足时会在同一位置反复受拉。',
    impact: 'medium',
    likelihood_when_known: 'high',
    evidence_needed: ['印花工艺', '面料弹性说明'],
    mitigation: ['避免机洗强力甩干', '不要从图案处用力拉扯穿脱'],
    seller_questions: ['弹力面料上的印花用的是弹性浆还是普通胶印？'],
    verification: '在图案区域横向拉伸，观察是否出现细白纹。',
    not_applicable: '无弹性的梭织面料不适用。',
    evidence_level: 'industry_practice',
    sources: [SRC],
    limitations: '仅凭照片无法判断浆料类型。',
    updated_at: UPDATED_AT
  },
  {
    id: 'coating-peel',
    name: '涂层/仿皮的弯折开裂与剥离',
    categories: ['外套', '夹克', '大衣', '半身裙'],
    requires_features: ['coating_faux_leather'],
    area: '袖窿 / 肘部 / 口袋边缘 / 接缝处',
    failure_modes: ['弯折处细裂纹', '表层剥离、起皮', '表面发黏或失去均匀质感'],
    mechanism: '涂层与基布的热膨胀、柔韧性不同；反复弯折使界面产生疲劳，接缝边缘的摩擦会加速脱层。',
    impact: 'high',
    likelihood_when_known: 'medium',
    evidence_needed: ['涂层类型（PU/PVC/其他）', '近景观察是否已有细纹', '耐磨/耐折测试结果'],
    mitigation: ['避免高温与暴晒', '不要用酒精等溶剂擦拭', '悬挂存放，避免长期折叠压痕'],
    seller_questions: ['表面是 PU 涂层还是其他材料？有耐折/耐磨测试吗？'],
    verification: '在肘部内侧轻折，观察是否有白色折痕或细裂。',
    not_applicable: '真正的皮革（非涂层）与本条不同，需另判。',
    evidence_level: 'general_knowledge',
    sources: [SRC],
    limitations: '图片无法确认化学材质，只能表述为"疑似涂层/仿皮结构"；也不能断言它会脱皮。',
    updated_at: UPDATED_AT
  },
  {
    id: 'embroidery-attach',
    name: '刺绣/贴布/珠片的连接失效',
    categories: [],
    requires_features: ['embroidery_beads'],
    area: '装饰区域 / 洗后摩擦区',
    failure_modes: ['线头松散、绣线起毛', '贴布边缘翘起', '珠片/铆钉脱落', '连接处织物被拉破'],
    mechanism: '装饰件把应力集中到少量缝线上；金属或硬质件还会磨损周围纱线，洗涤时容易勾挂。',
    impact: 'medium',
    likelihood_when_known: 'medium',
    evidence_needed: ['装饰件固定方式近景（内侧是否有加固）', '洗护说明'],
    mitigation: ['装洗衣袋、翻面洗', '不要与针织/蕾丝同洗', '发现线头及时处理，避免继续脱散'],
    seller_questions: ['珠片/装饰是缝制还是粘合？内侧有加固吗？'],
    verification: '轻拨装饰件，观察是否有松动；翻看内侧是否有衬布。',
    not_applicable: '印花/烫画类装饰不适用。',
    evidence_level: 'general_knowledge',
    sources: [SRC],
    limitations: '看不清固定方式时不能断言牢固或易脱落。',
    updated_at: UPDATED_AT
  },
  {
    id: 'metal-hardware-wear',
    name: '金属五金与拉链的磨损',
    categories: ['外套', '夹克', '牛仔裤', '休闲裤'],
    requires_features: ['metal_hardware'],
    area: '门襟 / 拉链头 / 金属扣 / 铆钉',
    failure_modes: ['镀层磨损、露出底色', '拉链卡顿或咬合不齐', '金属件边缘磨伤周围面料'],
    mechanism: '金属件与面料硬度差异大，摩擦时面料先磨损；镀层厚度与拉头精度决定顺滑度与耐久。',
    impact: 'medium',
    likelihood_when_known: 'medium',
    evidence_needed: ['拉链品牌/型号', '金属件近景', '是否有防刮设计'],
    mitigation: ['拉链拉到顶再穿脱，减少侧向拉扯', '定期用蜡或专用润滑', '洗涤前拉好拉链、扣好扣子'],
    seller_questions: ['拉链是什么品牌/型号？金属件是否做过盐雾测试？'],
    verification: '反复拉动拉链数次，感受是否顺滑、有无卡点。',
    not_applicable: '塑料拉链、隐形拉链不适用镀层磨损部分。',
    evidence_level: 'general_knowledge',
    sources: [SRC],
    limitations: '外观无法判断内部结构与镀层厚度。',
    updated_at: UPDATED_AT
  },
  {
    id: 'button-hole-loose',
    name: '纽扣与扣眼的松动',
    categories: ['衬衫', '外套', '西装', '大衣'],
    text_regex: /(纽扣|扣眼|门襟)/,
    area: '门襟 / 袖口',
    failure_modes: ['扣眼变大、脱线', '纽扣缝线松脱', '扣位受力处面料撕裂'],
    mechanism: '扣眼是面料被切开后的薄弱点，反复受力会扩大；纽扣缝线的收尾打结质量决定脱落概率。',
    impact: 'low',
    likelihood_when_known: 'medium',
    evidence_needed: ['门襟近景（扣眼锁边是否完整）', '纽扣背面缝线'],
    mitigation: ['穿脱时解开扣子而不是硬拉', '发现线头及时加固'],
    seller_questions: ['扣眼是否锁边处理？纽扣是几道线固定？'],
    verification: '翻到内侧看纽扣缝线是否有打结与加固。',
    not_applicable: '无纽扣的套头款不适用。',
    evidence_level: 'industry_practice',
    sources: [SRC],
    limitations: '照片难以判断缝线牢固度。',
    updated_at: UPDATED_AT
  },

  /* ───────── 四、品类专属的高磨损区域 ───────── */
  {
    id: 'jeans-crotch-thigh',
    name: '牛仔裤裤裆与大腿内侧磨损',
    categories: ['牛仔裤', '休闲裤'],
    requires_features: ['woven_structure'],
    area: '裤裆 / 大腿内侧 / 臀部',
    failure_modes: ['大腿内侧先磨白', '裤裆缝线断裂', '弹力区域先变薄'],
    mechanism: '行走时大腿内侧持续摩擦，牛仔斜纹虽耐磨，但同一位置反复受力后纱线会变细；含弹力的牛仔更易在摩擦处变薄。',
    impact: 'medium',
    likelihood_when_known: 'medium',
    evidence_needed: ['克重（越厚通常越耐磨）', '是否含氨纶及比例', '裤裆内侧缝线做工'],
    mitigation: ['避免连续多天穿着同一件', '翻面洗、减少高温烘干', '发现变薄及时加固'],
    seller_questions: ['面料克重是多少？是否含弹力？裤裆是单线还是双线缝合？'],
    verification: '把裤子翻到内侧，看裤裆缝是否双道线并有加固。',
    not_applicable: '裙装、短裤不适用。',
    evidence_level: 'general_knowledge',
    sources: [SRC],
    limitations: '牛仔的褪色做旧是设计效果，不能与磨损混为一谈。',
    updated_at: UPDATED_AT
  },
  {
    id: 'pants-hem-knee',
    name: '裤脚与膝盖的形状变化',
    categories: ['牛仔裤', '休闲裤', '运动裤'],
    area: '膝盖 / 裤脚',
    failure_modes: ['膝盖处鼓包或变形', '裤脚边缘磨损起毛', '裤脚长短不一'],
    mechanism: '膝盖在坐立中反复弯曲，纤维被拉伸后难以完全回复；裤脚直接接触地面与鞋面。',
    impact: 'low',
    likelihood_when_known: 'medium',
    evidence_needed: ['面料成分与弹性', '裤脚是否有包边'],
    mitigation: ['避免长时间保持同一坐姿', '裤脚过长建议改短，减少拖地'],
    seller_questions: ['裤脚是折边还是锁边？是否有加固？'],
    verification: '查看裤脚内侧折边宽度与线迹密度。',
    not_applicable: '九分裤/短裤不适用裤脚拖地部分。',
    evidence_level: 'general_knowledge',
    sources: [SRC],
    limitations: '照片无法判断穿着者的使用习惯，可能性因人而异。',
    updated_at: UPDATED_AT
  },
  {
    id: 'coat-shoulder-armhole',
    name: '外套/西装的肩部与袖窿变形',
    categories: ['西装', '大衣', '风衣'],
    area: '肩部 / 袖窿 / 袖肘 / 翻领',
    failure_modes: ['肩部磨亮、起球', '袖窿处面料拉扯变形', '翻领边缘磨白', '内衬松脱'],
    mechanism: '肩部承受衣身重量与背包摩擦；袖窿是曲面拼接，缝份与衬布决定形状保持；内衬与面料的缩率差异会导致松脱。',
    impact: 'medium',
    likelihood_when_known: 'medium',
    evidence_needed: ['是否有衬/粘合工艺说明', '内衬材质', '肩部近景'],
    mitigation: ['使用合适的衣架（宽肩）', '避免长期背单肩包摩擦', '按标签干洗'],
    seller_questions: ['肩部是有衬还是无衬结构？内衬是什么材质？'],
    verification: '捏一下翻领与肩部，感受是否有衬布支撑。',
    not_applicable: '针织外套不适用粘合衬部分。',
    evidence_level: 'industry_practice',
    sources: [SRC],
    limitations: '粘合衬与定型工艺无法从外观判断，规范要求此处必须标"无法判断"。',
    updated_at: UPDATED_AT
  },
  {
    id: 'hoodie-cord-anchor',
    name: '帽绳与帽子连接处的受力',
    categories: ['卫衣'],
    requires_features: ['drawstring_hood'],
    area: '帽绳孔 / 帽子与衣身连接',
    failure_modes: ['帽绳孔处面料撕裂', '帽绳端头磨损散开', '帽子与领口接缝拉长'],
    mechanism: '帽绳孔是面料被冲孔后的薄弱点；帽子重量集中在领口几道缝线上。',
    impact: 'low',
    likelihood_when_known: 'medium',
    evidence_needed: ['帽绳孔是否有金属环/加固', '帽子缝合方式'],
    mitigation: ['洗涤前取下帽绳或打结固定', '避免用力拽帽绳'],
    seller_questions: ['帽绳孔有金属环加固吗？'],
    verification: '轻拉帽绳，观察孔边缘是否变形。',
    not_applicable: '无帽款不适用。',
    evidence_level: 'general_knowledge',
    sources: [SRC],
    limitations: '无法判断长期使用后的具体表现。',
    updated_at: UPDATED_AT
  },
  {
    id: 'shirt-collar-wear',
    name: '衬衫领口与袖口的磨损发白',
    categories: ['衬衫'],
    requires_features: ['woven_structure'],
    area: '衣领 / 领座 / 袖口 / 门襟',
    failure_modes: ['领口内侧磨白', '领座起皱变形', '袖口边缘磨损', '频繁熨烫处发亮'],
    mechanism: '领口与皮肤、胡须、项链持续摩擦；领座内的衬布在反复洗涤与熨烫后失去挺度。',
    impact: 'medium',
    likelihood_when_known: 'medium',
    evidence_needed: ['领座是否有衬', '面料成分（浅色棉更易显磨白）', '是否免烫整理'],
    mitigation: ['穿后及时洗涤，避免汗渍长期停留', '熨烫时垫布，避免直接高温压亮', '深浅分开洗'],
    seller_questions: ['领座是有衬还是无衬？是否做过免烫整理？'],
    verification: '翻看领座内侧是否有衬布层；观察领尖是否平整。',
    not_applicable: '立领/无领款不适用。',
    evidence_level: 'general_knowledge',
    sources: [SRC],
    limitations: '浅色棉的磨白属于常见使用痕迹，本工具不据此判定质量问题。',
    updated_at: UPDATED_AT
  },
  {
    id: 'sport-seam-strain',
    name: '运动服的接缝与印花受力',
    categories: ['瑜伽/运动紧身衣', '运动裤', '卫衣'],
    requires_features: ['stretch_fabric'],
    area: '肩缝 / 腋下 / 裆部 / 高伸展区',
    failure_modes: ['接缝处跳线或开裂', '弹性减弱、包裹感下降', '反光/印花层脱落'],
    mechanism: '高弹面料在运动中反复大幅伸展，普通平缝线的延展性不足，会在接缝处先失效。',
    impact: 'medium',
    likelihood_when_known: 'medium',
    evidence_needed: ['是否四针六线/包缝工艺', '氨纶比例', '是否有运动类检测'],
    mitigation: ['避免高温洗涤与烘干（保护氨纶）', '不要与魔术贴/拉链同洗', '按运动强度轮换穿着'],
    seller_questions: ['接缝用的是平缝还是四针六线？氨纶比例是多少？'],
    verification: '横向拉伸接缝处，看线迹是否跟着伸展、有无发白。',
    not_applicable: '无弹性的梭织运动外套不适用。',
    evidence_level: 'industry_practice',
    sources: [SRC],
    limitations: '仅凭标注"含氨纶"不能推断耐久性。',
    updated_at: UPDATED_AT
  },

  /* ───────── 通用：弹性、腰头、洗护负担、宣称 ───────── */
  {
    id: 'spandex-decay',
    name: '弹性纤维的热老化与回弹衰减',
    categories: ['牛仔裤', '运动裤', '瑜伽/运动紧身衣', '内衣', 'T恤'],
    any_features: ['spandex_low', 'high_spandex'],
    area: '腰部 / 膝部 / 臀部的弹力区域',
    failure_modes: ['弹性逐步下降', '局部松垮（膝盖、腰部）', '面料变薄'],
    mechanism: '氨纶在高温、氯（泳池）与长期拉伸下会降解，回弹力随之下降；比例越高，对洗护越敏感。',
    impact: 'medium',
    likelihood_when_known: 'medium',
    evidence_needed: ['氨纶比例', '洗护标签温度', '是否有回弹测试'],
    mitigation: ['避免高温烘干与热水洗', '泳池后及时清水冲洗', '不要长期挂在窄衣架上拉伸'],
    seller_questions: ['氨纶含量多少？是否做过回弹率测试？'],
    verification: '拉伸后静置，观察回复速度与残留变形。',
    not_applicable: '不含弹性纤维的商品不适用。',
    evidence_level: 'general_knowledge',
    sources: [SRC],
    limitations: '无法预测具体衰减速度，只能提示影响因素。',
    updated_at: UPDATED_AT
  },
  {
    id: 'elastic-waist-relax',
    name: '松紧腰头的松弛与卷边',
    categories: ['休闲裤', '运动裤', '半身裙', '短裤'],
    requires_features: ['elastic_waist'],
    area: '腰头',
    failure_modes: ['腰头变松', '橡筋扭转、卷边', '腰头布料起皱'],
    mechanism: '橡筋在反复拉伸与热水中失去弹性；腰头通道内橡筋的固定方式决定是否扭转。',
    impact: 'medium',
    likelihood_when_known: 'medium',
    evidence_needed: ['腰头是否有抽绳/多道橡筋', '洗护标签'],
    mitigation: ['避免高温烘干', '洗涤时把腰头自然展开，不要卷成一团'],
    seller_questions: ['腰头是几道橡筋？有抽绳吗？'],
    verification: '拉伸腰头后松手，观察是否立即回弹、橡筋是否扭转。',
    not_applicable: '纽扣/拉链腰头不适用。',
    evidence_level: 'general_knowledge',
    sources: [SRC],
    limitations: '无法判断橡筋质量与具体寿命。',
    updated_at: UPDATED_AT
  },
  {
    id: 'dry-clean-burden',
    name: '洗护成本与使用限制',
    categories: [],
    requires_features: ['dry_clean_only'],
    area: '整体（使用与维护）',
    failure_modes: ['需要频繁干洗、维护成本高', '自行水洗可能导致变形或缩水'],
    mechanism: '干洗依赖来自面料对水与机械作用的敏感性，而不是耐久性问题。',
    impact: 'low',
    likelihood_when_known: 'high',
    evidence_needed: ['洗护标签原文'],
    mitigation: ['按标签送洗', '穿后通风，减少洗涤频次', '备一件替换以降低单件损耗'],
    seller_questions: ['是否可以冷水手洗？水洗会有什么风险？'],
    verification: '查看水洗标是否有"仅可干洗"。',
    not_applicable: '可机洗商品不适用。',
    evidence_level: 'observed_defect',
    sources: ['商品洗护标签（已标注）'],
    limitations: '成本提示不属于质量判断。',
    updated_at: UPDATED_AT
  },
  {
    id: 'claim-without-data',
    name: '性能宣称缺少可核验依据',
    categories: [],
    requires_features: ['performance_claim'],
    area: '面料性能（整体）',
    failure_modes: ['宣称的性能无法验证', '实际表现可能与文案不符'],
    mechanism: '抗起球、耐磨、防水等指标需要对应标准下的测试结果；页面文案不构成证据。',
    impact: 'medium',
    likelihood_when_known: 'unknown',
    evidence_needed: ['检测报告编号与机构', '测试标准与结果'],
    mitigation: ['以检测报告为准，不依赖文案'],
    seller_questions: ['这项性能有检测报告吗？依据哪个标准、结果是多少？'],
    verification: '索取报告首页（含编号、机构、样品、依据标准）与结论页。',
    not_applicable: '无性能宣称的商品不适用。',
    evidence_level: 'general_knowledge',
    sources: ['消费者权益相关常识：宣传与检测是两件事'],
    limitations: '本工具不判断宣称是否违法，只提示需要证据。',
    updated_at: UPDATED_AT
  },
  {
    id: 'existing-damage',
    name: '图片/描述中已存在的损伤迹象',
    categories: [],
    requires_features: ['visible_defect'],
    area: '见原文描述的位置',
    failure_modes: ['已出现的起球/勾丝/开裂/开线/变形'],
    mechanism: '这是**当前已经发生**的现象，与"未来可能发生"不同：需要判断是二手/样衣/瑕疵品，还是图片误读。',
    impact: 'high',
    likelihood_when_known: 'high',
    evidence_needed: ['对应位置的清晰近景', '卖家说明（是否二手/瑕疵）'],
    mitigation: ['要求卖家提供该位置的新照片', '确认退换政策'],
    seller_questions: ['这里是否已有起球/开线/磨损？是全新品吗？'],
    verification: '让卖家补拍该位置，并与商品主图对比。',
    not_applicable: '无此类描述时不适用。',
    evidence_level: 'observed_defect',
    sources: ['商品文字描述本身'],
    limitations: '文字可能描述的是"抗起球"等宣传语而非实际损伤，需结合上下文；本工具会同时给出两种可能。',
    updated_at: UPDATED_AT
  }
];

/** 品类 → 重点观察区域（用于"风险分布图"） */
const CATEGORY_REGIONS = {
  T恤: ['领口', '肩部', '袖口', '腋下', '前胸', '下摆'],
  卫衣: ['领口', '帽绳孔', '袖口', '腋下', '前胸图案', '下摆'],
  衬衫: ['衣领', '领座', '肩缝', '袖口', '门襟', '下摆'],
  羊毛衫: ['领口', '肩部', '袖口', '腋下', '下摆'],
  大衣: ['肩部', '袖窿', '翻领', '袖口', '口袋', '下摆', '内衬'],
  西装: ['肩部', '袖窿', '翻领', '门襟', '口袋', '内衬'],
  风衣: ['肩部', '袖口', '门襟', '腰带', '下摆'],
  羽绒服: ['肩部', '袖口', '拉链', '口袋', '下摆'],
  牛仔裤: ['腰部', '裤裆', '大腿内侧', '膝盖', '臀部', '裤脚', '口袋边缘'],
  休闲裤: ['腰部', '裤裆', '膝盖', '裤脚', '口袋边缘'],
  运动裤: ['腰部', '裤裆', '膝盖', '裤脚', '侧缝'],
  半身裙: ['腰部', '拉链', '裙摆', '侧缝'],
  连衣裙: ['领口', '肩部', '腋下', '腰部', '裙摆'],
  '瑜伽/运动紧身衣': ['肩缝', '腋下', '胸部', '裆部', '接缝'],
  内衣: ['肩带', '罩杯边缘', '下围', '搭扣'],
  童装: ['领口', '袖口', '膝盖', '拉链', '装饰件']
};

module.exports = { RULES, CATEGORY_REGIONS, UPDATED_AT, SRC };

  };
  defs["core/compare.js"] = function (module, exports, require) {
/**
 * comparison-service：2–3 件商品的横向比较。
 *
 * 硬性约束（规范 页面 F）：
 * - 不把"信息完整"的商品判定为"质量最好"，也不把"信息缺失"判定为差；
 * - 最终建议必须挂到用户偏好上，并说明依据；
 * - 价格只在有可靠来源时展示，并且不参与"值不值"的品质判断。
 */

'use strict';

const MAX_ITEMS = 3;

/**
 * @param {{reports: Array<object>, profile?: object}} input
 */
function buildComparison(input) {
  const reports = (input && input.reports) || [];
  const profile = (input && input.profile) || null;
  if (reports.length < 2) {
    return {
      ok: false,
      message: '至少需要两件商品才能比较',
      rows: [],
      suggestion: null
    };
  }
  const items = reports.slice(0, MAX_ITEMS);

  const col = (r) => ({
    id: r.analysis_id,
    name: r.header.product_name,
    category: r.header.category,
    demo: Boolean(r.demo),
    mode: r.mode
  });

  const rows = [
    row('基本信息', items, (r) => [
      text(r.header.product_name || '未识别'),
      text(r.header.category || '未识别', r.header.category ? 'extracted' : 'missing')
    ]),
    row('价格', items, (r) => {
      if (r.header.price == null) return [text('未提供', 'missing', '缺少可靠价格来源，不参与比较')];
      return [text(`¥${r.header.price}`, 'extracted', r.header.price_note || '来自截图，可能随促销变化')];
    }),
    row('纤维成分（商家标注）', items, (r) => {
      const f = r.sections.find((s) => s.key === 'fabric');
      const comp = f && f.composition;
      if (!comp || !comp.value) return [text('未提供', 'missing', '没有成分标注')];
      return [text(comp.value, 'extracted', '标注内容，非实测')];
    }),
    row('克重 / 支数', items, (r) => {
      const w = r.weight || {};
      const y = r.yarn || {};
      const wText = w.status === 'reference_only' ? `${w.value} g/m²（区间内对照）` : w.status === 'missing' ? '未提供' : w.status === 'ambiguous' ? `${w.value == null ? '' : w.value} 口径待确认` : '未评级';
      const yText = y.status === 'missing' ? '未提供' : `${y.value}${y.system ? ' ' + y.system : ''}`;
      return [text(`${wText} / ${yText}`, w.status === 'reference_only' ? 'extracted' : 'missing', w.message || '')];
    }),
    row('执行标准与核验状态', items, (r) => {
      const s = r.standard || {};
      if (!s.appears_in_product) return [text('未标注', 'missing', '截图中没有标准号')];
      const label = s.registry_match ? `${s.normalized_code} · ${s.official_status_label}` : `${s.normalized_code || '原文'} · 未核验`;
      return [text(label, s.registry_match ? 'official_verified' : 'pending_verification', s.registry_match ? `核验于 ${String(s.last_verified_at || '').slice(0, 10)}` : '需人工核实')];
    }),
    row('标准与品类匹配', items, (r) => {
      const s = r.standard || {};
      const map = { likely: '可能匹配', unlikely: '可能不匹配', unknown: '无法判断' };
      return [text(map[s.applicability] || '无法判断', s.applicability === 'likely' ? 'inferred' : s.applicability === 'unlikely' ? 'conflict' : 'pending_verification', s.applicability_reason || '')];
    }),
    row('信息完整度', items, (r) => [
      text(`${r.header.completeness.level_label}（${r.header.completeness.ratio * 100}%）`, r.header.completeness.level === 'high' ? 'ok' : r.header.completeness.level === 'medium' ? 'warn' : 'alert', r.header.completeness.note)
    ]),
    row('主要疑点', items, (r) => {
      const top = (r.doubts || []).slice(0, 3);
      if (!top.length) return [text('暂未发现', 'ok')];
      return top.map((d) => text(d.title, d.severity === 'attention' ? 'alert' : 'warn', d.reason));
    }),
    row('洗护要求', items, (r) => {
      const s = r.sections.find((x) => x.key === 'care');
      if (!s) return [text('未提供', 'missing')];
      const has = s.label_item && s.label_item.value;
      return [text(has ? s.label_item.value : '无标签信息', has ? 'extracted' : 'missing', has ? '来自洗护标签' : '只能给成分层面的通用建议')];
    }),
    row('使用场景建议', items, (r) => [text(sceneAdvice(r, profile), 'inferred', '基于品类与成分的通用推断，不是实测')]),
    row('购买前需确认', items, (r) => {
      const qs = (r.questions || []).slice(0, 3);
      return qs.length ? qs.map((q) => text(q, 'warn')) : [text('无特别事项', 'ok')];
    })
  ];

  const suggestion = buildSuggestion({ items, profile, rows });

  return {
    ok: true,
    items: items.map(col),
    rows,
    suggestion,
    disclaimer:
      '比较表只呈现"已知信息的差异"。信息更完整 ≠ 质量更好；价格更低 ≠ 更值得买。请结合你的使用场景与偏好判断。'
  };
}

function row(label, items, fn) {
  return {
    label,
    cells: items.map((r) => {
      const cells = fn(r) || [];
      return cells.length ? cells : [text('—', 'missing')];
    })
  };
}

function text(value, status, note) {
  return { value: value == null ? '' : String(value), status: status || 'info', note: note || null };
}

function sceneAdvice(report, profile) {
  const category = report.header.category;
  const fibers = (report.sections.find((s) => s.key === 'fabric') || {}).fiber_notes;
  const items = (fibers && fibers.items) || [];
  const names = items.map((i) => i.fiber).join('、');
  const bits = [];
  if (category) bits.push(category);
  if (names) bits.push(names);
  if (/聚酯|锦纶|氨纶/.test(names)) bits.push('偏运动/外套场景');
  if (/棉|亚麻|莫代尔|莱赛尔/.test(names)) bits.push('日常贴身穿着');
  if (/羊毛|羊绒|羽绒|腈纶/.test(names)) bits.push('保暖场景，注意洗护');
  const scenes = Array.isArray(profile && profile.scenes) ? profile.scenes.filter(Boolean) : [];
  if (scenes.length) {
    const matches = scenes.filter((s) => bits.join('').includes(s.slice(0, 2)));
    bits.push(matches.length ? `与你常穿场景（${matches.join('、')}）方向一致` : `与你常穿场景（${scenes.join('、')}）关系不明确`);
  }
  return bits.length ? bits.join('；') : '信息不足，无法给出场景建议';
}

/**
 * 最终建议：只与偏好挂钩，并且明确说明"这不是质量排名"。
 */
function buildSuggestion({ items, profile, rows }) {
  const prefs = profile || {};
  const preferences = [];
  if (prefs.looseness) preferences.push(`宽松程度：${prefs.looseness}`);
  if (prefs.warmth) preferences.push(`保暖偏好：${prefs.warmth}`);
  if (prefs.breathability) preferences.push(`透气偏好：${prefs.breathability}`);
  if (prefs.care) preferences.push(`洗护难度接受度：${prefs.care}`);
  if (Array.isArray(prefs.scenes) && prefs.scenes.length) preferences.push(`常穿场景：${prefs.scenes.join('、')}`);

  const lines = [];
  const perItem = items.map((r) => {
    const fit = r.fit || {};
    const comp = r.header.completeness;
    return {
      id: r.header.product_name,
      fit_status: fit.status,
      fit_match: fit.fit_match || null,
      completeness: comp.level,
      doubts: r.doubt_counts,
      price: r.header.price
    };
  });

  const fitMatched = perItem.filter((p) => p.fit_match === 'match');
  const fitMismatched = perItem.filter((p) => p.fit_match === 'mismatch');
  if (fitMatched.length) lines.push(`${fitMatched.map((p) => `「${p.id}」`).join('、')}的版型方向与你的偏好一致。`);
  if (fitMismatched.length) lines.push(`${fitMismatched.map((p) => `「${p.id}」`).join('、')}的版型方向与偏好相反，谨慎考虑。`);

  const mostComplete = perItem.slice().sort((a, b) => (b.completeness === 'high' ? 1 : 0) - (a.completeness === 'high' ? 1 : 0))[0];
  if (mostComplete) {
    lines.push(
      `信息最完整的是「${mostComplete.id}」（${mostComplete.completeness === 'high' ? '较完整' : mostComplete.completeness === 'medium' ? '部分完整' : '信息不足'}），` +
        '这只说明它的参数更可核实，不代表质量更好。'
    );
  }
  const withStandard = perItem.filter((p) => {
    const r = items.find((x) => x.header.product_name === p.id);
    return r && r.standard && r.standard.registry_match;
  });
  if (withStandard.length) {
    lines.push(`${withStandard.map((p) => `「${p.id}」`).join('、')}的执行标准号已在官方平台核验到状态，其余需自行确认。`);
  }

  const priceKnown = perItem.filter((p) => p.price != null);
  if (priceKnown.length >= 2) {
    const min = priceKnown.slice().sort((a, b) => a.price - b.price)[0];
    lines.push(`价格最低的是「${min.id}」（¥${min.price}），但价格高低与面料品质没有必然关系，不参与质量判断。`);
  }

  lines.push('没有哪一件可以被称为"质量最好"：本系统没有检测数据，也没有同类样本评分。');

  return {
    preferences,
    lines,
    next_step: '建议把每件商品的"购买前需确认"问题发给对应客服，得到答复后再决定。',
    basis: '以上建议依据：版型描述与你偏好的对应关系、信息完整度、标准号核验结果。不包含实测数据。',
    rows_reference: rows.map((r) => r.label)
  };
}

module.exports = { buildComparison, MAX_ITEMS };

  };
  defs["core/manual-fields.js"] = function (module, exports, require) {
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

  };
  defs["core/schema.js"] = function (module, exports, require) {
/**
 * 结构校验：模型输出必须过这一关才能进入业务层。
 *
 * 为什么不用 ajv 之类的库：
 * 小程序包里每多一个依赖都要占体积，而这里只需要"拒绝明显不合规的输出"，
 * 不需要完整的 JSON Schema 实现。规则写死在这里，反而更容易审阅。
 */

'use strict';

const { FIELD_STATUS, SOURCE_TYPE } = require('./fields');

const VALID_STATUS = new Set(Object.values(FIELD_STATUS));
const VALID_SOURCE = new Set(Object.values(SOURCE_TYPE));

const KINDS = new Set([SOURCE_TYPE.PROMO_SCREENSHOT, SOURCE_TYPE.PHYSICAL_LABEL, SOURCE_TYPE.SIZE_CHART, SOURCE_TYPE.DETAIL_PHOTO]);

/**
 * 校验 OCR/视觉适配器的输出。
 * @param {any} payload
 * @returns {{ok:boolean, errors:Array<{path:string,message:string}>, sanitized:object|null}}
 */
function validateOcrPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object') {
    return { ok: false, errors: [{ path: '$', message: '不是对象' }], sanitized: null };
  }
  const images = Array.isArray(payload.images) ? payload.images : null;
  if (!images) return { ok: false, errors: [{ path: '$.images', message: '缺少 images 数组' }], sanitized: null };
  if (images.length === 0) errors.push({ path: '$.images', message: 'images 为空' });
  if (images.length > 9) errors.push({ path: '$.images', message: '图片数量超过 9 张' });

  const sanitized = { images: [] };
  images.forEach((img, i) => {
    const at = `$.images[${i}]`;
    if (!img || typeof img !== 'object') {
      errors.push({ path: at, message: '不是对象' });
      return;
    }
    const kind = img.kind || SOURCE_TYPE.PROMO_SCREENSHOT;
    if (!KINDS.has(kind)) errors.push({ path: `${at}.kind`, message: `未知图片来源类型：${kind}` });
    const blocks = Array.isArray(img.blocks) ? img.blocks : null;
    if (!blocks) {
      errors.push({ path: `${at}.blocks`, message: '缺少 blocks 数组' });
      return;
    }
    const cleanBlocks = [];
    blocks.forEach((b, j) => {
      const bat = `${at}.blocks[${j}]`;
      if (!b || typeof b !== 'object') {
        errors.push({ path: bat, message: '不是对象' });
        return;
      }
      if (typeof b.text !== 'string' || !b.text.trim()) {
        errors.push({ path: `${bat}.text`, message: 'text 必须是非空字符串' });
        return;
      }
      const conf = typeof b.confidence === 'number' ? Math.min(1, Math.max(0, b.confidence)) : null;
      cleanBlocks.push({
        text: b.text.slice(0, 2000),
        confidence: conf,
        box: Array.isArray(b.box) && b.box.length === 4 && b.box.every((n) => typeof n === 'number') ? b.box : null
      });
    });
    sanitized.images.push({
      id: typeof img.id === 'string' && img.id ? img.id : `img-${i + 1}`,
      kind: KINDS.has(kind) ? kind : SOURCE_TYPE.PROMO_SCREENSHOT,
      blocks: cleanBlocks
    });
  });

  return { ok: errors.length === 0, errors, sanitized: errors.length ? sanitized : sanitized };
}

/** 校验模型返回的"字段 JSON"（可选路径：模型直接输出结构化字段而不是 OCR 文本） */
function validateFieldPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.fields)) {
    return { ok: false, errors: [{ path: '$.fields', message: '需要 fields 数组' }], sanitized: null };
  }
  const fields = [];
  payload.fields.forEach((f, i) => {
    const at = `$.fields[${i}]`;
    if (!f || typeof f.field_key !== 'string') {
      errors.push({ path: at, message: 'field_key 缺失' });
      return;
    }
    if (f.status && !VALID_STATUS.has(f.status)) errors.push({ path: `${at}.status`, message: `未知状态 ${f.status}` });
    if (f.source_type && !VALID_SOURCE.has(f.source_type)) errors.push({ path: `${at}.source_type`, message: `未知来源 ${f.source_type}` });
    fields.push({
      field_key: f.field_key,
      raw_text: typeof f.raw_text === 'string' ? f.raw_text : null,
      normalized_value: f.normalized_value === undefined ? null : f.normalized_value,
      unit: typeof f.unit === 'string' ? f.unit : null,
      status: VALID_STATUS.has(f.status) ? f.status : FIELD_STATUS.EXTRACTED,
      source_type: VALID_SOURCE.has(f.source_type) ? f.source_type : SOURCE_TYPE.PROMO_SCREENSHOT,
      source_image_id: typeof f.source_image_id === 'string' ? f.source_image_id : null,
      confidence: typeof f.confidence === 'number' ? Math.min(1, Math.max(0, f.confidence)) : null,
      evidence_note: typeof f.evidence_note === 'string' ? f.evidence_note.slice(0, 500) : null
    });
  });
  return { ok: errors.length === 0, errors, sanitized: { fields } };
}

/** 校验分析卡是否包含必需结构（服务端返回给小程序前的最后一道关） */
function validateReport(report) {
  const errors = [];
  if (!report || typeof report !== 'object') return { ok: false, errors: [{ path: '$', message: '不是对象' }] };
  if (!report.header || typeof report.header.conclusion !== 'string') errors.push({ path: '$.header.conclusion', message: '缺少一句话结论' });
  if (!Array.isArray(report.sections)) errors.push({ path: '$.sections', message: '缺少 sections' });
  if (!Array.isArray(report.doubts)) errors.push({ path: '$.doubts', message: '缺少 doubts' });
  if (!Array.isArray(report.limits) || report.limits.length === 0) errors.push({ path: '$.limits', message: '缺少边界说明' });
  if (!report.disclaimer) errors.push({ path: '$.disclaimer', message: '缺少免责声明' });
  if (report.standard && report.standard.compliance !== 'not_assessed') {
    errors.push({ path: '$.standard.compliance', message: '不允许输出符合性结论' });
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { validateOcrPayload, validateFieldPayload, validateReport };

  };
  defs["core/data/demo.products.js"] = function (module, exports, require) {
/**
 * 演示数据（DEMO）。
 *
 * 这些文本块是**人工构造的模拟 OCR 输出**，不是真实商品截图，也不代表真实品牌。
 * 目的是让"没有模型 API、没有 OCR 服务"的环境也能跑通完整流程。
 * 所有经由这里的分析结果都会带 demo=true，界面必须显示「演示数据」。
 *
 * 三个示例分别覆盖：
 * 1) 信息齐全 + 有营销宣称（触发宣称规则）
 * 2) 只有吊牌/水洗标 + 无克重缺尺码表（触发缺失规则）
 * 3) 宣传页与实物标签互相冲突（触发冲突规则）
 */

'use strict';

const DEMO_PRODUCTS = [
  {
    id: 'demo-tshirt',
    label: '示例A：纯棉宽松短袖T恤（信息较全）',
    category_hint: 'T恤',
    summary: '演示用：宣传页信息较完整，含克重、支数、尺码表，并带"抗菌"宣称',
    images: [
      {
        id: 'demo-tshirt-promo',
        kind: 'promo_screenshot',
        blocks: [
          { text: '【示例数据】纯棉宽松短袖T恤 男女同款', confidence: 0.92 },
          { text: '价格：¥89.00', confidence: 0.95 },
          { text: '品牌：示例品牌', confidence: 0.9 },
          { text: '面料成分：棉 100%', confidence: 0.93 },
          { text: '克重：190g/m²', confidence: 0.88 },
          { text: '纱支：40S 精梳棉', confidence: 0.86 },
          { text: '执行标准：GB/T 22849-2024', confidence: 0.9 },
          { text: '安全类别：B类', confidence: 0.88 },
          { text: '版型：宽松直筒，落肩设计', confidence: 0.85 },
          { text: '可选尺码：S-XXL', confidence: 0.9 },
          { text: '抗菌面料，久穿不臭', confidence: 0.83 }
        ]
      },
      {
        id: 'demo-tshirt-chart',
        kind: 'size_chart',
        blocks: [
          { text: '尺码表（成衣平铺/围度，单位 cm）', confidence: 0.9 },
          { text: 'S 胸围 104 肩宽 46 衣长 66', confidence: 0.85 },
          { text: 'M 胸围 108 肩宽 47 衣长 68', confidence: 0.85 },
          { text: 'L 胸围 112 肩宽 48 衣长 70', confidence: 0.85 },
          { text: 'XL 胸围 116 肩宽 49 衣长 72', confidence: 0.85 }
        ]
      },
      {
        id: 'demo-tshirt-label',
        kind: 'physical_label',
        blocks: [
          { text: '成分：100%棉', confidence: 0.94 },
          { text: '洗涤：可机洗，水温不超过40℃，不可漂白', confidence: 0.9 }
        ]
      }
    ]
  },
  {
    id: 'demo-coat',
    label: '示例B：羊毛混纺大衣（只有标签、缺尺码表）',
    category_hint: '大衣',
    summary: '演示用：信息只来自吊牌与水洗标，缺克重与尺码表',
    images: [
      {
        id: 'demo-coat-label',
        kind: 'physical_label',
        blocks: [
          { text: '【示例数据】女式羊毛混纺大衣', confidence: 0.9 },
          { text: '面料：羊毛 70% 聚酯纤维 30%', confidence: 0.9 },
          { text: '里料：聚酯纤维 100%', confidence: 0.88 },
          { text: '执行标准：GB/T 2665-2017', confidence: 0.9 },
          { text: '安全类别：B类', confidence: 0.88 },
          { text: '洗涤：仅可干洗，不可水洗，不可漂白', confidence: 0.9 },
          { text: '价格：¥899', confidence: 0.86 }
        ]
      },
      {
        id: 'demo-coat-promo',
        kind: 'promo_screenshot',
        blocks: [
          { text: '2024秋冬新款 双面呢大衣 显瘦收腰', confidence: 0.85 },
          { text: '进口面料 意大利工艺', confidence: 0.8 },
          { text: '版型：修身', confidence: 0.82 },
          { text: '可选尺码：S/M/L', confidence: 0.85 }
        ]
      }
    ]
  },
  {
    id: 'demo-jeans',
    label: '示例C：牛仔直筒裤（宣传页与标签冲突）',
    category_hint: '牛仔裤',
    summary: '演示用：宣传页写 98%棉+2%氨纶，吊牌写 100%棉，用于验证冲突处理',
    images: [
      {
        id: 'demo-jeans-promo',
        kind: 'promo_screenshot',
        blocks: [
          { text: '【示例数据】高腰直筒牛仔裤 显瘦百搭', confidence: 0.9 },
          { text: '价格：¥259', confidence: 0.93 },
          { text: '面料成分：棉 98% 氨纶 2%', confidence: 0.88 },
          { text: '克重：360g/m²', confidence: 0.82 },
          { text: '执行标准：GB/T 22700-2016', confidence: 0.85 },
          { text: '版型：直筒', confidence: 0.84 },
          { text: '可选尺码：25-32', confidence: 0.86 },
          { text: '德国机器 原单品质', confidence: 0.8 }
        ]
      },
      {
        id: 'demo-jeans-label',
        kind: 'physical_label',
        blocks: [
          { text: '成分：棉 100%', confidence: 0.9 },
          { text: '执行标准：GB/T 22700-2016', confidence: 0.88 },
          { text: '安全类别：B类', confidence: 0.87 },
          { text: '洗涤：40℃机洗，反面洗涤，不可漂白', confidence: 0.88 }
        ]
      }
    ]
  }
];

function findDemo(id) {
  return DEMO_PRODUCTS.find((p) => p.id === id) || null;
}

/** 演示用个人资料（仅在用户没填任何数据时用于演示，界面上必须标注"演示资料"） */
const DEMO_PROFILE = {
  height: 175,
  weight: 68,
  bust: 96,
  waist: 78,
  shoulder: 44,
  usual_size: 'M',
  looseness: '宽松',
  scenes: ['日常通勤', '周末出行'],
  warmth: '一般',
  breathability: '偏好透气',
  care: '希望好打理',
  demo: true
};

module.exports = { DEMO_PRODUCTS, DEMO_PROFILE, findDemo };

  };

  function makeRequire(dir) {
    return function (request) {
      var target = request;
      if (request.charAt(0) === '.') {
        var stack = dir.split('/').filter(Boolean);
        var bits = request.split('/');
        for (var i = 0; i < bits.length; i += 1) {
          var b = bits[i];
          if (b === '.' || b === '') continue;
          if (b === '..') stack.pop();
          else stack.push(b);
        }
        target = stack.join('/');
        if (!defs[target] && defs[target + '.js']) target += '.js';
        if (!defs[target] && defs[target + '/index.js']) target += '/index.js';
      }
      if (!defs[target]) throw new Error('模块未打包：' + target + '（来自 ' + dir + '）');
      if (cache[target]) return cache[target].exports;
      var mod = { exports: {} };
      cache[target] = mod;
      defs[target](mod, mod.exports, makeRequire(target.replace(/\/[^/]*$/, '')));
      return mod.exports;
    };
  }

  var req = makeRequire('');
  window.YizhiCore = {
    analyze: req('core/pipeline.js').analyze,
    emptyFields: req('core/pipeline.js').emptyFields,
    extractOnly: req('core/pipeline.js').extractOnly,
    buildReport: req('core/report.js').buildReport,
    fieldItem: req('core/report.js').fieldItem,
    standards: req('core/standards.js'),
    knowledge: req('core/knowledge.js'),
    compare: req('core/compare.js').buildComparison,
    buildManualFields: req('core/manual-fields.js').buildManualFields,
    fields: req('core/fields.js'),
    fit: req('core/fit.js').assessFit,
    buildWearReport: req('core/wear/analyze.js').buildWearReport,
    fabric: req('core/fabric.js'),
    evidence: req('core/evidence.js'),
    normalize: req('core/normalize.js'),
    demos: req('core/data/demo.products.js')
  };
})();
