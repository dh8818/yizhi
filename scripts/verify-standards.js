#!/usr/bin/env node
/**
 * 真实核验标准状态：访问 openstd.samr.gov.cn，把匹配到的条目写进
 * miniprogram/core/data/standards.verified.js。
 *
 * 行为边界（按产品规范 6.1）：
 * - 只有真的抓到官方页面并解析出字段，才写 verification_status = 'official_verified'；
 * - 抓不到 / 解析不到 → 写 'pending_verification' 并留 note，绝不臆测"现行"；
 * - 每条记录都带 official_source_url 与 last_verified_at。
 *
 * 用法：
 *   node scripts/verify-standards.js              # 核验内置清单
 *   node scripts/verify-standards.js GB/T 22849  # 核验指定标准（可多个）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parseList, parseDetail } = require('./lib/openstd-parse');

const BASE = 'https://openstd.samr.gov.cn';
const SEARCH = (q) => `${BASE}/bzgk/gb/std_list?p.p1=0&p.p90=circulation_date&p.p91=desc&p.p2=${encodeURIComponent(q)}`;
const DETAIL = (hash) => `${BASE}/bzgk/gb/showGb?type=online&hcno=${hash}`;

/** 待核验清单：只放标准号，其它字段一律以官方页面为准。 */
const TARGETS = [
  'GB 18401',
  'GB 31701',
  'GB/T 5296.4',
  'GB/T 29862',
  'GB/T 22849',
  'GB/T 2660',
  'GB/T 2664',
  'GB/T 2665',
  'GB/T 14272',
  'GB/T 22700',
  'FZ/T 73020',
  'FZ/T 81007'
];

const OUT_FILE = path.join(__dirname, '..', 'miniprogram', 'core', 'data', 'standards.verified.js');

async function fetchText(url, { timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function deriveStandardType(number) {
  const n = String(number || '').toUpperCase();
  if (/^GB\/Z/.test(n)) return '指导性技术文件';
  if (/^GB\/T/.test(n)) return '推荐性国家标准';
  if (/^GB\s*\d/.test(n)) return '强制性国家标准';
  if (/^(FZ|QB|HG|SN)\/T/.test(n)) return '行业标准（推荐性）';
  if (/^(FZ|QB|HG|SN)\s*\d/.test(n)) return '行业标准（强制性）';
  if (/^ISO|^EN|^AATCC|^JIS/.test(n)) return '国际/国外标准';
  return null;
}

/** 精确匹配：同前缀 + 同号，年份取最新的现行版本 */
function pickBest(rows, target) {
  const norm = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const t = norm(target);
  const same = rows.filter((r) => {
    const n = norm(r.standard_number);
    return n === t || n.startsWith(`${t}-`);
  });
  if (!same.length) return null;
  const rank = (r) => (r.status === 'current' ? 0 : r.status === 'upcoming' ? 1 : 2);
  same.sort((a, b) => rank(a) - rank(b) || String(b.publication_date || '').localeCompare(String(a.publication_date || '')));
  return same[0];
}

async function verifyOne(target) {
  const isIndustry = /^(FZ|QB|HG|SN)/i.test(String(target).trim());
  const listHtml = await fetchText(SEARCH(target));
  const rows = parseList(listHtml);
  const best = pickBest(rows, target);
  if (!best) {
    return {
      standard_number: target,
      verification_status: 'pending_verification',
      note: isIndustry
        ? '行业标准（FZ/QB 等）不在"国家标准全文公开系统"范围内，需到行业标准信息服务平台 hbba.sacinfo.org.cn 或发布部门官网核验；本次未获取到官方数据'
        : '官方检索结果中未找到匹配条目，需人工在 openstd.samr.gov.cn 复核',
      official_source_url: isIndustry ? 'https://hbba.sacinfo.org.cn/' : SEARCH(target),
      search_url: SEARCH(target),
      last_verified_at: new Date().toISOString()
    };
  }
  let detail = {};
  if (best.hash) {
    try {
      detail = parseDetail(await fetchText(DETAIL(best.hash)));
    } catch (err) {
      detail = { detail_error: String(err.message || err) };
    }
  }
  const number = String(detail.standard_number || best.standard_number || target).replace(/^[\s:：]+/, '').trim();
  return {
    standard_number: number,
    name: detail.name_cn || best.name || null,
    name_en: detail.name_en || null,
    standard_type: deriveStandardType(number) || best.standard_type || null,
    status: detail.status && detail.status !== 'unknown' ? detail.status : best.status,
    status_text: detail.status_text || best.status_text,
    publication_date: detail.publication_date || best.publication_date,
    implementation_date: detail.implementation_date || best.implementation_date,
    ccs: detail.ccs || null,
    ics: detail.ics || null,
    competent_department: detail.competent_department || null,
    issuing_body: detail.issuing_body || null,
    remarks: detail.remarks || null,
    official_source_url: DETAIL(best.hash || ''),
    search_url: SEARCH(target),
    scope_summary: null,
    scope_note: '公开页面不提供标准正文范围条款，需在官方"在线预览"中查阅原文后人工补录',
    verification_status: 'official_verified',
    last_verified_at: new Date().toISOString(),
    source_excerpt: null
  };
}

async function main() {
  const args = process.argv.slice(2);
  const targets = args.length ? args : TARGETS;
  const records = {};
  const failures = [];

  for (const target of targets) {
    process.stdout.write(`→ ${target} ... `);
    try {
      const rec = await verifyOne(target);
      records[rec.standard_number] = rec;
      process.stdout.write(`${rec.verification_status} ${rec.status || ''} ${rec.name || ''}\n`);
    } catch (err) {
      failures.push({ target, error: String(err.message || err) });
      process.stdout.write(`失败：${err.message}\n`);
      records[target] = {
        standard_number: target,
        verification_status: 'pending_verification',
        note: `网络请求失败（${err.message}），未获取官方数据`,
        official_source_url: SEARCH(target),
        last_verified_at: new Date().toISOString()
      };
    }
  }

  const payload = {
    generated_at: new Date().toISOString(),
    source: '国家标准全文公开系统/全国标准信息公共服务平台 (openstd.samr.gov.cn)',
    disclaimer:
      '本文件由脚本实时抓取官方公开页面生成，只记录页面上可见的字段。标准正文范围条款与全文内容不在公开页面上，需人工查阅。状态可能随官方更新变化，展示时必须带上 last_verified_at。',
    records
  };

  const banner = `/**
 * 自动生成，请勿手工编辑：node scripts/verify-standards.js
 * 生成时间：${payload.generated_at}
 * 数据来源：${payload.source}
 */

'use strict';

module.exports = ${JSON.stringify(payload, null, 2)};
`;
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, banner, 'utf8');
  console.log(`\n写入 ${OUT_FILE}（${Object.keys(records).length} 条，失败 ${failures.length} 条）`);
  if (failures.length) console.log(JSON.stringify(failures, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { verifyOne, pickBest, TARGETS };
