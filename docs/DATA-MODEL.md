# 数据模型

分两部分：
1. **当前实现**（JSON 文件，够用但不适合生产）；
2. **目标模型**（关系型设计，尚未实现，作为下一步的落库依据）。

## 一、当前实现（server/data/analyses.json）

```jsonc
{
  "analyses": {
    "srv-8836b05b0dd4": {
      "id": "srv-8836b05b0dd4",
      "created_at": "2026-10-23T06:48:19.211Z",
      "demo": true,
      "mode": "mock",                       // mock | vision
      "images": [                            // 只存元信息，不存图片字节
        { "id": "demo-jeans-promo", "kind": "promo_screenshot" }
      ],
      "fields": { "<field_key>": { "field_key": "...", "raw_text": "...", "normalized_value": "...",
                                   "unit": "...", "status": "...", "source_type": "...",
                                   "source_image_id": "...", "confidence": 0.7,
                                   "evidence_note": "...", "alternatives": [], "updated_at": "..." } },
      "report": { "header": {}, "sections": [], "doubts": [], "questions": [], "limits": [],
                  "evidence": [], "standard": {}, "fit": {}, "weight": {}, "yarn": {},
                  "disclaimer": "...", "confidence_note": "..." }
    }
  },
  "comparisons": {
    "cmp-1761192499211": { "created_at": "...", "ids": ["srv-a", "srv-b"], "suggestion": { } }
  }
}
```

写入方式：临时文件 + `rename`（原子），路径由 `YIZHI_DATA_DIR` 决定，默认 `./server/data`。

**不存储**：图片原图/缩略图、用户个人资料（身高体重等只在请求内使用）、IP、微信身份。

### 小程序端（wx storage）

| key | 内容 | 上限 |
|---|---|---|
| `yizhi:settings` | mode / apiBase | 很小 |
| `yizhi:profile` | 身高体重围度偏好 | 很小 |
| `yizhi:history` | 最近 30 条分析（含 fields 与 report） | 每条约 10–20KB |
| `yizhi:favorites` | 收藏 id 数组 | 很小 |
| `yizhi:feedback` | 反馈草稿（最近 20 条） | 很小 |

图片预览用的是 `wx` 的临时文件路径，**重进小程序后会失效**（历史里只保留文字与图片类型）。
这是一个已知限制：要做「历史里还能看图」，需要把图片转存到 `wx.env.USER_DATA_PATH` 并记录路径，
或在后端模式下落对象存储。

## 二、目标模型（未实现，供后续落库）

```sql
-- 分析任务
CREATE TABLE analyses (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  mode          TEXT NOT NULL CHECK (mode IN ('mock','vision')),
  is_demo       INTEGER NOT NULL DEFAULT 0,
  owner_hash    TEXT,                    -- 若接入账号体系；否则 NULL（匿名）
  completeness  REAL,                     -- 0..1，便于筛选
  level         TEXT CHECK (level IN ('low','medium','high'))
);

-- 图片（元信息；二进制放对象存储）
CREATE TABLE analysis_images (
  id          TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('promo_screenshot','physical_label','size_chart','detail_photo')),
  storage_key TEXT,                       -- 对象存储 key；不存 base64
  width       INTEGER,
  height      INTEGER,
  bytes       INTEGER,
  created_at  TEXT NOT NULL
);

-- 字段证据（一个字段可以有多条证据：多图冲突、用户修正）
CREATE TABLE field_evidence (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id     TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  field_key       TEXT NOT NULL,
  raw_text        TEXT,
  normalized_value TEXT,                  -- JSON 字符串（可能是数组/对象）
  unit            TEXT,
  status          TEXT NOT NULL,           -- extracted/user_confirmed/official_verified/
                                           -- inferred/missing/unreadable/conflict/pending_verification
  source_type     TEXT NOT NULL,
  source_image_id TEXT REFERENCES analysis_images(id),
  confidence      REAL,
  evidence_note   TEXT,
  is_canonical    INTEGER NOT NULL DEFAULT 0,  -- 当前采用的那条
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_evidence_analysis_field ON field_evidence(analysis_id, field_key);

-- 标准主表 + 版本历史（不覆盖旧版本）
CREATE TABLE standards (
  standard_id      TEXT PRIMARY KEY,       -- 例：GB 18401（不带年份）
  standard_number  TEXT NOT NULL UNIQUE,   -- 例：GB 18401-2010
  name             TEXT,
  name_en          TEXT,
  standard_type    TEXT,
  status           TEXT,                   -- current/upcoming/abolished/superseded/under_revision/unknown
  publication_date TEXT,
  implementation_date TEXT,
  official_source_url TEXT,
  last_verified_at TEXT,
  verification_status TEXT NOT NULL        -- official_verified/pending_verification
);
CREATE TABLE standard_versions (
  standard_id   TEXT NOT NULL REFERENCES standards(standard_id),
  standard_number TEXT NOT NULL,
  status        TEXT,
  publication_date TEXT,
  implementation_date TEXT,
  replaced_by   TEXT,
  PRIMARY KEY (standard_id, standard_number)
);
CREATE TABLE standard_editorial (          -- 人工整理，永不混进官方字段
  standard_id TEXT PRIMARY KEY REFERENCES standards(standard_id),
  role TEXT,
  applicable_categories TEXT,              -- JSON 数组
  key_requirement_topics TEXT,             -- JSON 数组
  key_requirements_verified INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  reviewer TEXT,
  reviewed_at TEXT
);

-- 商品—标准关联（保留"只是标注"与"已核验"的区别）
CREATE TABLE standard_associations (
  analysis_id   TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  standard_number TEXT NOT NULL,
  appears_in_product INTEGER NOT NULL,
  registry_match    INTEGER NOT NULL,
  applicability     TEXT,                  -- likely/unlikely/unknown
  compliance        TEXT NOT NULL DEFAULT 'not_assessed'
);

-- 面料知识
CREATE TABLE knowledge_entries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('fiber','structure','care')),
  name TEXT NOT NULL,
  definition TEXT, plain TEXT,
  common_uses TEXT, pros TEXT, cons TEXT, factors TEXT,   -- JSON 数组
  sources TEXT, updated_at TEXT NOT NULL,
  needs_review INTEGER NOT NULL DEFAULT 1
);

-- 面料的同类参考区间（样本数必须如实记录）
CREATE TABLE fabric_references (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('weight_g_m2','yarn_count')),
  min_value REAL, max_value REAL, typical TEXT,
  samples INTEGER NOT NULL DEFAULT 0,      -- 0 = 只有公开资料区间，没有实测样本
  source TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- 对比与反馈
CREATE TABLE comparisons (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, analysis_ids TEXT NOT NULL, suggestion TEXT
);
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
  text TEXT NOT NULL, contact TEXT, status TEXT NOT NULL DEFAULT 'new'
);
```

### 约束要点

1. `field_evidence` 允许同一 `(analysis_id, field_key)` 多条，只有一条 `is_canonical=1`，
   这样"用户修正 + 原始识别"可以同时保留，不需要覆盖写入。
2. `compliance` 只有 `not_assessed` 一个合法值，未来若接入检测报告，需要新增 `evidence_id` 而不是改这一列。
3. `fabric_references.samples` 默认 0，任何"高/中/低"评级都必须能指到 `samples > 0` 的行。
4. 图片二进制走对象存储，数据库只存 key；删除分析时先删对象再删行（或定时对账）。

## 三、迁移建议

- 现在 `server/data/analyses.json` 可以原样导入 `analyses` + `field_evidence`
  （`fields` 是 `{key: 记录}`，直接展开成行，`is_canonical=1`）；
- `standard_versions` 从 `standards.verified.js` 的 `versions` 字段生成；
- 迁移脚本应保留 `last_verified_at` 与 `official_source_url`，否则标准状态就失去了可追溯性。
