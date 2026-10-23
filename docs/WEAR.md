# 长期穿着与老化风险模块（wear）

「穿久了会怎么样？」——分析卡里的第 5 个区块。目标不是讲面料百科，而是回答：
**这件衣服穿一段时间之后，哪些位置最可能先变化、怎么变、为什么、风险多大、买之前怎么规避。**

## 位置

```
miniprogram/core/wear/
├─ features.js   把字段 + OCR 原文 → 设计特征（18 类，带原句证据）
├─ rules.js      规则知识库（26 条数据 + 品类→观察区域映射）
└─ analyze.js    规则匹配 + 风险模型 + 时间轴 + 长期外观 + 区域分布 + 补图建议
```

`core/report.js` 在 `fit` 之后插入 `wear` 区块；`report.wear` 同时挂在顶层，服务端与网页演示直接复用。

## 数据流

```
fields（成分/克重/品类/洗护…）+ rawText（OCR 原文）
        │
        ▼
detectFeatures()            18 类设计特征：罗纹领口、胶印、涂层/仿皮、磨毛、装饰件、
        │                   金属五金、拼接、弹力、垂坠、性能宣称、已存在损伤…
        ▼
rules 匹配（categories / requires_features / any_features / text_regex）
        │
        ▼
风险模型：likelihood × impact → overall；confidence 单独计算
        │
        ├─ 每条风险：18 个字段（见下）
        ├─ 时间轴：5 个定性阶段（初始/使用摩擦/洗护/长期外观/实际反馈）
        ├─ 长期外观：物理耐久性 与 审美搭配 分开
        ├─ 区域分布：按品类给观察区域，未匹配的条目也不丢
        └─ 补图建议：聚合各条 missing_information，说明"为什么需要这张图"
```

## 风险卡片字段（规范 §9，全部必填）

| 字段 | 含义 |
|---|---|
| `item_name` | 风险项目名称 |
| `garment_area` | 具体位置（领口 / 裤裆 / 袖窿…） |
| `observed_feature` | 图里/文中实际观察到的特征（带原句） |
| `identified_material` | 已知材料；没有就写"未提供" |
| `construction_feature` | 已知结构工艺；没有就写"未提供" |
| `possible_failure` | 潜在失效方式（可观察的现象） |
| `mechanism` | 为什么会这样（材料/结构/受力/洗护） |
| `evidence` | 支持判断的证据数组 |
| `missing_information` | 还缺什么才能判断 |
| `likelihood_level` | 可能性：high / medium / low / **unknown** |
| `impact_level` | 影响程度：high / medium / low |
| `overall_risk` | high / medium / low / **insufficient**（证据不足） |
| `confidence_level` | 判断置信：high / medium / low / unknown |
| `mitigation` | 降低风险的洗护/使用方式 |
| `seller_questions` | 购买前可以问商家的问题 |
| `verification_method` | 自己怎么核实 |
| `source_references` | 信息来源 |
| `disclaimer` | 这条判断的边界（含 limitations） |

## 风险模型（明确、可复算）

```
likelihood = high            ← 已存在的损伤迹象（observed_defect）
           = rule.likelihood_when_known  ← 仅当「成分已知 + 结构已知」时
           = unknown         ← 其余情况（证据不足不猜成 low）

overall = insufficient       ← likelihood 或 impact 任一未知
        = matrix[likelihood][impact]   （见 core/wear/analyze.js IMPACT_MATRIX）

confidence = high   ← 已存在损伤，或有明确材料+结构+特征
           = medium ← 有材料 + 结构
           = low    ← 只有特征或只有材料
           = unknown← 基本没有可用信息
```

**没有综合分**：不给 0–100 的伪科学评分，也不把 likelihood 与 impact 强行合并成一个数字。
"证据不足"（insufficient）与"低风险"（low）在类型上就是两回事。

## 规则库（26 条）

| 类别 | 规则 |
|---|---|
| 领口/袖口/弹性部位 | 罗纹领口松弛、领口接缝受力、袖口下摆松弛 |
| 起球/磨损/褪色/缩水/变形 | 针织起球、羊毛腈纶毡化、磨毛压亮、深色褪色、棉/再生纤维素缩水、针织扭曲、长款垂坠 |
| 印花/涂层/装饰/五金 | 印花开裂、弹力面料印花、涂层剥离、刺绣珠片脱落、五金磨损、纽扣扣眼 |
| 品类专属 | 牛仔裤裤裆、裤脚膝盖、外套肩部袖窿、卫衣帽绳、衬衫领口、运动服接缝 |
| 通用 | 弹性衰减、松紧腰、干洗负担、宣称无依据、已存在损伤 |

每条规则都带：适用品类、失效方式、机制、影响程度、所需证据、缓解措施、商家问题、不适用场景、
信息来源、证据等级（general_knowledge / industry_practice / observed_defect）、局限、更新时间。

### 扩展一条规则

只改 `rules.js`，analyze.js 不用动：

```js
{
  id: 'my-rule',
  name: '……',
  categories: ['T恤'],              // 空数组 = 不限
  requires_features: ['rib_collar'], // 必须全部命中
  any_features: ['splice_multi'],    // 至少命中一个
  text_regex: /黑色|深色/,            // 可选：直接匹配原文
  area: '领口',
  failure_modes: ['…'],
  mechanism: '…',
  impact: 'medium',                  // low | medium | high
  likelihood_when_known: 'medium',
  evidence_needed: ['…'], mitigation: ['…'], seller_questions: ['…'],
  verification: '…', not_applicable: '…',
  evidence_level: 'general_knowledge', sources: ['…'], limitations: '…',
  updated_at: '2026-10-23'
}
```

## 合规与边界（写死在代码里）

- 不预测具体使用年限 / 洗涤次数 / 坏损概率；时间轴只给 5 个定性阶段。
- 没有检测数据就不给量化结论；"判断置信" ≠ "发生概率"，界面文字明确写出。
- 已存在的损伤（`observed_defect`）与未来可能的变化分开表述。
- 外观评价中性化：不说"土/廉价/难看"，只说"辨识度高/搭配依赖比例"。
- 图片看不到的内部结构（衬、粘合、拉链内部）一律标"无法判断"。
- 一条规则都没命中时，输出一条明确的"证据不足"，而不是让区块消失或默认低风险。

## 测试

`tests/wear.test.js`（22 个用例）覆盖规范 §13 的 14 个案例 + 结构性断言：

1. 罗纹领口针织 T 恤 2. 大面积胶印卫衣 3. 仿皮涂层夹克 4. 绒面/磨毛 5. 深色牛仔裤
6. 浅色纯棉衬衫 7. 含弹性紧身裤 8. 高装饰（贴布/珠片）9. 金属拉链外套 10. 复杂拼接运动服
11. 只有主图 12. 宣称无检测资料 13. 已存在裂纹/开线 14. 只有成分无结构

另外断言：18 字段齐全；不出现寿命/概率/绝对化表述；不使用审美贬损词；时间轴无具体时长；
区域分布不吞条目；物理耐久与搭配分开；不同商品总结不同；报告区块顺序不变。

```
node --test tests/wear.test.js     # 22 pass
```
