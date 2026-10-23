/**
 * openstd.samr.gov.cn（国家标准全文公开系统 / 全国标准信息公共服务平台）页面解析。
 *
 * 这里只做 HTML → 结构化，不做网络请求，方便用真实页面快照做测试。
 * 严禁在此处"补全"任何字段：页面上没有的，就返回 null 并记 missing。
 */

'use strict';

const STATUS_MAP = [
  [/现行/, 'current'],
  [/即将实施|尚未实施|未实施/, 'upcoming'],
  [/废止|作废/, 'abolished'],
  [/被代替|已被代替|代替中/, 'superseded'],
  [/修订/, 'under_revision']
];

function normalizeStatus(text) {
  const t = String(text || '');
  for (const [re, value] of STATUS_MAP) {
    if (re.test(t)) return value;
  }
  return 'unknown';
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '|')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&times;/g, '×')
    .replace(/\|+/g, '|');
}

function textOf(cell) {
  return String(cell || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析搜索结果页的标准列表。
 * 每行形如：序号 | 标准号(a onclick=showInfo('HASH')) | 语种 | 是否采标 | 标准名称 | 类别 | 状态 | 发布日期 | 实施日期 | 操作
 *
 * 过滤规则（真实页面里同一标准会有中文行 + 英文版(EN)行，英文行列少且会错位）：
 * - 第一格必须是序号，"EN" 语种行一律跳过；
 * - 同号多条时保留字段最全的那条。
 * @returns {Array<{standard_number:string, hash:string|null, name:string|null, standard_type:string|null, status:string, status_text:string, publication_date:string|null, implementation_date:string|null}>}
 */
function parseList(html) {
  const rows = String(html || '').match(/<tr[\s\S]*?<\/tr>/g) || [];
  const out = [];
  for (const row of rows) {
    if (/<th[\s>]/i.test(row)) continue;
    const hashMatch = row.match(/showInfo\('([0-9A-Fa-f]{8,})'\)/);
    const cells = (row.match(/<td[\s\S]*?<\/td>/g) || []).map(textOf);
    if (cells.length < 6) continue;
    if (!/^\d+$/.test(cells[0])) continue; // 序号列，排除嵌套/碎片行
    if (cells.includes('EN')) continue; // 英文版行，列结构不同
    const numberCell = cells.find((c) => /^(GB\/T|GB\/Z|GB|FZ\/T|FZ|QB\/T|HG\/T|SN\/T)\s*\d/i.test(c));
    if (!numberCell) continue;

    const idx = cells.indexOf(numberCell);
    const name = cells
      .slice(idx + 1)
      .find((c) => c && !/^(强标|推标|指导性|现行|废止|即将实施|尚未实施|被代替)$/.test(c) && !/^\d{4}-\d{2}-\d{2}/.test(c) && c.length > 1);
    const statusText = cells.find((c) => /^(现行|废止|即将实施|尚未实施|被代替)/.test(c)) || '';
    const dates = cells.filter((c) => /^\d{4}-\d{2}-\d{2}/.test(c));
    out.push({
      standard_number: numberCell,
      hash: hashMatch ? hashMatch[1] : null,
      name: name || null,
      standard_type: cells.includes('强标') ? '强制性国家标准' : cells.includes('推标') ? '推荐性国家标准' : null,
      status: normalizeStatus(statusText),
      status_text: statusText || null,
      publication_date: dates[0] ? dates[0].slice(0, 10) : null,
      implementation_date: dates[1] ? dates[1].slice(0, 10) : null
    });
  }

  // 同号去重：保留日期信息最全的一条（中文行）
  const byNumber = new Map();
  for (const row of out) {
    const prev = byNumber.get(row.standard_number);
    if (!prev) {
      byNumber.set(row.standard_number, row);
      continue;
    }
    const score = (r) => (r.publication_date ? 1 : 0) + (r.implementation_date ? 1 : 0) + (r.name ? 1 : 0);
    if (score(row) > score(prev)) byNumber.set(row.standard_number, row);
  }
  return Array.from(byNumber.values());
}

/**
 * 从详情页取基础字段。取不到的一律 null。
 *
 * 页面结构（去标签后）是 "标签 | 值 | 标签 | 值"，但标签和值有时在同一段
 * （"标准号：GB 18401-2010"），所以按 token 走，不用跨段正则。
 */
function parseDetail(html) {
  const flat = stripTags(html);
  const tokens = flat
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);

  const splitInline = (token, label) => {
    const idx = token.indexOf(label);
    if (idx < 0) return null;
    const rest = token.slice(idx + label.length).replace(/^[\s:：]+/, '').trim();
    return rest || null;
  };

  const valueAfter = (labels) => {
    const list = Array.isArray(labels) ? labels : [labels];
    for (const label of list) {
      for (let i = 0; i < tokens.length; i += 1) {
        if (tokens[i].indexOf(label) < 0) continue;
        const inline = splitInline(tokens[i], label);
        if (inline) return inline;
        const next = tokens[i + 1];
        if (next && next.indexOf(label) < 0 && !/^[（(]/.test(next)) return next;
      }
    }
    return null;
  };

  const dateOf = (s) => {
    const m = String(s || '').match(/(\d{4})\s*-\s*(\d{2})\s*-\s*(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  };

  const statusText = valueAfter(['标准状态']);
  return {
    standard_number: valueAfter(['标准号']),
    name_cn: valueAfter(['中文标准名称']),
    name_en: valueAfter(['英文标准名称']),
    status: normalizeStatus(statusText),
    status_text: statusText,
    publication_date: dateOf(valueAfter(['发布日期'])),
    implementation_date: dateOf(valueAfter(['实施日期'])),
    ccs: valueAfter(['中国标准分类号（CCS）', '中国标准分类号(CCS)', '中国标准分类号']),
    ics: valueAfter(['国际标准分类号（ICS）', '国际标准分类号(ICS)', '国际标准分类号']),
    competent_department: valueAfter(['主管部门']),
    technical_committee: valueAfter(['归口部门', '归口单位']),
    issuing_body: valueAfter(['发布单位']),
    remarks: (() => {
      const r = valueAfter(['备注']);
      return r && !/^[×xX]$/.test(r) ? r : null;
    })(),
    has_online_preview: /在线预览/.test(flat)
  };
}

module.exports = { parseList, parseDetail, normalizeStatus, textOf, stripTags };
