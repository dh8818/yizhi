# API 说明（server/server.js）

零依赖 Node HTTP 服务，默认 `http://127.0.0.1:8787`。
所有响应统一为：

```json
{ "ok": true,  "data": { ... } }
{ "ok": false, "error": { "code": "CODE", "message": "人话解释", "detail": "可选" } }
```

错误码：`BAD_JSON` `BODY_TOO_LARGE` `READ_ERROR` `APPID_DENIED` `RATE_LIMITED`
`NO_IMAGES` `DEMO_NOT_FOUND` `OCR_NOT_CONFIGURED` `OCR_SCHEMA` `REPORT_INVALID`
`INVALID_PATCH` `NOT_FOUND` `NEED_TWO` `COMPARE_FAILED` `INTERNAL`
以及视觉模型链路的 `VISION_NOT_CONFIGURED` `VISION_TIMEOUT` `VISION_NETWORK` `VISION_HTTP_*` `VISION_SCHEMA`。

---

## GET /api/health

```json
{ "ok": true, "data": {
  "service": "yizhi-api", "version": "0.1.0",
  "mode": "mock",                    // 实际使用的 OCR provider；未配置时为 mock/unconfigured
  "ocr_configured": false,
  "ocr_provider": "ollama",          // ollama | openai_compat | baidu_ocr | mock
  "ocr_fallback": "demo",
  "standards": 12,
  "standards_verified_at": "2026-10-23T06:30:17.461Z",
  "time": "2026-10-23T06:48:19.126Z"
} }
```

设置页的"测试连接"调的就是它。

## GET /api/ocr/probe

不消耗配额，只判断 OCR provider 的配置与连通性（Ollama 会检查模型是否已 pull；百度会走一次 OAuth）。

```json
{ "ok": true, "data": {
  "provider": "ollama", "configured": true, "ok": true,
  "detail": "Ollama 就绪，模型 qwen2.5vl:3b（本机已装 2 个）"
} }
```

---

## POST /api/analyses

创建一次分析。

```json
{
  "demo_id": "demo-tshirt",          // 可选：用内置示例（此时忽略 images）
  "images": [                        // 可选：真实图片（base64，不含 data: 前缀）
    { "id": "img-1", "kind": "promo_screenshot", "base64": "..." }
  ],
  "manual": {                        // 可选：手填字段（会标为 user_confirmed）
    "category": "T恤",
    "standard_code": "GB/T 22849-2024",
    "fiber_composition": "棉 100%",
    "fabric_weight": "190g/m²",
    "size_chart": "M 胸围 108 肩宽 47 衣长 68"
  },
  "profile": {                       // 可选：个人数据，仅本次请求使用，不落库
    "bust": 96, "shoulder": 44, "looseness": "宽松", "usual_size": "M"
  }
}
```

`kind` 取值：`promo_screenshot` | `physical_label` | `size_chart` | `detail_photo`（决定证据效力）。

响应 `201`：

```json
{ "ok": true, "data": {
  "id": "srv-8836b05b0dd4",
  "fields": { "category": { "field_key": "category", "status": "extracted", "source_type": "promo_screenshot", "confidence": 0.7, "...": "..." }, "...": "..." },
  "report": { "header": { "product_name": "...", "conclusion": "...", "completeness": { "level": "high", "ratio": 0.85 } },
              "sections": [ ... ], "doubts": [ ... ], "questions": [ ... ],
              "limits": [ ... ], "disclaimer": "...",
              "standard": { "compliance": "not_assessed", "...": "..." },
              "fit": { "status": "heuristic", "recommended_size": "L" },
              "wear": { "available": true, "counts": { "high": 0, "medium": 2, "insufficient": 1 },
                        "items": [ { "id": "rib-collar-relax", "overall_risk": "insufficient", "confidence_level": "low", "...": "..." } ],
                        "timeline": [ ... ], "regions": { ... }, "evidence_gaps": [ ... ] },
              "demo": true, "demo_label": "演示数据：...", "mode": "mock" },
  "notes": [ ... ]
} }
```

状态码：
- `400 NO_IMAGES`：既没有图片也没有示例；
- `503 OCR_NOT_CONFIGURED`：未配置视觉模型且 `YIZHI_OCR_FALLBACK=off`；
- `502 OCR_SCHEMA` / `REPORT_INVALID`：模型输出或报告未通过结构校验（不会被"修好"再返回）。

---

## GET /api/analyses/:id

```json
{ "ok": true, "data": { "id": "srv-...", "fields": { ... }, "report": { ... } } }
```

`404 NOT_FOUND`：记录不存在（进程重启后仍在，因为落盘在 `server/data/analyses.json`）。

## PATCH /api/analyses/:id/fields/:fieldKey

修正一个字段并重算整张卡。

```json
{ "normalized_value": "GB 18401-2010", "note": "吊牌上就是这样写的" }
```

响应返回新的 `fields` 与 `report`。修正后的字段 `status=user_confirmed`、`source_type=user_input`，
原识别值保留在该字段的 `alternatives` 里。`normalized_value` 为空 → `400 INVALID_PATCH`。

## DELETE /api/analyses/:id

```json
{ "ok": true, "data": { "deleted": "srv-..." } }
```

---

## GET /api/standards?q=18401

```json
{ "ok": true, "data": {
  "query": "18401",
  "results": [{ "standard_number": "GB 18401-2010", "name": "国家纺织产品基本安全技术规范",
                "status": "current", "status_label": "现行",
                "verification_status": "official_verified",
                "official_source_url": "https://openstd.samr.gov.cn/...",
                "last_verified_at": "2026-10-23T..." }],
  "hints": [{ "category": "T恤", "standards": ["GB/T 22849-2024", "..."] }]
} }
```

## GET /api/standards/:code

`code` 可带或不带年份（`GB%2018401`、`GB/T%2022849-2024`）。

```json
{ "ok": true, "data": {
  "standard_number": "GB 18401", "found": true, "verified": true,
  "registry_result": "official_verified", "label": "现行",
  "record": { "standard_number": "GB 18401-2010", "name": "...", "name_en": "...",
              "standard_type": "强制性国家标准", "status": "current", "status_label": "现行",
              "publication_date": "2011-01-14", "implementation_date": "2011-08-01",
              "ccs": "W09", "ics": "59.080.01",
              "official_source_url": "...", "last_verified_at": "...",
              "verification_status": "official_verified" },
  "editorial": { "role": "基本安全要求（强制性）", "key_requirement_topics": ["甲醛含量", "..."],
                 "key_requirements_verified": false, "notes": ["..."] },
  "versions": [ { "standard_number": "GB 18401-2003", "status_label": "废止", "...": "..." } ],
  "message": null,
  "dataset": { "generated_at": "...", "source": "openstd.samr.gov.cn", "disclaimer": "..." }
} }
```

注意：`record.scope_summary` 不存在 —— 公开页面不含范围条款，系统不代填。

---

## GET /api/knowledge?q=棉

```json
{ "ok": true, "data": {
  "entries": [{ "id": "cotton", "name": "棉", "kind": "fiber", "plain": "...",
                "pros": ["..."], "cons": ["..."], "factors": ["..."],
                "sources": ["公开纺织材料学与行业科普资料（非标准条文）"],
                "needs_review": true }],
  "updated_at": "2026-10-20",
  "disclaimer": "以下为该纤维/组织的通用特性，不是对这件衣服的实测结论……"
} }
```

---

## POST /api/comparisons

```json
{ "ids": ["srv-a", "srv-b"], "profile": { "looseness": "宽松", "scenes": ["日常通勤"] } }
```

```json
{ "ok": true, "data": {
  "ok": true,
  "items": [{ "id": "srv-a", "name": "...", "category": "...", "demo": true }],
  "rows": [{ "label": "纤维成分（商家标注）", "cells": [[{ "value": "棉 100%", "status": "extracted", "note": "标注内容，非实测" }]] }],
  "suggestion": { "preferences": ["宽松程度：宽松"], "lines": ["...", "没有哪一件可以被称为\"质量最好\"：..."],
                  "next_step": "...", "basis": "..." },
  "disclaimer": "比较表只呈现\"已知信息的差异\"。信息更完整 ≠ 质量更好……"
} }
```

`404 NOT_FOUND`：任一 id 不存在；`400 NEED_TWO`：少于 2 个 id。

---

## 运行与安全

- `YIZHI_ALLOWED_APPIDS` 非空时，请求必须带 `X-Yizhi-AppID` 头，否则 `403 APPID_DENIED`；
- 每 IP 每分钟 60 次，超出 `429 RATE_LIMITED`；
- 请求体上限 `YIZHI_MAX_BODY_BYTES`（默认 8MB），超出 `413`/连接断开并返回 `BODY_TOO_LARGE`；
- 日志只打错误摘要，不打印密钥与图片内容。
