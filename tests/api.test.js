'use strict';

/**
 * API 端到端测试：真的起一个 HTTP 服务，真的发请求。
 * 数据目录指向系统临时目录，不污染仓库里的 server/data。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yizhi-api-'));
process.env.YIZHI_DATA_DIR = dataDir;
process.env.YIZHI_OCR_FALLBACK = 'demo';
delete process.env.YIZHI_VISION_API_KEY;

const { server } = require('../server/server');

let base = '';
let analysisId = '';
let secondId = '';

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${addr.port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(pathname, options) {
  const res = await fetch(base + pathname, options);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

function post(pathname, payload) {
  return call(pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
}

test('健康检查报告服务端能力', async () => {
  const r = await call('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.service, 'yizhi-api');
  assert.equal(r.body.data.vision_configured, false);
  assert.ok(r.body.data.standards > 5);
  assert.ok(r.body.data.standards_verified_at);
});

test('用示例商品创建分析：返回完整报告并标记 demo', async () => {
  const r = await post('/api/analyses', { demo_id: 'demo-tshirt', profile: { bust: 96, looseness: '宽松' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.ok, true);
  const { id, report, fields } = r.body.data;
  analysisId = id;
  assert.ok(id.startsWith('srv-'));
  assert.equal(report.demo, true);
  assert.ok(report.demo_label.includes('演示数据'));
  assert.equal(report.standard.compliance, 'not_assessed');
  assert.equal(report.fit.status, 'heuristic');
  assert.equal(fields.standard_code.normalized_value, 'GB/T 22849-2024');
});

test('第二次创建用于对比', async () => {
  const r = await post('/api/analyses', { demo_id: 'demo-coat' });
  assert.equal(r.status, 201);
  secondId = r.body.data.id;
  assert.ok(secondId);
});

test('按 id 取回分析记录', async () => {
  const r = await call(`/api/analyses/${analysisId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.report.analysis_id, analysisId);
  assert.ok(r.body.data.fields);
});

test('修正字段后重算报告，并保留原始识别值', async () => {
  const r = await call(`/api/analyses/${analysisId}/fields/standard_code`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ normalized_value: 'GB 18401-2010' })
  });
  assert.equal(r.status, 200);
  const { fields, report } = r.body.data;
  assert.equal(fields.standard_code.status, 'user_confirmed');
  assert.equal(fields.standard_code.source_type, 'user_input');
  assert.equal(report.standard.normalized_code, 'GB 18401-2010');
  assert.equal(report.standard.official_status_label, '现行');
  assert.ok(fields.standard_code.alternatives.length >= 1);
});

test('空字段修正会被拒绝', async () => {
  const r = await call(`/api/analyses/${analysisId}/fields/standard_code`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ normalized_value: '   ' })
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'INVALID_PATCH');
});

test('没有图片也没有示例时拒绝分析', async () => {
  const r = await post('/api/analyses', {});
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'NO_IMAGES');
});

test('上传图片但未配置视觉模型：模拟 OCR 且明确标注', async () => {
  const r = await post('/api/analyses', {
    images: [{ id: 'img-1', kind: 'promo_screenshot', base64: 'ZmFrZQ==' }]
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.report.demo, true);
  assert.match(r.body.data.report.demo_label, /模拟 OCR/);
});

test('非法 JSON 请求体返回 400', async () => {
  const r = await call('/api/analyses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"images": [}'
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'BAD_JSON');
});

test('标准查询与详情', async () => {
  const list = await call('/api/standards?q=18401');
  assert.equal(list.status, 200);
  assert.ok(list.body.data.results.length >= 1);

  const detail = await call('/api/standards/GB%2018401');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.found, true);
  assert.equal(detail.body.data.record.status_label, '现行');
});

test('知识库可搜索', async () => {
  const r = await call('/api/knowledge?q=' + encodeURIComponent('棉'));
  assert.equal(r.status, 200);
  assert.ok(r.body.data.entries.length >= 1);
  assert.ok(r.body.data.disclaimer);
});

test('对比接口返回带偏好的建议', async () => {
  const r = await post('/api/comparisons', { ids: [analysisId, secondId], profile: { looseness: '宽松', bust: 96 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.ok, true);
  assert.equal(r.body.data.items.length, 2);
  assert.ok(r.body.data.suggestion.lines.length > 0);
});

test('对比 id 不存在时 404', async () => {
  const r = await post('/api/comparisons', { ids: [analysisId, 'nope'] });
  assert.equal(r.status, 404);
});

test('删除分析记录', async () => {
  const r = await call(`/api/analyses/${secondId}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  const again = await call(`/api/analyses/${secondId}`);
  assert.equal(again.status, 404);
});

test('未知路由 404，且错误结构统一', async () => {
  const r = await call('/api/unknown');
  assert.equal(r.status, 404);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.error.code, 'NOT_FOUND');
});
