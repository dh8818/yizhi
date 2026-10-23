# 架构说明

## 一句话

**一套纯逻辑核心 + 两个外壳**：`miniprogram/core/` 是唯一的事实来源，小程序页面和 Node 服务端都只是它的调用方。
所以"本地演示"和"后端真实识别"给出的是同一种数据结构、同一套规则、同一套措辞。

```
┌────────────────────────── 小程序（miniprogram/） ──────────────────────────┐
│ pages/  9 个页面（index capture result standard knowledge profile          │
│                      compare history settings）                            │
│   ↓ 只做展示与交互                                                        │
│ services/  storage · api · upload · analysis   ← 唯一触碰 wx.* 的地方      │
│   ↓                                                                        │
│ core/  pipeline → extractor → evidence → standards/fabric/knowledge        │
│                    → rules → fit → report → compare                        │
└───────────────────────────────────────────────────────────────────────────┘
                                    ↑ 同一份 require
┌──────────────────── 服务端（server/server.js，Node stdlib） ───────────────┐
│ HTTP 路由 → createAnalysis → core/pipeline → 落盘 JSON                     │
│           → core/ai/vision（OpenAI 兼容视觉接口，密钥只在这里）            │
└───────────────────────────────────────────────────────────────────────────┘
```

## 为什么 core 里没有 wx.*

- 小程序与服务端能共用同一份实现，测试也能直接在 Node 里跑（78 个用例，无需模拟器）；
- 任何 IO（上传、存储、网络、权限）都在 `services/`，因此核心逻辑天然可测、可替换；
- 视觉模型只有"文本块"这一种输入形态，换模型/换 OCR 供应商不影响下游。

## 数据流（一次分析）

```
图片/示例/手填
   │
   ├─ 图片 → [remote] 视觉适配器 → { images: [{id, kind, blocks:[{text, confidence}]}] }
   │        [local ] 不做 OCR → 只能走示例商品或手填
   │
   ├─ 手填 → core/manual-fields.buildManualFields() → status=user_confirmed, source=user_input
   │
   ▼
core/pipeline.analyze()
   ├─ 按图片类型分组（promo / physical_label / size_chart / detail_photo）
   │    每组各跑一次 extractor（这样"同字段不同来源"的冲突才留得住）
   ├─ mergeFieldSets()  → 逐字段合并：用户确认 > 官方查询 > 尺码表 > 宣传页 > 推断
   │    值不一致 → status=conflict + alternatives 保留全部证据
   ├─ standards.associate()   → 标准号是否出现 / 官方是否可查 / 状态 / 适用性 / compliance=not_assessed
   ├─ fabric.assessWeight()   → 只做区间对照（samples=0 时明确说不是评级）
   ├─ fabric.assessYarnCount()→ 只给口径，不评级
   ├─ fit.assessFit()         → 缺尺码表或人体数据就拒绝给尺码
   ├─ rules.computeCompleteness() + rules.buildDoubts()（每条带 reason/basis/action）
   └─ report.buildReport()    → 8 个区块 + 一句话结论（措辞强度随完整度变化）
```

## 字段证据模型（core/fields.js）

| 字段 | 取值 | 说明 |
|---|---|---|
| `field_key` | 固定枚举（16 个） | 与 `FIELD_DEFS` 对齐 |
| `raw_text` | 原文 | 永远保留，供用户复核 |
| `normalized_value` | 结构化值 | 数字/数组/字符串，带 `unit` |
| `status` | extracted / user_confirmed / official_verified / inferred / missing / unreadable / conflict / pending_verification | 证据状态，不是质量评价 |
| `source_type` | promo_screenshot / physical_label / size_chart / detail_photo / user_input / official_lookup / model_inference / not_provided | 证据来源 |
| `source_image_id` | 图片 id | 可回溯到具体哪张图 |
| `confidence` | 0–1 | **模型自评，不是正确概率**（见 `CONFIDENCE_NOTE`） |
| `alternatives` | 数组 | 冲突时的其它来源，或用户修正前的原值 |

来源效力 `SOURCE_RANK`：实物标签 40 > 官方查询 35 > 用户填写 30 > 尺码表 25 > 宣传页 20 > 实物照片 15 > 推断 5。
排序**只用于展示优先级**，不用于"判定真伪"；冲突时不会静默择一。

## 标准模块的三层区分（core/standards.js）

| 层次 | 字段 | 敢说什么 |
|---|---|---|
| 页面出现 | `appears_in_product` | 截图里有没有这串号 |
| 官方可查 | `registry_match` / `official_status` / `official_status_label` / 日期 | 官方平台是否收录、状态是什么（带 `last_verified_at`） |
| 是否适用 | `applicability` = likely / unlikely / unknown | **只依标准名称推导**，正文范围条款未收录 |
| 是否合格 | `compliance` = `not_assessed` | 永远不判断 |

`standards.meta` 与 `standards.verified` 分开存放：
官方抓来的字段在 `standards.verified.js`（脚本生成），人工编辑的"角色/常见管控项目/注意事项"在 `standards.meta.js`，
后者永远带 `key_requirements_verified: false`，界面上要写明"未逐条核对正文"。

## 规则引擎（core/rules.js）

- 完整度：关键字段权重 2、辅助字段 1，输出 `level`（low/medium/high）+ 缺失清单；
- 疑点规则：字段缺失、识别不清、来源冲突、标准（缺失/未核验/废止/未实施/不适用）、成分合计≠100%、
  克重缺失或口径不明、缺尺码表、缺安全类别、缺洗护、检测报告仅"提及"、宣称号（抗菌/零甲醛/绝对化/产地工艺）、标准号缺年份、品类未识别、个人资料不全；
- 去重：具体规则先跑并把涉及字段登记进 `covered`，最后才为"没被覆盖的关键字段"生成通用缺失提示 ——
  所以不会出现"没有尺码表"和"缺少尺码表"两条；
- 措辞：禁止"违规/违法/假货/不合格/造假/欺诈"，测试里有一条专门断言这一点。

## 版型模块（core/fit.js）

状态机：

```
chart_missing     ← 没有尺码表（即使用户数据齐全也不给尺码）
profile_incomplete← 有尺码表但缺胸围或宽松偏好（只解读尺码表，不猜）
heuristic         ← 两者都有：目标胸围 = 人体胸围 + 放量（修身4 / 合体9 / 宽松14 cm）
```

放量是**经验启发式**，不是标准条款；每条建议都带理由（目标值、选中码的成衣胸围、肩宽差、与常穿码的关系），
并固定声明"人体尺寸 ≠ 成衣尺寸"。

## 服务端（server/server.js）

- 零依赖：只用 `http` / `fs` / `crypto` / `path`；
- 存储：`server/data/analyses.json`（原子写：临时文件 + rename），**不存图片字节**，只存图片 id/类型；
- 鉴权：可选 AppID 白名单（`YIZHI_ALLOWED_APPIDS`）+ 每 IP 每分钟 60 次限流；
- 视觉模型：`core/ai/vision.js`，OpenAI 兼容 `/chat/completions`，`temperature=0`，
  输出必须通过 `schema.validateOcrPayload`，失败即丢弃（不猜、不修补）；
- 降级：`YIZHI_OCR_FALLBACK=demo`（默认）时用示例文本块代替 OCR，并在报告里写 `demo: true` + 明确文案；
  设 `off` 则返回 503 `OCR_NOT_CONFIGURED`。

## 扩展点

| 想做的事 | 改哪里 | 不要改哪里 |
|---|---|---|
| 换 OCR / 视觉模型供应商 | `core/ai/vision.js`（只要输出 `{images:[{id,kind,blocks}]}`） | 下游 extractor/report |
| 加一种标准或品类 | `data/standards.meta.js` + `CATEGORY_STANDARD_HINTS` | `standards.js` 的关联逻辑 |
| 加面料知识 | `data/knowledge.data.js`（带 sources / updated_at / needs_review） | knowledge.js |
| 加一条疑点规则 | `rules.js` 的某个规则块 + 登记 `covered` | report.js |
| 加一个字段 | `fields.js` 的 `FIELD_DEFS` + extractor + report 的区块 | 页面上手写字段名 |
| 换存储（数据库） | `server/server.js` 的 readDb/writeDb | core/* |

## 明确不做的事

- 不在小程序端做图像推理（没有本地 OCR，也不该在前端放密钥）；
- 不用大模型做"最终判断"——规则与数据负责结论的强度，模型只负责"把字读出来"；
- 不给商品打品质分、不给准确率数字、不把缺失判为差。
