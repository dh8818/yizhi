#!/usr/bin/env node
/**
 * 衣知 · 零依赖 API 服务（Node 18+，只用标准库）
 *
 * 职责：
 *   - 接收小程序上传的图片 → 交给视觉适配器或显式声明的模拟 OCR；
 *   - 复用 miniprogram/core/ 的同一套提取/证据/规则/报告代码（两端结果一致）；
 *   - 提供标准查询、知识库、对比、修正字段等接口；
 *   - 把分析结果落盘成 JSON 文件（不是生产级数据库，README 里写清了边界）。
 *
 * 不做什么：
 *   - 不做用户账号与鉴权体系（只有可选的 AppID 白名单 + 限流）；
 *   - 不存图片原始字节（只存图片数量与类型）；
 *   - 不在日志里打印密钥或完整图片内容。
 *
 * 启动：node server/server.js
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ───────────────── 配置 ───────────────── */

function loadDotEnv(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (err) {
    // .env 可选
  }
}

loadDotEnv(path.join(__dirname, '..', '.env'));

const CONFIG = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.resolve(__dirname, '..', process.env.YIZHI_DATA_DIR || './server/data'),
  maxBodyBytes: Number(process.env.YIZHI_MAX_BODY_BYTES || 8 * 1024 * 1024),
  allowedAppIds: String(process.env.YIZHI_ALLOWED_APPIDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // off = 未配置 OCR 时直接报错；demo = 用示例文本替代（结果必须标 demo）
  ocrFallback: String(process.env.YIZHI_OCR_FALLBACK || 'demo').toLowerCase(),
  version: '0.1.0'
};

/* ───────────────── 依赖（复用小程序核心层） ───────────────── */

const CORE = path.join(__dirname, '..', 'miniprogram', 'core');
const pipeline = require(path.join(CORE, 'pipeline'));
const standards = require(path.join(CORE, 'standards'));
const knowledge = require(path.join(CORE, 'knowledge'));
const { buildManualFields } = require(path.join(CORE, 'manual-fields'));
const { applyUserCorrection, mergeFieldSets } = require(path.join(CORE, 'evidence'));
const { buildReport } = require(path.join(CORE, 'report'));
const { buildComparison } = require(path.join(CORE, 'compare'));
const { validateOcrPayload, validateReport } = require(path.join(CORE, 'schema'));
const { findDemo } = require(path.join(CORE, 'data', 'demo.products'));
const providers = require(path.join(CORE, 'ai', 'providers'));

/** OCR 配置：provider 由 YIZHI_OCR_PROVIDER 决定（auto 时按已配置的凭据自动选） */
const OCR = providers.resolveConfig(process.env);

/* ───────────────── 极简 JSON 文件存储 ───────────────── */

const DATA_DIR = CONFIG.dataDir;
const DB_FILE = path.join(DATA_DIR, 'analyses.json');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readDb() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { analyses: {}, comparisons: {} };
  } catch (err) {
    return { analyses: {}, comparisons: {} };
  }
}

function writeDb(db) {
  ensureDataDir();
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

/* ───────────────── 工具 ───────────────── */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function ok(res, data, status) {
  sendJson(res, status || 200, { ok: true, data });
}

function fail(res, status, code, message, detail) {
  sendJson(res, status, { ok: false, error: { code, message, detail: detail || null } });
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > CONFIG.maxBodyBytes) {
        resolve({ ok: false, error: { code: 'BODY_TOO_LARGE', message: `请求体超过 ${Math.round(CONFIG.maxBodyBytes / 1024 / 1024)}MB` } });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({ ok: true, value: {} });
        return;
      }
      try {
        resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch (err) {
        resolve({ ok: false, error: { code: 'BAD_JSON', message: '请求体不是合法 JSON' } });
      }
    });
    req.on('error', () => resolve({ ok: false, error: { code: 'READ_ERROR', message: '读取请求体失败' } }));
  });
}

/** 简单限流：每 IP 每分钟 60 次 */
const RATE = { windowMs: 60000, limit: 60, hits: new Map() };

function rateLimited(ip) {
  const now = Date.now();
  const rec = RATE.hits.get(ip);
  if (!rec || now - rec.start > RATE.windowMs) {
    RATE.hits.set(ip, { start: now, count: 1 });
    return false;
  }
  rec.count += 1;
  return rec.count > RATE.limit;
}

function checkAppId(req) {
  if (!CONFIG.allowedAppIds.length) return true;
  const given = String(req.headers['x-yizhi-appid'] || '').trim();
  return CONFIG.allowedAppIds.indexOf(given) >= 0;
}

function nowIso() {
  return new Date().toISOString();
}

/* ───────────────── 分析流程 ───────────────── */

async function resolveOcr(body) {
  if (body.demo_id) {
    const demo = findDemo(body.demo_id);
    if (!demo) return { ok: false, error: { code: 'DEMO_NOT_FOUND', message: '示例商品不存在' } };
    return { ok: true, ocr: { images: demo.images }, demo: true, demoLabel: `演示数据：${demo.label}` };
  }

  const images = Array.isArray(body.images) ? body.images : [];
  if (!images.length) return { ok: false, error: { code: 'NO_IMAGES', message: '没有上传图片，也没有选择示例商品' } };

  const res = await providers.callOcr({ images, config: OCR });

  if (res.ok) {
    const check = validateOcrPayload(res.ocr);
    if (!check.ok) {
      return {
        ok: false,
        error: {
          code: 'OCR_SCHEMA',
          message: 'OCR 输出未通过结构校验',
          detail: check.errors.slice(0, 5).map((e) => `${e.path}: ${e.message}`).join('; ')
        }
      };
    }
    return { ok: true, ocr: check.sanitized, demo: false, provider: res.provider };
  }

  // 配置了 provider 但失败：按 YIZHI_OCR_FALLBACK 决定报错还是降级（降级必须标 demo）
  if (CONFIG.ocrFallback !== 'demo') {
    return {
      ok: false,
      error: Object.assign({}, res.error, {
        detail: [res.error && res.error.detail, `provider=${res.provider}`, 'YIZHI_OCR_FALLBACK=off，不降级'].filter(Boolean).join(' | ')
      })
    };
  }

  return {
    ok: true,
    ocr: simulateOcr(images),
    demo: true,
    provider: res.provider,
    demoLabel:
      res.provider === 'mock'
        ? '模拟 OCR：服务端未配置 OCR 提供方，已用示例文本代替（不是你的图片内容）'
        : `模拟 OCR：${res.provider} 调用失败（${res.error && res.error.code}），已用示例文本代替（不是你的图片内容）`,
    warn: res.error
  };
}

/**
 * 模拟 OCR：用示例商品的文本块，但尽量保留用户图片的 id 与类型，
 * 让"哪张图产生了哪条证据"的链路仍然可跑通。
 */
function simulateOcr(images) {
  const demo = findDemo('demo-tshirt');
  const blocks = demo.images.reduce((acc, img) => acc.concat(img.blocks), []);
  const perImage = Math.ceil(blocks.length / Math.max(1, images.length));
  return {
    images: images.map((img, i) => ({
      id: img.id || `img-${i + 1}`,
      kind: img.kind || 'promo_screenshot',
      blocks: blocks.slice(i * perImage, (i + 1) * perImage).map((b) => ({ text: b.text, confidence: b.confidence }))
    }))
  };
}

async function createAnalysis(body) {
  const ocrRes = await resolveOcr(body);
  if (!ocrRes.ok) return { ok: false, error: ocrRes.error };

  const manualFields = buildManualFields(body.manual || {});
  const hasManual = Object.keys(manualFields).length > 0;

  const meta = {
    mode: ocrRes.demo ? 'mock' : ocrRes.provider || 'ocr',
    demo: Boolean(ocrRes.demo),
    ocr_provider: ocrRes.provider || 'mock',
    images: (body.images || []).map((img) => ({ id: img.id, kind: img.kind })),
    analysis_id: `srv-${crypto.randomBytes(6).toString('hex')}`,
    created_at: nowIso()
  };

  const result = pipeline.analyze({
    ocr: ocrRes.ocr,
    profile: body.profile || null,
    meta,
    manualFields: hasManual ? manualFields : null
  });

  const report = Object.assign({}, result.report, {
    demo_label: ocrRes.demoLabel || (hasManual ? '手动填写（无 OCR）' : null),
    ocr_warning: ocrRes.warn || null
  });
  if (ocrRes.warn) {
    report.warnings = [`视觉模型调用失败（${ocrRes.warn.code}），本次使用模拟 OCR 数据，结果不能用于真实商品判断。`];
  }

  const check = validateReport(report);
  if (!check.ok) {
    return { ok: false, error: { code: 'REPORT_INVALID', message: '生成的分析卡未通过结构校验', detail: check.errors.map((e) => `${e.path}: ${e.message}`).join('; ') } };
  }

  const db = readDb();
  db.analyses[report.analysis_id] = {
    id: report.analysis_id,
    created_at: report.created_at,
    demo: report.demo,
    mode: report.mode,
    images: meta.images,
    fields: result.fields,
    report
  };
  writeDb(db);
  return { ok: true, data: { id: report.analysis_id, fields: result.fields, report, notes: result.notes } };
}

/* ───────────────── 路由 ───────────────── */

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method || 'GET';
  const ip = req.socket.remoteAddress || 'unknown';

  if (pathname === '/api/health') {
    return ok(res, {
      service: 'yizhi-api',
      version: CONFIG.version,
      mode: OCR.configured ? OCR.provider : CONFIG.ocrFallback === 'demo' ? 'mock' : 'unconfigured',
      ocr_configured: OCR.configured,
      ocr_provider: OCR.provider,
      ocr_fallback: CONFIG.ocrFallback,
      standards: Object.keys(standards.dataset.records || {}).length,
      standards_verified_at: standards.dataset.generated_at,
      time: nowIso()
    });
  }

  // 探活：不消耗配额，只判断 OCR provider 的配置与连通性
  if (pathname === '/api/ocr/probe' && method === 'GET') {
    return ok(res, await providers.probe(process.env));
  }

  if (!checkAppId(req)) {
    return fail(res, 403, 'APPID_DENIED', '该小程序 AppID 不在允许列表中（YIZHI_ALLOWED_APPIDS）');
  }

  if (rateLimited(ip)) {
    return fail(res, 429, 'RATE_LIMITED', '请求过于频繁，请稍后再试');
  }

  if (pathname === '/' && method === 'GET') {
    return ok(res, {
      service: 'yizhi-api',
      endpoints: [
        'GET /api/health',
        'POST /api/analyses',
        'GET /api/analyses/:id',
        'PATCH /api/analyses/:id/fields/:key',
        'DELETE /api/analyses/:id',
        'GET /api/standards?q=',
        'GET /api/standards/:code',
        'GET /api/knowledge?q=',
        'POST /api/comparisons'
      ]
    });
  }

  /* 分析 */
  if (pathname === '/api/analyses' && method === 'POST') {
    const body = await readBody(req);
    if (!body.ok) return fail(res, 400, body.error.code, body.error.message);
    const result = await createAnalysis(body.value || {});
    if (!result.ok) {
      const status = result.error.code === 'NO_IMAGES' ? 400 : result.error.code === 'OCR_NOT_CONFIGURED' ? 503 : 502;
      return fail(res, status, result.error.code, result.error.message, result.error.detail);
    }
    return ok(res, result.data, 201);
  }

  const analysisMatch = pathname.match(/^\/api\/analyses\/([^/]+)$/);
  if (analysisMatch && method === 'GET') {
    const id = decodeURIComponent(analysisMatch[1]);
    const db = readDb();
    const entry = db.analyses[id];
    if (!entry) return fail(res, 404, 'NOT_FOUND', '分析记录不存在或已过期');
    return ok(res, { id: entry.id, fields: entry.fields, report: entry.report });
  }

  if (analysisMatch && method === 'DELETE') {
    const id = decodeURIComponent(analysisMatch[1]);
    const db = readDb();
    if (!db.analyses[id]) return fail(res, 404, 'NOT_FOUND', '分析记录不存在');
    delete db.analyses[id];
    writeDb(db);
    return ok(res, { deleted: id });
  }

  const fieldMatch = pathname.match(/^\/api\/analyses\/([^/]+)\/fields\/([^/]+)$/);
  if (fieldMatch && method === 'PATCH') {
    const id = decodeURIComponent(fieldMatch[1]);
    const key = decodeURIComponent(fieldMatch[2]);
    const body = await readBody(req);
    if (!body.ok) return fail(res, 400, body.error.code, body.error.message);
    const patch = body.value || {};
    if (patch.normalized_value === undefined || String(patch.normalized_value).trim() === '') {
      return fail(res, 400, 'INVALID_PATCH', 'normalized_value 不能为空');
    }
    const db = readDb();
    const entry = db.analyses[id];
    if (!entry) return fail(res, 404, 'NOT_FOUND', '分析记录不存在');

    const updated = applyUserCorrection(entry.fields[key] || { field_key: key }, patch);
    const fields = Object.assign({}, entry.fields, { [key]: updated });
    const report = buildReport({
      fields,
      profile: patch.profile || null,
      rawText: '',
      meta: { mode: entry.mode, demo: entry.demo, images: entry.images, analysis_id: id, created_at: entry.created_at }
    });
    db.analyses[id] = Object.assign({}, entry, { fields, report });
    writeDb(db);
    return ok(res, { id, fields, report });
  }

  /* 标准 */
  if (pathname === '/api/standards' && method === 'GET') {
    const q = url.searchParams.get('q') || '';
    return ok(res, standards.search(q));
  }

  const stdMatch = pathname.match(/^\/api\/standards\/(.+)$/);
  if (stdMatch && method === 'GET') {
    const code = decodeURIComponent(stdMatch[1]);
    return ok(res, standards.detail(code));
  }

  /* 知识库 */
  if (pathname === '/api/knowledge' && method === 'GET') {
    const q = url.searchParams.get('q') || '';
    const entries = q ? knowledge.search(q) : knowledge.allEntries();
    return ok(res, { entries, updated_at: knowledge.UPDATED_AT, disclaimer: knowledge.DISCLAIMER });
  }

  /* 对比 */
  if (pathname === '/api/comparisons' && method === 'POST') {
    const body = await readBody(req);
    if (!body.ok) return fail(res, 400, body.error.code, body.error.message);
    const ids = Array.isArray(body.value && body.value.ids) ? body.value.ids : [];
    if (ids.length < 2) return fail(res, 400, 'NEED_TWO', '至少需要 2 个分析 id');
    const db = readDb();
    const reports = [];
    for (const id of ids) {
      const entry = db.analyses[id];
      if (!entry) return fail(res, 404, 'NOT_FOUND', `分析记录不存在：${id}`);
      reports.push(entry.report);
    }
    const result = buildComparison({ reports, profile: (body.value && body.value.profile) || null });
    if (!result.ok) return fail(res, 400, 'COMPARE_FAILED', result.message);
    db.comparisons[`cmp-${Date.now()}`] = { created_at: nowIso(), ids, suggestion: result.suggestion };
    writeDb(db);
    return ok(res, result);
  }

  return fail(res, 404, 'NOT_FOUND', '接口不存在');
}

/* ───────────────── 启动 ───────────────── */

const server = http.createServer((req, res) => {
  Promise.resolve(handle(req, res)).catch((err) => {
    console.error('[yizhi-api] unhandled', err && err.message ? err.message : err);
    if (!res.headersSent) fail(res, 500, 'INTERNAL', '服务端内部错误');
  });
});

if (require.main === module) {
  ensureDataDir();
  server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`[yizhi-api] v${CONFIG.version} listening on http://${CONFIG.host}:${CONFIG.port}`);
    console.log(`[yizhi-api] data dir: ${DATA_DIR}`);
    console.log(`[yizhi-api] ocr: provider=${OCR.provider} configured=${OCR.configured} · fallback=${CONFIG.ocrFallback}`);
    if (OCR.provider === 'ollama') console.log(`[yizhi-api] ollama: ${OCR.ollama.host} model=${OCR.ollama.model}`);
    if (!CONFIG.allowedAppIds.length) console.log('[yizhi-api] AppID 白名单未开启（仅适合本地开发）');
  });
}

module.exports = { server, handle, CONFIG, createAnalysis, simulateOcr };
