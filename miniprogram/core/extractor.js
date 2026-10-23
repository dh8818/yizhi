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
