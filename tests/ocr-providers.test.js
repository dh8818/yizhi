'use strict';

/**
 * OCR 适配层测试：用本地 stub HTTP 服务模拟三家供应商的真实协议，
 * 走真实 fetch，验证"发什么、怎么解析、失败怎么报"。
 *
 * 覆盖：
 *   · ollama        —— /api/chat，一次一张图，图片挂在 message.images
 *   · openai_compat —— /chat/completions，data URL 多图
 *   · baidu_ocr     —— oauth token + form 提交 base64，解析 words_result
 *   · 配置解析       —— auto 的优先级、显式指定、configured 判定
 *   · 失败路径       —— 超时、鉴权失败、模型不存在、输出不合结构
 */

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const providers = require('../miniprogram/core/ai/providers');

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/* ───────── 通用 stub 服务 ───────── */

function startStub(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        base: `http://127.0.0.1:${port}`,
        // 关服务时必须断开 keep-alive 连接，否则测试进程会挂住
        close: () =>
          new Promise((r) => {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            server.close(r);
          })
      });
    });
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

const VISION_JSON = {
  images: [
    {
      id: 'img-1',
      kind: 'promo_screenshot',
      blocks: [
        { text: '纯棉短袖T恤', confidence: 0.95 },
        { text: '面料成分：棉 100%', confidence: 0.9 },
        { text: '执行标准：GB/T 22849-2024', confidence: 0.9 },
        { text: '克重：190g/m²', confidence: 0.85 }
      ]
    }
  ]
};

/* ───────── Ollama ───────── */

test('ollama：逐张请求，图片以 base64 挂在 message.images 上', async () => {
  const seen = [];
  const stub = await startStub((req, res, body) => {
    seen.push(JSON.parse(body));
    json(res, 200, { message: { content: JSON.stringify(VISION_JSON) } });
  });

  const cfg = providers.resolveConfig({
    YIZHI_OCR_PROVIDER: 'ollama',
    YIZHI_OLLAMA_HOST: stub.base,
    YIZHI_OLLAMA_MODEL: 'qwen2.5vl:3b'
  });
  assert.equal(cfg.provider, 'ollama');
  assert.equal(cfg.configured, true);

  const res = await providers.callOcr({
    images: [
      { id: 'a', kind: 'promo_screenshot', base64: PNG_BASE64 },
      { id: 'b', kind: 'physical_label', base64: PNG_BASE64 }
    ],
    config: cfg
  });

  assert.equal(res.ok, true);
  assert.equal(res.provider, 'ollama');
  assert.equal(seen.length, 2, '两张图应发两次请求');
  assert.equal(seen[0].model, 'qwen2.5vl:3b');
  assert.equal(seen[0].stream, false);
  assert.equal(seen[0].format, 'json');
  assert.ok(Array.isArray(seen[0].messages[1].images));
  assert.equal(seen[0].messages[1].images[0], PNG_BASE64);
  // 第二张的 id 要传给模型，方便对齐
  assert.match(seen[1].messages[1].content, /"b"/);
  // 返回的 id/kind 以客户端声明的为准
  assert.equal(res.ocr.images[1].id, 'b');
  assert.equal(res.ocr.images[1].kind, 'physical_label');
  assert.equal(res.ocr.images[0].blocks.length, 4);

  await stub.close();
});

test('ollama：模型不存在时给出明确的拉取提示', async () => {
  const stub = await startStub((req, res) => json(res, 404, { error: 'model "qwen2.5vl:3b" not found, try pulling it first' }));
  const cfg = providers.resolveConfig({ YIZHI_OCR_PROVIDER: 'ollama', YIZHI_OLLAMA_HOST: stub.base, YIZHI_OLLAMA_MODEL: 'qwen2.5vl:3b' });
  const res = await providers.callOcr({ images: [{ id: 'a', kind: 'promo_screenshot', base64: PNG_BASE64 }], config: cfg });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'OLLAMA_MODEL_MISSING');
  assert.match(res.error.detail, /ollama pull/);
  await stub.close();
});

test('ollama：模型返回非 JSON 时不静默通过', async () => {
  const stub = await startStub((req, res) => json(res, 200, { message: { content: '我看到一件衣服' } }));
  const cfg = providers.resolveConfig({ YIZHI_OCR_PROVIDER: 'ollama', YIZHI_OLLAMA_HOST: stub.base, YIZHI_OLLAMA_MODEL: 'x' });
  const res = await providers.callOcr({ images: [{ id: 'a', kind: 'promo_screenshot', base64: PNG_BASE64 }], config: cfg });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'OCR_UNSTRUCTURED');
  await stub.close();
});

/* ───────── OpenAI 兼容 ───────── */

test('openai_compat：多图 + data URL + 结构校验', async () => {
  let captured = null;
  const stub = await startStub((req, res, body) => {
    captured = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    json(res, 200, { choices: [{ message: { content: '```json\n' + JSON.stringify(VISION_JSON) + '\n```' } }] });
  });

  const cfg = providers.resolveConfig({
    YIZHI_OCR_PROVIDER: 'openai',
    YIZHI_VISION_BASE_URL: stub.base,
    YIZHI_VISION_MODEL: 'qwen-vl-max',
    YIZHI_VISION_API_KEY: 'test-key-not-real'
  });
  assert.equal(cfg.provider, 'openai_compat');

  const res = await providers.callOcr({ images: [{ id: 'x1', kind: 'promo_screenshot', base64: PNG_BASE64 }], config: cfg });

  assert.equal(res.ok, true);
  assert.equal(captured.url, '/chat/completions');
  assert.equal(captured.auth, 'Bearer test-key-not-real');
  assert.equal(captured.body.model, 'qwen-vl-max');
  assert.equal(captured.body.temperature, 0);
  const userMsg = captured.body.messages[1];
  const imagePart = userMsg.content.filter((c) => c.type === 'image_url')[0];
  assert.ok(imagePart, '应包含 image_url 内容块');
  assert.match(imagePart.image_url.url, /^data:image\/png;base64,/);
  assert.equal(res.ocr.images[0].blocks.length, 4);
  await stub.close();
});

test('openai_compat：401 报告为鉴权失败且不可重试', async () => {
  const stub = await startStub((req, res) => json(res, 401, { error: 'invalid api key' }));
  const cfg = providers.resolveConfig({
    YIZHI_OCR_PROVIDER: 'openai',
    YIZHI_VISION_BASE_URL: stub.base,
    YIZHI_VISION_MODEL: 'm',
    YIZHI_VISION_API_KEY: 'bad'
  });
  const res = await providers.callOcr({ images: [{ id: 'a', kind: 'promo_screenshot', base64: PNG_BASE64 }], config: cfg });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'OCR_HTTP_401');
  assert.match(res.error.message, /鉴权失败/);
  await stub.close();
});

test('openai_compat：超时被识别为 OCR_TIMEOUT', async () => {
  let pendingTimer = null;
  const stub = await startStub((req, res) => {
    // 故意不回包，让客户端超时
    pendingTimer = setTimeout(() => { try { json(res, 200, VISION_JSON); } catch (e) { /* noop */ } }, 1500);
    if (pendingTimer.unref) pendingTimer.unref();
  });
  const cfg = providers.resolveConfig({
    YIZHI_OCR_PROVIDER: 'openai',
    YIZHI_VISION_BASE_URL: stub.base,
    YIZHI_VISION_MODEL: 'm',
    YIZHI_VISION_API_KEY: 'k',
    YIZHI_OCR_TIMEOUT_MS: '200'
  });
  const res = await providers.callOcr({ images: [{ id: 'a', kind: 'promo_screenshot', base64: PNG_BASE64 }], config: cfg });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'OCR_TIMEOUT');
  assert.equal(res.error.retryable, true);
  await stub.close();
});

/* ───────── 百度 ───────── */

test('baidu_ocr：先换 token，再表单提交 base64，解析 words_result', async () => {
  let tokenHit = 0;
  let ocrForm = null;
  const stub = await startStub((req, res, body) => {
    if (String(req.url).startsWith('/oauth/2.0/token')) {
      tokenHit += 1;
      assert.match(req.url, /grant_type=client_credentials/);
      assert.match(req.url, /client_id=ak-test/);
      assert.match(req.url, /client_secret=sk-test/);
      return json(res, 200, { access_token: 'token-xyz', expires_in: 2592000 });
    }
    if (String(req.url).startsWith('/rest/2.0/ocr/v1/accurate_basic')) {
      ocrForm = body;
      return json(res, 200, {
        words_result: [
          { words: '面料：棉 95% 氨纶 5%', probability: { average: 0.97 } },
          { words: '执行标准 GB/T 22849-2024' },
          { words: '' }
        ],
        words_result_num: 2
      });
    }
    json(res, 404, { error: 'unexpected' });
  });

  const cfg = providers.resolveConfig({
    YIZHI_OCR_PROVIDER: 'baidu',
    BAIDU_OCR_API_KEY: 'ak-test',
    BAIDU_OCR_SECRET_KEY: 'sk-test',
    BAIDU_OCR_ENDPOINT: `${stub.base}/rest/2.0/ocr/v1/accurate_basic`
  });
  // oauth 域名是写死的，这里临时指向 stub：通过替换 global fetch 的 URL 前缀实现
  const realFetch = global.fetch;
  global.fetch = (url, opts) => {
    const replaced = String(url).replace('https://aip.baidubce.com', stub.base);
    return realFetch(replaced, opts);
  };
  try {
    const res = await providers.callOcr({ images: [{ id: 'b1', kind: 'physical_label', base64: PNG_BASE64 }], config: cfg });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(tokenHit, 1);
    assert.match(ocrForm, /image=/);
    assert.match(ocrForm, /language_type=CHN_ENG/);
    const blocks = res.ocr.images[0].blocks;
    assert.equal(blocks.length, 2, '空行应被丢弃');
    assert.equal(blocks[0].confidence, 0.97);
    assert.match(blocks[1].text, /GB\/T 22849/);
  } finally {
    global.fetch = realFetch;
    await stub.close();
  }
});

test('baidu_ocr：接口错误码原样透出', async () => {
  const stub = await startStub((req, res) => {
    if (String(req.url).startsWith('/oauth/2.0/token')) return json(res, 200, { access_token: 't', expires_in: 3600 });
    return json(res, 200, { error_code: 18, error_msg: 'Open api daily request limit reached' });
  });
  const cfg = providers.resolveConfig({
    YIZHI_OCR_PROVIDER: 'baidu',
    BAIDU_OCR_API_KEY: 'ak',
    BAIDU_OCR_SECRET_KEY: 'sk',
    BAIDU_OCR_ENDPOINT: `${stub.base}/rest/2.0/ocr/v1/accurate_basic`
  });
  const realFetch = global.fetch;
  global.fetch = (url, opts) => realFetch(String(url).replace('https://aip.baidubce.com', stub.base), opts);
  try {
    const res = await providers.callOcr({ images: [{ id: 'a', kind: 'promo_screenshot', base64: PNG_BASE64 }], config: cfg });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'BAIDU_18');
    assert.match(res.error.message, /daily request limit/);
  } finally {
    global.fetch = realFetch;
    await stub.close();
  }
});

/* ───────── 配置解析 ───────── */

test('配置解析：auto 的优先级是 百度 > OpenAI 兼容 > Ollama', () => {
  assert.equal(providers.resolveConfig({}).provider, 'ollama', '默认给出 ollama（本机免费路径）');
  assert.equal(
    providers.resolveConfig({ YIZHI_VISION_BASE_URL: 'u', YIZHI_VISION_MODEL: 'm', YIZHI_VISION_API_KEY: 'k' }).provider,
    'openai_compat'
  );
  assert.equal(
    providers.resolveConfig({
      YIZHI_VISION_BASE_URL: 'u', YIZHI_VISION_MODEL: 'm', YIZHI_VISION_API_KEY: 'k',
      BAIDU_OCR_API_KEY: 'ak', BAIDU_OCR_SECRET_KEY: 'sk'
    }).provider,
    'baidu_ocr'
  );
});

test('配置解析：显式指定优先，未知 provider 不猜', () => {
  const cfg = providers.resolveConfig({ YIZHI_OCR_PROVIDER: 'baidu' });
  assert.equal(cfg.provider, 'baidu_ocr');
  assert.equal(cfg.configured, false, '没填密钥就是未配置');

  const mock = providers.resolveConfig({ YIZHI_OCR_PROVIDER: 'mock' });
  assert.equal(mock.provider, 'mock');
});

test('配置解析：openai 缺任意一项都不算 configured', () => {
  const cfg = providers.resolveConfig({ YIZHI_OCR_PROVIDER: 'openai', YIZHI_VISION_BASE_URL: 'u', YIZHI_VISION_MODEL: 'm' });
  assert.equal(cfg.provider, 'openai_compat');
  assert.equal(cfg.configured, false);
});

test('mock provider 明确返回未配置而不是假装成功', async () => {
  const cfg = providers.resolveConfig({ YIZHI_OCR_PROVIDER: 'mock' });
  const res = await providers.callOcr({ images: [{ id: 'a', kind: 'promo_screenshot', base64: PNG_BASE64 }], config: cfg });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'OCR_NOT_CONFIGURED');
  assert.match(res.error.detail, /Ollama|YIZHI_VISION|BAIDU_OCR/);
});

test('sniffMime 按魔数识别 png/jpeg/webp', () => {
  assert.equal(providers.sniffMime(PNG_BASE64), 'image/png');
  assert.equal(providers.sniffMime('/9j/4AAQSkZJRgABAQ'), 'image/jpeg');
  assert.equal(providers.sniffMime('UklGRhIAAABXRUJQ'), 'image/webp');
  assert.equal(providers.sniffMime('QUJD'), 'image/jpeg');
});
