# 衣知 · 服装信息识别与选衣决策小程序

上传一张电商商品截图，得到一张**可追溯、有边界、能解释不确定性**的服装分析卡：
成分怎么理解、执行标准是不是现行、克重/支数能不能比、版型合不合你、哪些信息缺失、下单前该问商家什么。

> 本卡是信息整理与规则提示，**不是检测报告**，也不构成质量、真伪或合规判定。

## 现在能做什么

> **在线演示（浏览器直接打开，无需安装任何东西）**：https://dh8818.github.io/yizhi/
> 这是同一套 `core/` 逻辑的网页外壳，不含 OCR、不发任何请求，示例数据与手填字段即可体验完整分析流程。
> 小程序本体仍需用微信开发者工具导入本仓库根目录运行（见下文）。

| 能力 | 状态 | 说明 |
|---|---|---|
| 原生微信小程序（9 个页面） | ✅ 可运行 | 无需构建链，直接导入微信开发者工具 |
| 网页演示版（同一个 core） | ✅ 线上可访问 | https://dh8818.github.io/yizhi/ · 同一套核心逻辑的浏览器外壳 |
| 本地模式（不联网） | ✅ 完整跑通 | 示例商品 + 手动填写 → 完整分析卡 |
| 后端模式（Express 之外的零依赖 Node 服务） | ✅ 可运行 | `npm run api`，图片上传 + 同一套核心逻辑 |
| 字段证据模型（8 种状态 × 8 种来源） | ✅ | 已识别 / 已确认 / 已核验 / 推断 / 未提供 / 识别不清 / 冲突 / 待核实 |
| 多来源冲突保留 | ✅ | 宣传页 vs 吊牌不一致时保留双方证据 |
| 标准核验（真实官方数据） | ✅ 部分 | 10 条国标已从 openstd.samr.gov.cn 实时核验并落库 |
| 标准条款/范围文本 | ❌ 未做 | 公开页面不含正文档，需人工查阅后录入（系统不代填） |
| 克重参考区间 | ✅ 但样本为 0 | 只做区间对照，不给高/中/低评级 |
| 支数评级 | ❌ 刻意不做 | 缺同类样本，只给口径说明 |
| 尺码建议 | ✅ 启发式 | 需要尺码表 + 你的胸围/偏好；缺任一项就明确拒绝给尺码 |
| 商品对比（2–3 件） | ✅ | 结论挂到偏好上，不做质量排名 |
| 历史 / 收藏 / 删除 | ✅ | 全部本机存储，可一键清空 |
| 微信登录 / 云开发 / 支付 | ❌ 未做 | 本项目没有账号体系 |
| 真实图片 OCR（本机） | ❌ 不可能 | 小程序端没有本地 OCR；要识别真实截图必须走后端 + 视觉模型 |

## 目录结构

```
yizhi/
├─ project.config.json          微信开发者工具项目配置（miniprogramRoot = miniprogram/）
├─ package.json                 测试 / 服务端 / 数据核验脚本（零运行时依赖）
├─ .env.example                 服务端配置模板（不含任何真实密钥）
├─ miniprogram/
│  ├─ app.js / app.json / app.wxss / sitemap.json
│  ├─ config.js                 运行配置（默认值 + storage 覆盖，无密钥）
│  ├─ core/                     ★ 纯逻辑层：小程序与 Node 共用同一份代码
│  │  ├─ fields.js              字段/状态/来源字典 + 证据记录构造
│  │  ├─ normalize.js           标准号、成分、克重、支数、价格、尺码表规范化
│  │  ├─ extractor.js           OCR 文本 → 结构化字段（确定性规则，非大模型）
│  │  ├─ evidence.js            多来源合并、冲突保留、用户修正留痕
│  │  ├─ standards.js           标准查询与"商品—标准"关联判断（永不做符合性结论）
│  │  ├─ knowledge.js           面料知识查询、成分→特性/洗护映射
│  │  ├─ fabric.js              克重/支数参考评估（区间对照，不评级）
│  │  ├─ rules.js               信息完整度 + 疑点清单（依据 + 下一步）
│  │  ├─ fit.js                 版型与尺码建议（启发式，缺数据就拒绝）
│  │  ├─ report.js              分析卡组装 + 结论措辞强度
│  │  ├─ compare.js             横向比较
│  │  ├─ pipeline.js            OCR → 提取 → 合并 → 报告（纯函数）
│  │  ├─ schema.js              模型输出结构校验
│  │  ├─ ai/vision.js           视觉模型适配器（服务端专用）
│  │  ├─ manual-fields.js       手填字段 → 字段记录（两端共用）
│  │  └─ data/                  标准核验结果、标准元数据、面料知识、示例商品
│  ├─ services/                 小程序侧适配：storage / api / upload / analysis
│  ├─ components/               status-tag / field-row
│  └─ pages/                    index · capture · result · standard · knowledge
│                               profile · compare · history · settings
├─ server/server.js             零依赖 HTTP API（Node stdlib）
├─ scripts/
│  ├─ verify-standards.js       从 openstd 实时核验标准并生成数据文件
│  ├─ lib/openstd-parse.js      官方页面解析（配真实页面快照做测试）
│  └─ self-check.js             工程自检（页面四件套/组件路径/密钥/架构约束）
├─ tests/                       85 个 node:test 用例 + openstd 真实页面快照
└─ docs/                        架构、API、验收报告、隐私说明
```

## 快速开始

```bash
cd D:/Projects/yizhi

npm run check      # 工程自检：页面/组件/密钥/架构约束（无需开发者工具）
npm test           # 85 个测试（不需要网络）
npm run api        # 启动后端 http://127.0.0.1:8787（可选）
npm run web        # 打包 core → web-demo/yizhi-core.js，并起网页演示 http://127.0.0.1:8090
```

网页演示（`web-demo/`）是同一个 `core/` 的浏览器外壳：`scripts/build-web.js` 用一个 40 行的
CommonJS loader 把 `miniprogram/core` 打包成单文件，页面只负责读表单和渲染，因此两端的结论必然一致。
它不含 OCR、不发请求、不含密钥；线上版本部署在 GitHub Pages（`gh-pages` 分支）。

### 在微信开发者工具中运行

1. 安装[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)（本机当前**未安装**，所以这一步尚未验证）。
2. 选择「导入项目」→ 目录选 `D:\Projects\yizhi`（不是 `miniprogram/`）。
3. AppID 可选「测试号」（`project.config.json` 里是 `touristappid`）；正式发布需要替换为你自己的 AppID。
4. 编译后首页默认是**本地模式**：点「用示例商品体验完整流程」即可看到完整分析卡。

> 本仓库的 UI 与逻辑代码是在没有开发者工具的环境里写的，已通过 Node 语法检查与工程自检，
> 但**没有经过微信编译器的真实编译**。首次导入若出现样式或组件告警，见 `docs/VALIDATION.md` 的排查清单。

### 切换到后端模式（识别真实截图）

```bash
cp .env.example .env          # 不要提交 .env
# 编辑 .env：填 YIZHI_VISION_BASE_URL / MODEL / API_KEY（OpenAI 兼容接口）
npm run api
```

小程序内：设置 → 运行模式 → 后端模式 → 地址填 `http://127.0.0.1:8787` → 测试连接。

真机调试注意：
- 手机里的 `127.0.0.1` 是手机自己，必须填电脑的**局域网 IP**（如 `http://192.168.1.10:8787`）；
- 正式环境必须是 **https**，并在小程序后台配置 `request` 合法域名；
- 开发阶段可在开发者工具「详情 → 本地设置」勾选「不校验合法域名」。

### 没有视觉模型时（模拟 OCR）

默认 `YIZHI_OCR_FALLBACK=demo`：后端没配视觉模型时，用示例商品的文本块代替 OCR，
并在结果里显式标注「模拟 OCR：不是你的图片内容」。设 `YIZHI_OCR_FALLBACK=off` 可改为直接报错。

## 标准数据怎么来的（重要）

```bash
npm run standards:verify                     # 核验内置清单（12 条）
node scripts/verify-standards.js "GB 31701"   # 核验指定标准号
```

脚本会真实访问 `https://openstd.samr.gov.cn` 的检索与详情页，解析出：
标准号、中英文名称、标准性质、状态（现行/废止）、发布日期、实施日期、CCS/ICS、主管与发布单位，
写入 `miniprogram/core/data/standards.verified.js`，每条带 `last_verified_at` 与 `official_source_url`。

口径边界：
- 只记录页面上真实存在的字段；抓不到就写 `pending_verification` 并说明原因；
- **行业标准（FZ/T、QB/T 等）不在国标全文公开系统范围内**，一律标「待核验」并指向 `hbba.sacinfo.org.cn`；
- 标准**正文的范围条款与限值不在公开页面上**，`scope_summary` 为 `null`，界面明说"需查阅正文"；
- 标准状态会变，界面上必须带核验日期。脚本可重复运行，历史数据不覆盖语义（每次重写生成新时间戳）。

## 关键设计约束（写进代码里的）

1. **四类信息严格分开**：图片识别 / 用户填写 / 官方核验 / 模型推断，各自有 `status` 与 `source_type`。
2. **不补、不猜**：缺克重不估算、缺支数不推测、标准号缺年份不补版本、没尺码表不给尺码。
3. **冲突保留双方**：`mergeField` 在值不一致时把状态设为 `conflict` 并保留全部来源。
4. **标准只做关联，不做符合性**：`compliance` 永远是 `not_assessed`。
5. **疑点必须可执行**：每条都带 `reason` + `basis` + `action`，不含"违规/假货/不合格"等指控词。
6. **不造假数据**：没有实测样本就不给品质评分、不给准确率数字；置信度只是模型自评。
7. **密钥只进服务端**：小程序包里没有任何密钥，`self-check` 会扫描并拦截。

## 已知限制

- 本机没有微信开发者工具 → 小程序**未做真实编译/真机验证**（详见验收报告）。
- 本地模式**没有 OCR**：选图后必须用示例商品或手动填写，否则会明确报"本地不做 OCR"。
- 标准库只有 12 条、已核验 10 条：覆盖 GB 18401/31701/5296.4/29862、GB/T 22849/2660/2664/2665/14272/22700。
- 克重参考区间 `samples = 0`（来自公开资料，非本项目实测），因此只做区间对照。
- 面料知识 13 条纤维 + 5 条组织，全部标 `needs_review`（未经过纺织专业审校）。
- 服务端用 JSON 文件存储，不是数据库，也没有账号/权限体系，**不能直接用于生产**。
- 历史记录只在本机，换手机/重装即丢失。

## 文档

- `docs/ARCHITECTURE.md` — 分层、数据流、模块契约、扩展点
- `docs/API.md` — 后端接口、请求/响应、错误码
- `docs/VALIDATION.md` — 验收报告（已实现 / 已测试 / 未实现 / 阻塞 / 已知缺陷 / 待人工核验）
- `docs/PRIVACY.md` — 数据处理说明（与小程序内"隐私与数据处理"一致）
