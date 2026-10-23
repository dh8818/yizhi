/**
 * OCR 供应商适配层（服务端专用）。
 *
 * 统一的输入/输出契约，换供应商不影响下游：
 *   输入 images = [{ id, kind, base64, mime? }]
 *   输出 ocr    = { images: [{ id, kind, blocks: [{ text, confidence, box? }] }] }
 *
 * 已实现的 provider：
 *   ollama        本机 Ollama 的原生 /api/chat（vision 模型，免费、离线）
 *   openai_compat 任意 OpenAI 兼容的视觉接口（DashScope / 硅基流动 / 智谱 / 豆包 / OpenAI）
 *   baidu_ocr     百度通用文字识别（高精度版，纯 HTTP，不需要 SDK）
 *   mock          明确标注的模拟数据（没有 OCR 能力时的兜底，结果必须标 demo）
 *
 * 所有 provider 都遵守：
 *   - 只做"把字读出来"，不做推断；
 *   - 超时、鉴权失败、限流都返回结构化错误，由调用方决定降级或报错；
 *   - 不把密钥写进日志或响应。
 */

'use strict';

const { validateOcrPayload } = require('../schema');
const { SYSTEM_PROMPT, USER_PROMPT, extractJson, extractText } = require('./vision');

const DEFAULT_TIMEOUT = 45000;

/* ───────────────── 工具 ───────────────── */

function sniffMime(base64) {
  const head = String(base64 || '').slice(0, 8);
  if (head.startsWith('iVBOR')) return 'image/png';
  if (head.startsWith('/9j/')) return 'image/jpeg';
  if (head.startsWith('R0lGOD')) return 'image/gif';
  if (head.startsWith('UklGR')) return 'image/webp';
  if (head.startsWith('Qk')) return 'image/bmp';
  return 'image/jpeg';
}

async function withTimeout(fn, ms, label) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || DEFAULT_TIMEOUT);
  try {
    return await fn(ctrl.signal);
  } catch (err) {
    if (String(err && err.name) === 'AbortError') {
      return { __timeout: true, label: label || 'request' };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function netError(err, label) {
  const timeout = err && err.__timeout;
  return {
    ok: false,
    error: {
      code: timeout ? 'OCR_TIMEOUT' : 'OCR_NETWORK',
      message: timeout ? `${label || 'OCR'} 请求超时` : `无法连接 ${label || 'OCR 服务'}`,
      retryable: true,
      detail: String((err && err.message) || err || '').slice(0, 300)
    }
  };
}

function httpError(status, body, label) {
  let detail = String(body || '').slice(0, 300);
  let message = `${label || 'OCR'} 返回 HTTP ${status}`;
  if (status === 401 || status === 403) message = `${label || 'OCR'} 鉴权失败（检查密钥/令牌）`;
  if (status === 429) message = `${label || 'OCR'} 触发限流，请稍后再试`;
  return { ok: false, error: { code: `OCR_HTTP_${status}`, message, retryable: status >= 500 || status === 429, detail } };
}

/** 把模型返回的 JSON 变成标准 ocr 结构（并按客户端声明修正 id/kind） */
function normalizeModelOcr(parsed, images) {
  const check = validateOcrPayload(parsed);
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
  const ocr = {
    images: check.sanitized.images.map((img, i) => ({
      id: images[i] ? images[i].id : img.id,
      kind: images[i] && images[i].kind ? images[i].kind : img.kind,
      blocks: img.blocks
    }))
  };
  return { ok: true, ocr };
}

/* ───────────────── Ollama（本机视觉模型） ───────────────── */

/**
 * Ollama 的 /api/chat 把 images 挂在一条 message 上，所以逐张请求：
 * 这样"哪张图产生哪些文本块"不会混。
 *
 * 为什么这里要"纯文本"而不是 JSON：
 * 小参数视觉模型（3B 级）很难稳定输出嵌套 JSON，会截断或漏行。
 * OCR 的本质只是"把字抄下来"，所以让模型一行一段地抄，再按行切成 blocks——
 * 结构由我们自己给，模型只负责转录。
 */
async function ocrWithOllama(images, cfg) {
  const out = { images: [] };
  const host = String(cfg.host || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const prompt = [
    '把这张图片里所有可见的文字逐行抄下来。',
    '要求：',
    '1) 保持原样：数字、单位、百分比、标准号、价格都不要改写、不要补全；',
    '2) 一行对应图片里的一行文字，不要合并、不要解释、不要总结；',
    '3) 看不清的字写 ? ，不要猜测；',
    '4) 只输出文字本身。'
  ].join('\n');

  for (const img of images) {
    const res = await withTimeout(
      (signal) =>
        fetch(`${host}/api/chat`, {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: cfg.model,
            stream: false,
            options: { temperature: 0, num_predict: 1024 },
            messages: [
              { role: 'system', content: '你是图片文字识别器，只做 OCR 转录，不做任何推断。' },
              { role: 'user', content: prompt, images: [img.base64] }
            ]
          })
        }),
      cfg.timeoutMs,
      'Ollama'
    ).catch((err) => ({ __err: err }));

    if (res && res.__timeout) return netError(res, 'Ollama');
    if (res && res.__err) return netError(res.__err, 'Ollama');

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 404 && /model/i.test(body)) {
        return {
          ok: false,
          error: {
            code: 'OLLAMA_MODEL_MISSING',
            message: `本机 Ollama 没有模型 ${cfg.model}`,
            detail: `先执行：ollama pull ${cfg.model}`,
            retryable: false
          }
        };
      }
      return httpError(res.status, body, 'Ollama');
    }

    const payload = await res.json().catch(() => null);
    const content = String((payload && payload.message && payload.message.content) || '').trim();
    if (!content) {
      out.images.push({ id: img.id, kind: img.kind, blocks: [] });
      continue;
    }

    // 有些模型仍然会输出 JSON：能解析就按 JSON 归一化，否则按行切
    const maybeJson = extractJson(content);
    if (maybeJson.ok && maybeJson.value && (maybeJson.value.images || maybeJson.value.blocks)) {
      const normalized = normalizeModelOcr(
        maybeJson.value.images ? maybeJson.value : { images: [{ id: img.id, kind: img.kind, blocks: maybeJson.value.blocks }] },
        [img]
      );
      if (normalized.ok) {
        const one = normalized.ocr.images[0] || { blocks: [] };
        out.images.push({ id: img.id, kind: img.kind, blocks: one.blocks || [] });
        continue;
      }
    }

    const blocks = content
      .split(/\r?\n/)
      .map((line) =>
        line
          .replace(/^[\s\-•*·|]+/, '')
          .replace(/^\d+[.)、]\s*/, '')
          .replace(/\s*\|$/, '')
          .trim()
      )
      .filter((line) => line && !/^```/.test(line))
      .map((line) => ({ text: line.slice(0, 500), confidence: null, box: null }));

    out.images.push({ id: img.id, kind: img.kind, blocks });
  }

  if (!out.images.some((i) => i.blocks.length)) {
    return {
      ok: false,
      error: {
        code: 'OCR_EMPTY',
        message: 'Ollama 没有从图片中读到文字',
        detail: '可能是模型不支持中文/图片太小/图片不是截图。可换 qwen2.5vl:7b 或改用云端 OCR。'
      }
    };
  }
  return { ok: true, ocr: out };
}

/* ───────────────── OpenAI 兼容视觉接口 ───────────────── */

async function ocrWithOpenAICompat(images, cfg) {
  const base = String(cfg.baseUrl || '').replace(/\/$/, '');
  if (!base || !cfg.model || !cfg.apiKey) {
    return {
      ok: false,
      error: {
        code: 'OCR_NOT_CONFIGURED',
        message: '视觉接口未配置完整（需要 baseUrl / model / apiKey）',
        retryable: false
      }
    };
  }

  const content = [{ type: 'text', text: USER_PROMPT }];
  images.forEach((img, i) => {
    content.push({ type: 'image_url', image_url: { url: `data:${img.mime || sniffMime(img.base64)};base64,${img.base64}`, detail: 'high' } });
    content.push({ type: 'text', text: `↑ 第 ${i + 1} 张，id=${img.id}，类型=${img.kind}` });
  });

  const res = await withTimeout(
    (signal) =>
      fetch(`${base}/chat/completions`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0,
          max_tokens: 2000,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content }
          ]
        })
      }),
    cfg.timeoutMs,
    '视觉接口'
  ).catch((err) => ({ __err: err }));

  if (res && res.__timeout) return netError(res, '视觉接口');
  if (res && res.__err) return netError(res.__err, '视觉接口');
  if (!res.ok) return httpError(res.status, await res.text().catch(() => ''), '视觉接口');

  const payload = await res.json().catch(() => null);
  const text = extractText(payload);
  if (!text) return { ok: false, error: { code: 'OCR_EMPTY', message: '视觉接口没有返回内容' } };
  const parsed = extractJson(text);
  if (!parsed.ok) {
    return { ok: false, error: { code: 'OCR_UNSTRUCTURED', message: '视觉接口输出不是约定 JSON', detail: text.slice(0, 300) }, raw: text };
  }
  return normalizeModelOcr(parsed.value, images);
}

/* ───────────────── 百度 OCR ───────────────── */

const baiduTokenCache = { token: '', expiresAt: 0, key: '' };

async function baiduAccessToken(cfg) {
  const cacheKey = `${cfg.apiKey}:${cfg.secretKey}`;
  if (baiduTokenCache.token && baiduTokenCache.key === cacheKey && Date.now() < baiduTokenCache.expiresAt) {
    return { ok: true, token: baiduTokenCache.token };
  }
  const url =
    'https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials' +
    `&client_id=${encodeURIComponent(cfg.apiKey)}&client_secret=${encodeURIComponent(cfg.secretKey)}`;

  const res = await withTimeout((signal) => fetch(url, { method: 'POST', signal }), cfg.timeoutMs, '百度 OCR 鉴权').catch((err) => ({ __err: err }));
  if (res && res.__timeout) return netError(res, '百度 OCR 鉴权');
  if (res && res.__err) return netError(res.__err, '百度 OCR 鉴权');
  if (!res.ok) return httpError(res.status, await res.text().catch(() => ''), '百度 OCR 鉴权');

  const data = await res.json().catch(() => null);
  if (!data || !data.access_token) {
    return {
      ok: false,
      error: { code: 'BAIDU_AUTH', message: '百度 OCR 鉴权失败', detail: (data && (data.error_description || data.error)) || '无 access_token' }
    };
  }
  baiduTokenCache.token = data.access_token;
  baiduTokenCache.key = cacheKey;
  baiduTokenCache.expiresAt = Date.now() + Math.max(60, (data.expires_in || 2592000) - 120) * 1000;
  return { ok: true, token: data.access_token };
}

async function ocrWithBaidu(images, cfg) {
  if (!cfg.apiKey || !cfg.secretKey) {
    return {
      ok: false,
      error: { code: 'OCR_NOT_CONFIGURED', message: '百度 OCR 未配置（需要 BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET_KEY）', retryable: false }
    };
  }
  const tokenRes = await baiduAccessToken(cfg);
  if (!tokenRes.ok) return tokenRes;

  const endpoint = cfg.endpoint || 'https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic';
  const out = { images: [] };

  for (const img of images) {
    const body =
      `image=${encodeURIComponent(img.base64)}` +
      '&language_type=CHN_ENG&detect_direction=true&detect_language=true&probability=true';

    const res = await withTimeout(
      (signal) =>
        fetch(`${endpoint}?access_token=${encodeURIComponent(tokenRes.token)}`, {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body
        }),
      cfg.timeoutMs,
      '百度 OCR'
    ).catch((err) => ({ __err: err }));

    if (res && res.__timeout) return netError(res, '百度 OCR');
    if (res && res.__err) return netError(res.__err, '百度 OCR');
    if (!res.ok) return httpError(res.status, await res.text().catch(() => ''), '百度 OCR');

    const data = await res.json().catch(() => null);
    if (!data) return { ok: false, error: { code: 'OCR_BAD_JSON', message: '百度 OCR 返回的不是 JSON' } };
    if (data.error_code) {
      return {
        ok: false,
        error: {
          code: `BAIDU_${data.error_code}`,
          message: `百度 OCR 错误：${data.error_msg || data.error_code}`,
          retryable: data.error_code === 18 || data.error_code === 4,
          detail: null
        }
      };
    }

    const blocks = (data.words_result || [])
      .map((w) => ({
        text: String(w.words || '').trim(),
        confidence: w.probability && typeof w.probability.average === 'number' ? Math.min(1, Math.max(0, w.probability.average)) : null,
        box: w.location ? [w.location.left, w.location.top, w.location.width, w.location.height] : null
      }))
      .filter((b) => b.text);

    out.images.push({ id: img.id, kind: img.kind, blocks });
  }

  if (!out.images.some((i) => i.blocks.length)) {
    return { ok: false, error: { code: 'OCR_EMPTY', message: '百度 OCR 没有识别到文字（图片可能过小或不是截图）' } };
  }
  return { ok: true, ocr: out };
}

/* ───────────────── 配置解析与调度 ───────────────── */

/**
 * 从环境变量解析 provider 配置。
 * @param {object} env
 * @returns {{provider:string, timeoutMs:number, ollama:object, openai:object, baidu:object, configured:boolean}}
 */
function resolveConfig(env) {
  const e = env || {};
  const requested = String(e.YIZHI_OCR_PROVIDER || 'auto').toLowerCase();
  const timeoutMs = Number(e.YIZHI_OCR_TIMEOUT_MS || DEFAULT_TIMEOUT);

  const ollama = {
    host: e.YIZHI_OLLAMA_HOST || 'http://127.0.0.1:11434',
    model: e.YIZHI_OLLAMA_MODEL || 'qwen2.5vl:3b',
    timeoutMs
  };
  const openai = {
    baseUrl: e.YIZHI_VISION_BASE_URL || '',
    model: e.YIZHI_VISION_MODEL || '',
    apiKey: e.YIZHI_VISION_API_KEY || '',
    timeoutMs
  };
  const baidu = {
    apiKey: e.BAIDU_OCR_API_KEY || '',
    secretKey: e.BAIDU_OCR_SECRET_KEY || '',
    endpoint: e.BAIDU_OCR_ENDPOINT || '',
    timeoutMs
  };

  let provider = 'mock';
  if (requested !== 'auto') {
    // 兼容几种写法：openai / openai_compat、baidu / baidu_ocr
    const alias = { openai: 'openai_compat', baidu: 'baidu_ocr', ollama: 'ollama', mock: 'mock' };
    provider = alias[requested] || requested;
  } else if (baidu.apiKey && baidu.secretKey) {
    provider = 'baidu_ocr';
  } else if (openai.baseUrl && openai.model && openai.apiKey) {
    provider = 'openai_compat';
  } else if (ollama.model) {
    provider = 'ollama';
  }

  const configured =
    (provider === 'ollama' && Boolean(ollama.model) && Boolean(e.YIZHI_OLLAMA_HOST || e.YIZHI_OLLAMA_MODEL || requested === 'ollama')) ||
    (provider === 'openai_compat' && Boolean(openai.baseUrl && openai.model && openai.apiKey)) ||
    (provider === 'baidu_ocr' && Boolean(baidu.apiKey && baidu.secretKey));

  return { provider, timeoutMs, ollama, openai, baidu, configured };
}

/**
 * 统一入口。
 * @param {{images: Array<{id:string, kind:string, base64:string, mime?:string}>, config?:object, env?:object}} input
 */
async function callOcr(input) {
  const images = (input && input.images) || [];
  const cfg = (input && input.config) || resolveConfig((input && input.env) || process.env);
  if (!images.length) {
    return { ok: false, provider: cfg.provider, error: { code: 'NO_IMAGES', message: '没有可识别的图片' } };
  }

  let result;
  if (cfg.provider === 'ollama') result = await ocrWithOllama(images, cfg.ollama);
  else if (cfg.provider === 'openai_compat') result = await ocrWithOpenAICompat(images, cfg.openai);
  else if (cfg.provider === 'baidu_ocr') result = await ocrWithBaidu(images, cfg.baidu);
  else {
    return {
      ok: false,
      provider: cfg.provider,
      error: {
        code: 'OCR_NOT_CONFIGURED',
        message: '没有可用的 OCR 提供方',
        detail: '三选一：① 装 Ollama 并 pull 一个视觉模型；② 填 YIZHI_VISION_*（OpenAI 兼容）；③ 填 BAIDU_OCR_*'
      }
    };
  }

  return Object.assign({ provider: cfg.provider }, result);
}

/** 探活：不消耗配额，只判断配置与连通性 */
async function probe(env) {
  const cfg = resolveConfig(env || process.env);
  const out = { provider: cfg.provider, configured: cfg.configured, ok: false, detail: null };

  if (cfg.provider === 'ollama') {
    try {
      const res = await withTimeout((signal) => fetch(`${cfg.ollama.host.replace(/\/$/, '')}/api/tags`, { signal }), 5000, 'Ollama');
      if (res && res.status === 200) {
        const data = await res.json().catch(() => ({}));
        const names = (data.models || []).map((m) => m.name);
        out.ok = names.some((n) => n === cfg.ollama.model || n.startsWith(cfg.ollama.model.split(':')[0]));
        out.detail = out.ok
          ? `Ollama 就绪，模型 ${cfg.ollama.model}（本机已装 ${names.length} 个）`
          : `Ollama 已启动，但没有模型 ${cfg.ollama.model}。执行：ollama pull ${cfg.ollama.model}`;
      } else {
        out.detail = 'Ollama 未响应（是否已启动？）';
      }
    } catch (err) {
      out.detail = `Ollama 连接失败：${String(err && err.message ? err.message : err).slice(0, 120)}`;
    }
    return out;
  }

  if (cfg.provider === 'openai_compat') {
    out.ok = Boolean(cfg.openai.baseUrl && cfg.openai.model && cfg.openai.apiKey);
    out.detail = out.ok ? `视觉接口已配置：${cfg.openai.model}` : '缺少 baseUrl / model / apiKey';
    return out;
  }

  if (cfg.provider === 'baidu_ocr') {
    const token = await baiduAccessToken(cfg.baidu);
    out.ok = Boolean(token.ok);
    out.detail = token.ok ? '百度 OCR 鉴权成功' : token.error.message;
    return out;
  }

  out.detail = '未配置任何 OCR 提供方（当前会降级为模拟 OCR）';
  return out;
}

module.exports = {
  callOcr,
  probe,
  resolveConfig,
  sniffMime,
  ocrWithOllama,
  ocrWithOpenAICompat,
  ocrWithBaidu
};
