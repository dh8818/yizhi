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
