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
