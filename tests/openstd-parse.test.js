'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { parseList, parseDetail, normalizeStatus } = require('../scripts/lib/openstd-parse');

const LIST_HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'openstd-list-gb18401.html'), 'utf8');
const DETAIL_HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'openstd-detail-gb18401.html'), 'utf8');

test('列表解析：拿到标准号/名称/状态/两个日期', () => {
  const rows = parseList(LIST_HTML);
  const gb2010 = rows.find((r) => r.standard_number === 'GB 18401-2010');
  assert.ok(gb2010, '应能解析出 GB 18401-2010');
  assert.equal(gb2010.name, '国家纺织产品基本安全技术规范');
  assert.equal(gb2010.status, 'current');
  assert.equal(gb2010.status_text, '现行');
  assert.equal(gb2010.publication_date, '2011-01-14');
  assert.equal(gb2010.implementation_date, '2011-08-01');
  assert.ok(gb2010.hash, '应保留详情页 hash 以便追溯');
});

test('列表解析：英文版(EN)行不会覆盖中文行', () => {
  const rows = parseList(LIST_HTML);
  const sameNumber = rows.filter((r) => r.standard_number === 'GB 18401-2010');
  assert.equal(sameNumber.length, 1, '同号应去重为一条');
  assert.equal(sameNumber[0].publication_date, '2011-01-14');
});

test('列表解析：废止版本的状态不被写成现行', () => {
  const rows = parseList(LIST_HTML);
  const old = rows.find((r) => r.standard_number === 'GB 18401-2003');
  assert.ok(old);
  assert.equal(old.status, 'abolished');
  assert.equal(old.status_text, '废止');
});

test('详情解析：字段与日期不串行', () => {
  const d = parseDetail(DETAIL_HTML);
  assert.equal(d.standard_number, 'GB 18401-2010');
  assert.equal(d.name_cn, '国家纺织产品基本安全技术规范');
  assert.equal(d.name_en, 'National general safety technical code for textile products');
  assert.equal(d.status, 'current');
  assert.equal(d.publication_date, '2011-01-14');
  assert.equal(d.implementation_date, '2011-08-01');
  assert.equal(d.ccs, 'W09');
  assert.equal(d.ics, '59.080.01');
  assert.equal(d.competent_department, '工业和信息化部');
  assert.match(d.issuing_body, /国家质量监督检验检疫总局/);
});

test('详情解析：没有正文范围时不编造 scope', () => {
  const d = parseDetail(DETAIL_HTML);
  assert.equal(d.scope_summary, undefined);
});

test('状态归一化：中英文与未知值', () => {
  assert.equal(normalizeStatus('现行'), 'current');
  assert.equal(normalizeStatus('即将实施'), 'upcoming');
  assert.equal(normalizeStatus('已废止'), 'abolished');
  assert.equal(normalizeStatus('（空）'), 'unknown');
});
