/**
 * 视觉模型适配器（服务端专用）。
 *
 * 只做三件事：构造请求、调用 OpenAI 兼容的视觉接口、校验并返回 OCR 结构。
 * 不做业务判断，也不把模型输出直接当事实 —— 校验失败的输出一律丢弃。
 *
 * 任何密钥都只从服务端环境变量读取，绝不进入小程序包或日志。
 */

'use strict';

const { validateOcrPayload } = require('../schema');

const SYSTEM_PROMPT = [
  '你是服装商品图片的文字识别器，只做 OCR 与版面归属，不做任何推断。',
  '要求：',
  '1) 只输出图片中真实可见的文字；看不清的不要猜，宁可不输出；',
  '2) 不要补全标准号年份、不要补单位、不要改写数字；',
  '3) 按图片类型分配 kind：商品详情页=promo_screenshot，吊牌/水洗标/检测报告=physical_label，尺码表=size_chart，实物细节=detail_photo；',
  '4) 每个文本块给 0~1 的 confidence，表示你对"这段文字抄对了"的把握，不是业务判断；',
  '5) 严格输出 JSON，不要输出解释文字。'
].join('\n');

const USER_PROMPT = [
  '请识别这些图片中的文字，输出如下 JSON 结构：',
  '{"images":[{"id":"img-1","kind":"promo_screenshot","blocks":[{"text":"...","confidence":0.9,"box":[x,y,w,h]}]}]}',
  '注意：商品名称只从商品详情页取；吊牌与水洗标通常是参数行。'
].join('\n');

/**
 * @param {{config: {baseUrl:string, model:string, apiKey:string, timeoutMs:number}, images: Array<{id:string, kind:string, base64:string, mime?:string}>}} input
 * @returns {Promise<{ok:boolean, ocr?:object, error?:object, raw?:string}>}
 */
async function callVision(input) {
  const { config, images } = input || {};
  if (!config || !config.baseUrl || !config.model || !config.apiKey) {
    return { ok: false, error: { code: 'VISION_NOT_CONFIGURED', message: '视觉模型未配置（缺少 baseUrl/model/apiKey）' } };
  }
  if (!Array.isArray(images) || images.length === 0) {
    return { ok: false, error: { code: 'NO_IMAGES', message: '没有可识别的图片' } };
  }

  const content = [{ type: 'text', text: USER_PROMPT }];
  images.forEach((img, i) => {
    const mime = img.mime || 'image/jpeg';
    content.push({
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${img.base64}`, detail: 'high' }
    });
    content.push({ type: 'text', text: `↑ 这张是第 ${i + 1} 张，id=${img.id}，类型=${img.kind || 'promo_screenshot'}` });
  });

  const body = {
    model: config.model,
    temperature: 0,
    max_tokens: 2000,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content }
    ]
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.timeoutMs || 45000);
  let res;
  try {
    res = await fetch(`${String(config.baseUrl).replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    clearTimeout(timer);
    const timeout = String(err && err.name) === 'AbortError';
    return {
      ok: false,
      error: {
        code: timeout ? 'VISION_TIMEOUT' : 'VISION_NETWORK',
        message: timeout ? '视觉模型请求超时' : '无法连接视觉模型服务',
        retryable: true,
        detail: String(err && err.message ? err.message : err).slice(0, 300)
      }
    };
  }
  clearTimeout(timer);

  if (!res.ok) {
    const text = await safeText(res);
    return {
      ok: false,
      error: {
        code: `VISION_HTTP_${res.status}`,
        message: res.status === 401 || res.status === 403 ? '视觉模型鉴权失败（检查密钥）' : `视觉模型返回 HTTP ${res.status}`,
        retryable: res.status >= 500 || res.status === 429,
        detail: text.slice(0, 300)
      }
    };
  }

  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    return { ok: false, error: { code: 'VISION_BAD_JSON', message: '视觉模型返回的不是 JSON' } };
  }

  const text = extractText(payload);
  if (!text) {
    return { ok: false, error: { code: 'VISION_EMPTY', message: '视觉模型没有返回内容' } };
  }

  const parsed = extractJson(text);
  if (!parsed.ok) {
    return { ok: false, error: { code: 'VISION_UNSTRUCTURED', message: '模型输出不符合约定结构', detail: text.slice(0, 300) }, raw: text };
  }

  const validated = validateOcrPayload(parsed.value);
  if (!validated.ok) {
    return {
      ok: false,
      error: { code: 'VISION_SCHEMA', message: '模型输出未通过结构校验', detail: validated.errors.slice(0, 5).map((e) => `${e.path}: ${e.message}`).join('; ') },
      raw: text
    };
  }

  // 用我们自己的图片 id/kind 覆盖模型可能写错的 id
  const ocr = { images: validated.sanitized.images.map((img, i) => ({
    id: images[i] ? images[i].id : img.id,
    kind: images[i] && images[i].kind ? images[i].kind : img.kind,
    blocks: img.blocks
  })) };

  return { ok: true, ocr, raw: text };
}

function extractText(payload) {
  try {
    const choice = payload.choices && payload.choices[0];
    if (!choice) return '';
    if (choice.message && typeof choice.message.content === 'string') return choice.message.content;
    if (Array.isArray(choice.message && choice.message.content)) {
      return choice.message.content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('\n');
    }
    if (typeof choice.text === 'string') return choice.text;
    return '';
  } catch (err) {
    return '';
  }
}

/** 从可能带 ```json 围栏的输出里抓 JSON */
function extractJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(candidate.slice(start, end + 1)) };
  } catch (err) {
    return { ok: false };
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch (err) {
    return '';
  }
}

module.exports = { callVision, extractJson, extractText, SYSTEM_PROMPT };
