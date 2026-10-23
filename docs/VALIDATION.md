# 验收报告

> 生成时间：2026-10-23（本机时区 UTC+08:00）
> 环境：Windows 11 · Node v22.16.0 · npm 10.9.2 · Python 3.14.7 · 微信开发者工具已安装（D:\微信web开发者工具）但**服务端口未开启**

本报告只写**实际执行过的**结果。没有跑过的，会明确标成"未验证"。

## 一、阶段 0 审计结论

| 项目 | 结论 |
|---|---|
| 工作区 | `D:\Hermes\hermes-agent` 是 Hermes 自身仓库，与「衣知」无关 → **未在其中创建任何文件** |
| 已有小程序项目 | 未发现（全盘常见目录抽查）→ 新建项目 `D:\Projects\yizhi` |
| 技术栈选择 | 原生微信小程序（WXML/WXSS/JS）+ 纯 CommonJS 核心层 + 零依赖 Node 服务 |
| 可用工具 | node 22.16、npm 10.9.2、git 2.49、curl/fetch |
| 缺失工具 | **微信开发者工具未安装**（仅有 QQ / 腾讯会议）→ 无法编译预览、无法真机调试 |
| 网络 | `registry.npmjs.org` 200；`openstd.samr.gov.cn` 200（可真实核验标准）；`github.com` 不通 |
| 选型理由 | 无需构建链，可直接导入开发者工具；核心逻辑用 CommonJS 让 Node 与小程序共用，测试可在无模拟器的情况下真实执行 |

## 二、已实现（有代码路径）

| 模块 | 文件 | 说明 |
|---|---|---|
| 首页 | `pages/index` | 上传入口、示例入口、最近记录、对比/知识/标准/身材入口、隐私边界说明 |
| 上传与确认 | `pages/capture` | 相册/拍照、多图、来源类型选择、删除、演示商品、手填 9 个字段、进度与错误提示 |
| 分析卡 | `pages/result` | 结论、完整度、基本信息、标准解读、面料参考、版型尺码、疑点、洗护、待确认问题、证据清单、边界说明；支持字段修正、收藏、加入对比、复制结论/问题 |
| 标准查询 | `pages/standard` | 搜索、详情、版本记录、官方链接复制、核验口径 |
| 面料知识 | `pages/knowledge` | 13 条纤维 + 5 条织物组织 + 11 条洗护符号，可搜索、可展开 |
| 身材与偏好 | `pages/profile` | 6 项尺寸 + 常穿码 + 4 项偏好 + 场景多选，范围校验，可删除 |
| 商品对比 | `pages/compare` | 2–3 件，12 个维度，结论挂偏好 |
| 历史与收藏 | `pages/history` | 搜索、筛选、收藏、单条删除、清空、本地占用 |
| 设置 | `pages/settings` | 模式切换、后端地址、连接测试、数据删除、隐私说明、模型边界、反馈、版本 |
| 核心层 | `miniprogram/core/*`（23 个模块） | 字段证据模型、规范化、提取、证据合并、标准、知识、面料、规则、版型、报告、对比、结构校验、OCR 适配、老化风险 |
| OCR 适配层 | `miniprogram/core/ai/providers.js` | ollama / openai 兼容 / 百度 OCR 三家 + `/api/ocr/probe` 探活 + `scripts/test-ocr.js` 单图调试 |
| 老化风险 | `miniprogram/core/wear/*` | 18 类设计特征、26 条规则、likelihood×impact×confidence 模型、时间轴、区域分布、补图建议 |
| 服务端 | `server/server.js` | 9 个接口、限流、AppID 白名单、请求体上限、JSON 落盘、模拟 OCR 显式标注 |
| 标准核验脚本 | `scripts/verify-standards.js` | 真实抓取 openstd 检索+详情页，12 条中 10 条 `official_verified` |
| 工程自检 | `scripts/self-check.js` | 页面四件套、组件路径、模块加载、数据集完整性、密钥扫描、`wx.request` 位置约束 |
| 字段评测 | `scripts/eval-fields.js` | 逐字段命中统计（样例 n=3） |

## 三、已测试并通过（真实执行）

```
$ npm test
# tests 120
# pass 120
# fail 0
```

| 测试文件 | 覆盖点 |
|---|---|
| `tests/normalize.test.js` (15) | 标准号（全角/缺年份/非法）、成分（单段/多段/合计≠100/百分比前置）、克重（g/m² vs 单件 vs 无单位）、支数体系、价格促销口径、尺码表行列 |
| `tests/extractor.test.js` (8) | 完整宣传页提取、不编造缺失字段、吊牌不冒充商品名、来源标记（吊牌 > 宣传页）、跨图冲突保留、空 OCR、非服装文本、手填优先 |
| `tests/standards.test.js` (9) | 真实核验字段、未收录年份版本、不存在的号、行业标准去向、关联判断（匹配/不匹配/无号）、`compliance=not_assessed`、详情不代填范围、搜索 |
| `tests/rules.test.js` (15) | 完整度分级、疑点去重、严重度排序、每条必须有依据与下一步、**禁止指控性措辞**、宣称规则、克重三态、跨品类不评级、参考区间带样本数与更新时间、支数不评级、版型三种状态 |
| `tests/report.test.js` (10) | 结构校验、区块顺序、无"符合"结论、演示标记、结论措辞随完整度变化、价格来源约束、对比（<2 件拒绝、>3 件截断、偏好绑定、缺失不当差评） |
| `tests/openstd-parse.test.js` (6) | 真实页面快照：列表解析、EN 行不覆盖中文行、废止状态、详情字段不串行、不编造 scope、状态归一化 |
| `tests/api.test.js` (15) | 真实 HTTP：健康检查、创建分析、取回、字段修正（保留原值）、空值拒绝、无输入拒绝、模拟 OCR 标注、坏 JSON、标准/知识库/对比、删除、404 结构 |
| `tests/ocr-providers.test.js` (13) | 真实 HTTP stub：ollama 逐张请求、openai 兼容多图 data URL、百度 token+form+words_result、401/超时/模型不存在/错误码、auto 优先级、mock 不假装成功 |
| `tests/wear.test.js` (22) | 规范 §13 的 14 个案例（罗纹领口/胶印/仿皮/绒面/深色牛仔/浅色衬衫/紧身裤/珠片/五金/拼接/只有主图/宣称无资料/已存在损伤/只有成分）+ 18 字段完整性 + 禁寿命概率 + 区域不吞条目 + 总结不重复 |
| `tests/services.test.js` (7) | 用最小 `wx` mock 跑通页面真实调用：无输入时拒绝、示例跑通并写历史、纯手填出卡、字段修正保留原值、删除/清空真的生效、设置不含密钥 |

```
$ npm run check
— 工程自检 —
  ✓ 页面 9 个，四件套检查完成
  ✓ usingComponents 路径检查完成
  ✓ core 模块 19 个可加载
  ✓ 标准数据集 12 条（已核验 10 条）
  ✓ 小程序包密钥扫描完成
  ✓ wx.request 位置约束检查完成
全部通过。
```

```
$ node scripts/eval-fields.js
  category           3/3
  standard_code      3/3
  fabric_weight      3/3
  price              3/3
  size_chart_rows    3/3
  safety_category    3/3
  care_present       3/3
总计 21/21（样例 n=3，均为模拟 OCR 文本，不代表真实截图准确率）
```

OCR 适配层（13 个用例，真实 HTTP stub，不是 mock 模块）：

```
ollama        → 逐张请求、message.images 带 base64、模型缺失给出 ollama pull 提示、非 JSON 被拒
openai_compat → /chat/completions、data URL、Bearer 鉴权、401 提示、超时识别为 OCR_TIMEOUT
baidu_ocr     → oauth 换 token、表单提交、words_result 解析、空行丢弃、error_code 原样透出
配置解析     → auto 优先级（百度 > OpenAI 兼容 > Ollama）、显式指定、缺项不计 configured
```

真实 OCR 端到端（本机 Ollama + qwen2.5vl:3b，2026-10-23 实测）：

```
node scripts/test-ocr.js .tmp/product-page.png --kind promo_screenshot
  → ollama 返回 15.7s
  → 11/11 行全部读出（商品名/价格/成分/克重/标准号/安全类别/版型/尺码/洗护/到手价）
  → 提取字段 8/9 正确（尺码表 missing，因为图片里确实没有尺码表 —— 这是正确行为）
  → 结论：「…执行标准 GB/T 22849-2024 在官方平台可查，状态为现行…」完整度 70%

服务端同一条链路（POST /api/analyses，图片 base64，8.7s）：
  GET  /api/health      → ocr_provider=ollama, ocr_configured=true
  GET  /api/ocr/probe   → ok=true「Ollama 就绪，模型 qwen2.5vl:3b（本机已装 2 个）」
  POST /api/analyses    → 201, demo=false, mode=ollama
                          名称/标准号/成分/克重全部来自真实 OCR
                          老化风险命中 3 条：rib-collar-relax / cellulosic-shrinkage / knit-pilling
```

服务端真实进程验证（`node server/server.js` + curl）：

```
GET  /api/health            → {"ok":true,"data":{"service":"yizhi-api","mode":"mock","standards":12,...}}
POST /api/analyses          → 201，返回 srv-8836b05b0dd4 与完整 fields/report
GET  /api/standards/GB 18401 → found:true, verified:true, 现行, 发布 2011-01-14 / 实施 2011-08-01
```

网页演示版（`web-demo/` + GitHub Pages）真实浏览器验证：

```
线上地址                      https://dh8818.github.io/yizhi/     → HTTP 200
yizhi-core.js（188,523 字节）  → HTTP 200，window.YizhiCore 可加载
分析页（示例C 牛仔裤）          → 结论卡渲染；冲突疑点「纤维成分在不同来源中说法不一致」正确出现；
                                缺尺码表 ⇒ 未给尺码；信息完整度 60%（部分完整）
对比页                        → 2 件商品 11 行 × 3 列表格 + 偏好建议
标准页                        → 搜索命中 GB 18401-2010，详情 9 行，官方链接指向 openstd 详情页
知识库                        → 纤维条目可搜索、可展开
```

> 网页版与小程序共用 `miniprogram/core/`：`scripts/build-web.js` 把 core 打包成单文件
> `web-demo/yizhi-core.js`，页面只做表单与渲染，所以两端的规则、措辞、数据结构完全一致。

## 四、已实现但**未验证**

| 项目 | 原因 | 影响 |
|---|---|---|
| 9 个页面的真实渲染 | 微信开发者工具未安装，未做编译 | 可能有样式/组件告警；WXML 表达式已尽量保持简单 |
| 真机调试、权限弹窗（相册/相机） | 同上 | 首次授权流程未实测 |
| 分享卡片（`onShareAppMessage`） | 需要在真机或工具里预览 | 只返回标题与首页路径，不含个人数据 |
| `wx.chooseMedia` 的 HEIC 转码行为 | 平台/机型相关 | 已按扩展名拒绝不支持格式并提示 |
| 真实电商截图的表现 | 目前只用本仓库生成的合成商品页做了 OCR 验证 | 未用真实 App 截图评测过；3B 模型对小字号、复杂排版可能漏行 |
| 云端 OCR（OpenAI 兼容 / 百度） | 没有对应密钥 | 只测过协议与错误处理（stub），未发过真实请求 |
| 后端模式在真机上的连通性 | 需局域网 IP + 域名白名单 | 设置页与 README 都写了配置步骤 |

## 五、暂未实现

- 微信登录、账号体系、云开发、支付/会员；
- 跨设备同步（当前明确写"本地数据 ≠ 云端数据"）；
- 商品数据库 / 用户评价 / 价格历史（不做没有数据支撑的趋势图）；
- 标准正文条款与限值的自动比对（需要合法获取正文 + 人工审校）；
- 图片长期保存（历史里的图片预览路径在重进小程序后失效）；
- 检测报告 OCR 与"报告编号—机构—项目"结构化（目前只标记"提及检测"并要求商家提供）；
- 生产级数据库与对象存储（见 `docs/DATA-MODEL.md` 的目标模型，尚未落库）。

## 六、被外部条件阻塞

| 阻塞项 | 具体表现 | 解除条件 |
|---|---|---|
| 微信开发者工具 | 本机未安装，`npm` 侧也没有可替代的编译器 | 安装后导入 `D:\Projects\yizhi`，AppID 填测试号即可 |
| 正式 AppID / 类目审核 | `project.config.json` 用 `touristappid` | 提供真实 AppID 并完成小程序类目与隐私政策提交 |
| 视觉模型密钥 | `.env` 为空，`/api/health` 显示 `vision_configured:false` | 配置 `YIZHI_VISION_BASE_URL/MODEL/API_KEY` |
| 行业标准官方数据 | `FZ/T 73020`、`FZ/T 81007` 不在国标全文公开系统 | 到 `hbba.sacinfo.org.cn` 人工核验后录入 |
| 标准正文范围条款 | openstd 公开页不含正文 | 人工查阅"在线预览"后补 `scope_summary`，并标注录入人与日期 |

## 七、已知缺陷 / 风险

1. **标准覆盖面小**：只有 12 条（10 条已核验），未覆盖童装以外的多数品类标准；`CATEGORY_STANDARD_HINTS` 是提示，不是规则。
2. **克重参考 `samples=0`**：区间来自公开资料，未做抽样验证；界面文字已写明"不是品质评级"。
3. **面料知识未审校**：13 条纤维均 `needs_review=true`，界面上有"待专业审校"标签。
4. **提取器是规则驱动的**：对排版自由、多语言混排、竖排文字的真实截图可能漏提；这是刻意选择（可测、可解释），换大模型时保持同一输出契约即可。
5. **模拟 OCR 的误导风险**：`YIZHI_OCR_FALLBACK=demo` 默认开启，后端未配模型时用示例文本代替 OCR。已在响应里写 `demo:true` + 明确文案，但如果接入方忽略该字段仍可能误用 → 生产环境建议设 `off`。
6. **服务端无鉴权体系**：只有可选 AppID 头 + 限流，**不能直接暴露在公网**。
7. **历史里的图片会失效**：只存了临时路径；要长期保留需转存 `USER_DATA_PATH` 或对象存储。
8. **对比只在同一台设备**：依赖本地历史，删了就没了。
9. **本机 OCR 的速度**：qwen2.5vl:3b 在 CPU 上单张约 9–16 秒（GPU 会快很多）。要更快，用云端视觉接口或百度 OCR。
10. **3B 模型的转录边界**：小字号、竖排、花哨排版可能漏行或错字；它只读"看得清的字"，不补不猜。
11. **`wx.request` 无法打开外部网页**：官方查询链接用"复制 + 提示到浏览器打开"的方式，不是内嵌浏览器（`web-view` 需要业务域名）。

## 八、需要人工核验的数据

| 数据 | 当前状态 | 需要做什么 |
|---|---|---|
| `FZ/T 73020`（针织休闲服装） | `pending_verification`，无名称/日期 | 到行业标准平台核验状态与日期后录入 |
| `FZ/T 81007`（单、夹服装） | 同上 | 同上 |
| 全部 10 条国标的范围条款 | `scope_summary: null` | 查阅正文后补录，并注明录入人与日期 |
| `standards.meta.js` 的"常见管控项目" | `key_requirements_verified: false` | 由纺织标准专业人员逐条核对条款号与限值 |
| `knowledge.data.js` 13 条纤维 | `needs_review: true` | 专业审校（尤其"可能优点/局限"的措辞强度） |
| `WEIGHT_REFERENCES` 区间 | `samples: 0` | 若要给评级，必须先积累样本（≥30/品类）并重新校准 |

## 九、结论

- **能跑**：核心链路（提取 → 证据 → 规则 → 报告 → 对比）在 Node 下 120 个测试全绿，服务端真实起进程可访问；
- **能看**：9 个页面的代码、样式、交互齐全，工程自检通过，但**没在微信编译器里编译过**；
- **不吹**：标准只核验了真实抓到的那 10 条，其余一律"待核验"；没有检测数据时不给质量结论、不给准确率。

下一步优先级（详见任务收尾说明）：
1. 在微信开发者工具里编译并修 UI 问题（阻塞项：装工具）；
2. 配一个视觉模型跑真实截图，用真实样本替换 `demo` 评测集；
3. 把标准核验做成可调度任务 + 人工审校流程（否则标准库会过期）。
