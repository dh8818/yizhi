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
  const doubts = buildDoubts({ fields, standard, weight, fit, completeness, rawText });

  const conclusion = buildConclusion({ fields, completeness, standard, doubts, weight, fit });

  const sections = [
    basicSection(fields),
    standardSection(standard),
    fabricSection({ fields, weight, yarn, fabricNotes }),
    fitSection(fit),
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
    evidence: buildEvidence(fields),
    limits: buildLimits({ completeness, standard, weight, fit }),
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

function buildLimits({ completeness, standard, weight, fit }) {
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
  limits.push('本系统没有同类产品样本库，因此不提供"品质评分"或"性价比排名"');
  return limits;
}

module.exports = { buildReport, DISCLAIMER, fieldItem, formatValue };
