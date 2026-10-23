/**
 * rule-engine：确定性规则判断 —— 信息完整度 + 疑点清单。
 *
 * 设计原则（规范 5.2 / 页面 C 疑点区域）：
 * - 每条疑点必须有：具体依据(basis) + 下一步(action)，禁止"可能有问题"这种空话；
 * - 疑点 ≠ 指控：不使用"违规""假货""不合格"等定性词；
 * - 信息缺失只说明"无法判断什么"，不推断成负面评价。
 */

'use strict';

const { FIELD_STATUS, hasValue, KEY_FIELDS, fieldDef } = require('./fields');

const SEVERITY_ORDER = { attention: 0, verify: 1, info: 2 };

function present(field) {
  return hasValue(field);
}

/** 信息完整度：关键字段 2 分，辅助字段 1 分 */
function computeCompleteness(fields) {
  const f = fields || {};
  const keys = Object.keys(f);
  let totalWeight = 0;
  let presentWeight = 0;
  const missing = [];
  const unresolved = [];

  for (const key of keys) {
    const field = f[key];
    const def = fieldDef(key);
    const weight = KEY_FIELDS.includes(key) ? 2 : 1;
    totalWeight += weight;
    if (present(field)) {
      presentWeight += weight;
    } else if (field && field.status === FIELD_STATUS.UNREADABLE) {
      unresolved.push(key);
    } else {
      missing.push(key);
    }
  }

  const keyMissing = KEY_FIELDS.filter((k) => !present(f[k]));
  const ratio = totalWeight ? presentWeight / totalWeight : 0;
  const keyRatio = KEY_FIELDS.length ? (KEY_FIELDS.length - keyMissing.length) / KEY_FIELDS.length : 0;

  let level = 'low';
  if (keyMissing.length === 0 && ratio >= 0.8) level = 'high';
  else if (keyMissing.length <= 1 && ratio >= 0.55) level = 'medium';

  return {
    ratio: Math.round(ratio * 100) / 100,
    key_ratio: Math.round(keyRatio * 100) / 100,
    level,
    level_label: level === 'high' ? '较完整' : level === 'medium' ? '部分完整' : '信息不足',
    key_missing: keyMissing,
    missing,
    unresolved,
    note:
      level === 'high'
        ? '关键字段齐全，结论可以写得具体一些，但仍不代表实物已检测。'
        : level === 'medium'
          ? '还缺部分关键信息，结论会保留更多不确定性，并列出需要确认的问题。'
          : '关键信息明显不足，本卡只描述"已知内容"，不给合身或质量结论。'
  };
}

function labelOf(key) {
  return fieldDef(key).name;
}

function basisOf(fields, keys) {
  return (keys || [])
    .map((k) => {
      const f = fields[k];
      if (!f) return null;
      return {
        type: 'field',
        field_key: k,
        field_name: labelOf(k),
        status: f.status,
        source_type: f.source_type,
        source_image_id: f.source_image_id || null,
        raw_text: f.raw_text || null
      };
    })
    .filter(Boolean);
}

const CLAIM_RULES = [
  {
    id: 'claim-functional',
    re: /(抗菌|抑菌|防螨|除螨|防霉|抗病毒|防紫外线|UPF|远红外|负离子|抗氧化)/,
    title: '功能性宣称需要具体依据',
    reason: (m) => `页面出现「${m[0]}」这类功能性宣称。功能宣称通常需要有对应标准与检测报告支撑，仅靠文案无法确认。`,
    action: '向商家索取：检测机构名称、报告编号、依据的标准号（例如 UPF 值对应 GB/T 18830 类标准），并核对报告上的样品与批次。',
    question: '这款商品的功能性（如抗菌/防晒）有对应的检测报告吗？报告编号和检测机构是什么？'
  },
  {
    id: 'claim-chemical',
    re: /(零甲醛|无甲醛|0甲醛|不含甲醛|无荧光|无致癌|食品级|医用级|婴儿级)/,
    title: '绝对化安全宣称无法由页面证明',
    reason: (m) => `「${m[0]}」属于绝对化/安全类宣称。纺织品化学指标需要按标准方法检测，页面文案不能作为证据。`,
    action: '请商家提供近期的检测报告（含样品名称、报告编号、检测项目）。不要仅凭文案判断安全性。',
    question: '页面写的"零甲醛/婴儿级"有第三方检测报告吗？能提供报告首页和结论页吗？'
  },
  {
    id: 'claim-permanent',
    re: /(绝不|永久|100%\s*不起球|永不起球|不掉色|永不褪色|绝对)/,
    title: '绝对化承诺需要谨慎看待',
    reason: (m) => `页面出现「${m[0]}」。起球、掉色与穿着方式、洗涤方式相关，通常无法做到绝对。`,
    action: '把关注点放在检测报告与洗护说明上；如果商家给出绝对承诺，建议保留聊天记录以便售后。',
    question: '如果出现起球/掉色，售后按什么标准判定和处理？'
  },
  {
    id: 'claim-origin',
    re: /(进口面料|意大利面料|德国机器|日本工艺|原单|专柜同款|大牌同款)/,
    title: '产地/工艺类说法缺少可核验信息',
    reason: (m) => `页面出现「${m[0]}」，但截图中没有对应的可核验信息（如产地标注、报关信息、品牌授权）。`,
    action: '可要求商家提供进货凭证或标注信息；宣传用词本身不构成商品参数。',
    question: '提到的面料产地/工艺有凭证可以在售前提供吗？'
  }
];

/**
 * 生成疑点清单。
 * @param {object} ctx
 * @param {object} ctx.fields
 * @param {object} [ctx.standard] associate() 的返回
 * @param {object} [ctx.weight] assessWeight() 的返回
 * @param {object} [ctx.yarn] assessYarnCount() 的返回
 * @param {object} [ctx.fit] assessFit() 的返回
 * @param {object} [ctx.completeness] computeCompleteness() 的返回
 * @param {string} [ctx.rawText] 原始 OCR 文本（用于功能性宣称扫描）
 */
function buildDoubts(ctx) {
  const fields = (ctx && ctx.fields) || {};
  const standard = ctx && ctx.standard;
  const weight = ctx && ctx.weight;
  const fit = ctx && ctx.fit;
  const completeness = (ctx && ctx.completeness) || computeCompleteness(fields);
  const rawText = (ctx && ctx.rawText) || '';
  const doubts = [];
  const push = (d) => doubts.push({ severity: 'info', ...d });

  const covered = new Set();

  /* 1. 识别不清 */
  if (completeness.unresolved.length) {
    push({
      id: 'unreadable',
      severity: 'verify',
      category: '识别受限',
      title: `${completeness.unresolved.map(labelOf).join('、')}在图中无法辨识`,
      reason: '图片分辨率、反光或排版导致文字无法可靠识别。系统没有猜测内容。',
      basis: completeness.unresolved.map((k) => ({ type: 'field', field_key: k, field_name: labelOf(k), status: FIELD_STATUS.UNREADABLE })),
      action: '重新拍摄/截取更清晰的局部图后补充上传。',
      question: null
    });
  }

  /* 3. 字段冲突 */
  for (const [key, field] of Object.entries(fields)) {
    if (!field || field.status !== FIELD_STATUS.CONFLICT) continue;
    push({
      id: `conflict-${key}`,
      severity: 'attention',
      category: '信息冲突',
      title: `${labelOf(key)}在不同来源中说法不一致`,
      reason: field.evidence_note || '两个来源给出的值不同，系统保留了双方证据，没有替你选一个。',
      basis: (field.alternatives || []).map((a) => ({
        type: 'alternative',
        value: a.normalized_value,
        raw_text: a.raw_text,
        source_type: a.source_type,
        source_image_id: a.source_image_id
      })),
      action: '以实物标签为准；截图与页面描述不一致时，让商家确认哪个是最终参数。',
      question: `${labelOf(key)}在页面和吊牌上写的不一样，以哪个为准？能发吊牌照片确认吗？`
    });
    covered.add(key);
  }

  /* 4. 标准相关 */
  if (standard) {
    covered.add('standard_code');
    if (!standard.appears_in_product) {
      push({
        id: 'standard-missing',
        severity: 'verify',
        category: '标准与标识',
        title: '没有看到执行标准号',
        reason: '商品截图中没有出现执行标准号，因此无法核对它声称执行的是哪个标准、是否现行。',
        basis: basisOf(fields, ['standard_code']),
        action: '吊牌/水洗标通常会印执行标准与安全类别；补一张标签照片即可补齐。',
        question: '这款商品的执行标准号和安全类别是什么？能发吊牌照片吗？'
      });
    } else if (standard.registry_result === 'pending_verification') {
      push({
        id: 'standard-unverified',
        severity: 'verify',
        category: '标准与标识',
        title: `标准 ${standard.normalized_code || ''} 暂未核验`,
        reason: standard.message || '本级核验库中没有该标准号的官方查询结果。系统不判断它是否现行，也不补齐版本。',
        basis: basisOf(fields, ['standard_code']),
        action: '点开"官方查询来源"自行核对，或让商家提供标注该标准的吊牌照片。',
        question: `商品标注的 ${standard.normalized_code || '执行标准'} 是现行版本吗？`
      });
    } else if (standard.official_status === 'abolished') {
      push({
        id: 'standard-abolished',
        severity: 'attention',
        category: '标准与标识',
        title: `标注的标准版本已废止（${standard.normalized_code}）`,
        reason: '官方平台显示该版本状态为已废止。已废止版本可能在旧库存上出现，但不应用于新生产商品。',
        basis: basisOf(fields, ['standard_code']),
        action: '确认生产日期与批次；要求商家提供现行版本标注或检测报告。',
        question: `${standard.normalized_code} 已废止，这款是旧库存吗？现行版本标注是什么？`
      });
    } else if (standard.official_status === 'upcoming') {
      push({
        id: 'standard-upcoming',
        severity: 'info',
        category: '标准与标识',
        title: `标注的标准尚未到实施日期（${standard.normalized_code}）`,
        reason: '官方平台显示该版本尚未实施，是否已可标注取决于实施日期。',
        basis: basisOf(fields, ['standard_code']),
        action: '核对实施日期与商品生产日期。',
        question: null
      });
    }

    if (standard.registry_match && standard.applicability === 'unlikely') {
      push({
        id: 'standard-applicability',
        severity: 'verify',
        category: '标准与标识',
        title: '标准与品类可能不匹配',
        reason: standard.applicability_reason || '标准名称限定的产品与该商品品类不一致。',
        basis: basisOf(fields, ['standard_code', 'category']),
        action: '请商家说明该标准为何适用于此商品，或提供正确的产品标准号。',
        question: '这个标准号与该品类不太对应，能确认一下正确的执行标准吗？'
      });
    }

    if (standard.applies_to_all_textiles === false && standard.key_requirements_verified === false) {
      push({
        id: 'standard-topics',
        severity: 'info',
        category: '标准与标识',
        title: '标准的具体条款未逐条核对',
        reason: '公开平台只提供标准号、名称、状态和日期；条款内容与限值需查阅标准正文，本系统没有替你引用条款。',
        basis: [{ type: 'standard', standard_number: standard.normalized_code, registry_result: standard.registry_result }],
        action: '如需逐条核对，可在官方"在线预览"查阅正文，或索取检测报告中的检测依据。',
        question: null
      });
    }
  }

  /* 5. 成分比例 */
  const fiber = fields.fiber_composition;
  if (fiber && fiber.parsed && fiber.parsed.total != null && Math.abs(fiber.parsed.total - 100) > 1) {
    push({
      id: 'fiber-sum',
      severity: 'attention',
      category: '面料参数',
      title: '纤维比例合计不等于 100%',
      reason: `标注的百分比合计约 ${fiber.parsed.total}%，可能是漏识别或页面本身漏写。`,
      basis: basisOf(fields, ['fiber_composition']),
      action: '核对水洗标原文；标注不完整时建议让商家确认各部分（面料/里料/填充物）的完整比例。',
      question: '面料的完整成分比例是多少？里料和填充物分别是什么？'
    });
    covered.add('fiber_composition');
  }

  /* 6. 克重 / 支数 */
  if (weight) {
    if (weight.status === 'missing') {
      push({
        id: 'weight-missing',
        severity: 'info',
        category: '面料参数',
        title: '没有克重信息，不做厚薄评级',
        reason: '截图未提供克重，系统不会估算具体数值，也不给"厚/薄"评级。',
        basis: basisOf(fields, ['fabric_weight', 'garment_weight']),
        action: '可向商家索取面料克重（g/m²）；注意"成衣重量 g"不能等同于克重。',
        question: '这款面料克重是多少 g/m²？'
      });
    } else if (weight.status === 'ambiguous' || weight.status === 'incomparable') {
      push({
        id: 'weight-ambiguous',
        severity: 'verify',
        category: '面料参数',
        title: '重量口径需要确认',
        reason: weight.message,
        basis: basisOf(fields, ['fabric_weight', 'garment_weight']),
        action: '确认是"每平方米克重(g/m²)"还是"单件重量(g)"，两者不能互相换算比较。',
        question: '客服说的克重是 g/m² 还是单件重量 g？'
      });
    }
    covered.add('fabric_weight');
    covered.add('garment_weight');
  }

  /* 7. 尺码表 */
  if (!present(fields.size_chart)) {
    push({
      id: 'size-chart-missing',
      severity: 'verify',
      category: '版型与尺码',
      title: '没有尺码表，无法给出确定尺码',
      reason: '没有成衣尺寸（肩宽/胸围/衣长），任何具体尺码建议都是猜的，系统不猜。',
      basis: basisOf(fields, ['size_chart', 'size_range', 'fit_description']),
      action: '补一张尺码表截图，或索取成衣平铺尺寸。',
      question: '能提供各尺码的成衣平铺尺寸（肩宽/胸围/衣长/袖长）吗？'
    });
    covered.add('size_chart');
  }

  /* 8. 安全类别 */
  if (!present(fields.safety_category)) {
    push({
      id: 'safety-category-missing',
      severity: 'info',
      category: '标准与标识',
      title: '没有看到产品安全类别',
      reason: '安全类别（A/B/C 类）通常与执行标准一起印在吊牌或水洗标上，截图里缺失。',
      basis: basisOf(fields, ['safety_category']),
      action: '补吊牌照片即可核对。',
      question: '吊牌上的安全类别是哪一类？'
    });
    covered.add('safety_category');
  }

  /* 9. 洗护 */
  if (!present(fields.care_instructions)) {
    push({
      id: 'care-missing',
      severity: 'info',
      category: '洗护',
      title: '没有洗护标签信息',
      reason: '系统只给基于成分的一般参考，不能替代商品标签上的洗护要求。',
      basis: basisOf(fields, ['care_instructions']),
      action: '补一张水洗标照片；洗护符号含义见"洗护"区块。',
      question: '能把水洗标拍一下吗？'
    });
    covered.add('care_instructions');
  }

  /* 10. 检测报告仅"提及" */
  if (fields.test_report && fields.test_report.status === FIELD_STATUS.PENDING_VERIFICATION) {
    push({
      id: 'test-report-claim',
      severity: 'verify',
      category: '证据',
      title: '页面提到检测/质检，但没有报告信息',
      reason: '截图中出现检测类字样，但没有报告编号、检测机构或检测项目，无法确认检测对象与结论。',
      basis: basisOf(fields, ['test_report']),
      action: '索取报告首页（含报告编号、机构、样品名称、检测依据）与结论页。',
      question: '检测报告的编号和检测机构是什么？检测项目包含哪些？'
    });
    covered.add('test_report');
  }

  /* 11. 宣称类 */
  for (const rule of CLAIM_RULES) {
    const m = rawText.match(rule.re);
    if (!m) continue;
    push({
      id: `claim-${rule.id}`,
      severity: 'verify',
      category: '宣传宣称',
      title: rule.title,
      reason: rule.reason(m),
      basis: [{ type: 'text', match: m[0], source_type: 'promo_screenshot' }],
      action: rule.action,
      question: rule.question
    });
  }

  /* 12. 标准号缺年份 */
  const std = fields.standard_code;
  if (std && present(std) && !/\d{4}/.test(String(std.normalized_value || ''))) {
    push({
      id: 'standard-year-missing',
      severity: 'verify',
      category: '标准与标识',
      title: '标准号缺少年份',
      reason: '原文没有年份，无法确定引用的是哪一版；系统没有自动补年份。',
      basis: basisOf(fields, ['standard_code']),
      action: '核对吊牌原文；同一标准号不同年份版本要求不同。',
      question: '吊牌上执行标准的完整写法（含年份）是什么？'
    });
    covered.add('standard_code');
  }

  /* 13. 品类未识别 */
  if (!present(fields.category)) {
    push({
      id: 'category-missing',
      severity: 'info',
      category: '基础信息',
      title: '没有识别出品类',
      reason: '品类决定适用哪些产品标准、如何比较克重，缺失会让后续判断变弱。',
      basis: basisOf(fields, ['category']),
      action: '在"基本信息"里手动选择品类（下拉项均可选择）。',
      question: null
    });
    covered.add('category');
  }

  /* 14. 版型信息不足（有 fit 结果时） */
  if (fit && fit.status === 'profile_incomplete') {
    push({
      id: 'fit-profile-incomplete',
      severity: 'info',
      category: '版型与尺码',
      title: '个人身材资料不完整',
      reason: `缺少：${fit.missing_profile.join('、')}。系统不会推测你的身体数据。`,
      basis: [],
      action: '在"身材与偏好"里自愿补充需要的字段（不必填全）。',
      question: null
    });
  }

  /* 14b. 老化风险：只在高风险时提示，避免与「穿久了会怎么样？」区块重复 */
  const wear = ctx && ctx.wear;
  if (wear && wear.available) {
    const high = wear.items.filter((i) => i.overall_risk === 'high');
    if (high.length) {
      push({
        id: 'wear-high-risk',
        severity: 'attention',
        category: '长期穿着',
        title: `「${high[0].garment_area}」存在需要重点核实的老化风险：${high[0].item_name}`,
        reason:
          `${high[0].possible_failure}。` +
          (high[0].evidence_level === 'observed_defect'
            ? '这是图片/描述中**已经存在**的迹象，不是预测。'
            : '这是基于已识别结构与材料的风险提示，不是实测结论。'),
        basis: (high[0].evidence || []).map((e) => ({ type: 'feature', field_name: e.label, raw_text: e.text, status: 'extracted' })),
        action: '看「穿久了会怎么样？」区块：那里写了成因、影响程度、判断置信度与补图/询问建议。',
        question: (high[0].seller_questions && high[0].seller_questions[0]) || null
      });
    }
  }

  /* 15. 其余关键字段缺失：只对没被上面具体规则覆盖的字段给一条通用提示 */
  const leftover = completeness.key_missing.filter((k) => !covered.has(k));
  if (leftover.length) {
    const byGroup = {};
    for (const key of leftover) {
      const def = fieldDef(key);
      byGroup[def.group] = byGroup[def.group] || [];
      byGroup[def.group].push(key);
    }
    for (const [group, keys] of Object.entries(byGroup)) {
      push({
        id: `missing-${group}`,
        severity: group === 'fabric' || group === 'standard' ? 'verify' : 'info',
        category: '信息缺失',
        title: `缺少${keys.map(labelOf).join('、')}`,
        reason: '当前截图/照片里没有识别到这些关键字段，系统不会替它填一个数值。缺它们会直接影响结论强度。',
        basis: keys.map((k) => ({ type: 'field', field_key: k, field_name: labelOf(k), status: FIELD_STATUS.MISSING })),
        action:
          group === 'standard'
            ? '补一张吊牌或水洗标照片（上面通常有执行标准、安全类别、成分、洗护）。'
            : group === 'fabric'
              ? '补一张"成分/面料参数"详情页截图，或向客服索取纤维含量与克重。'
              : '补一张尺码表截图，或向客服索取成衣尺寸（肩宽/胸围/衣长）。',
        question: null
      });
    }
  }

  const rankOf = (d) => (SEVERITY_ORDER[d.severity] === undefined ? 9 : SEVERITY_ORDER[d.severity]);
  doubts.sort((a, b) => rankOf(a) - rankOf(b));
  return {
    items: doubts,
    counts: {
      attention: doubts.filter((d) => d.severity === 'attention').length,
      verify: doubts.filter((d) => d.severity === 'verify').length,
      info: doubts.filter((d) => d.severity === 'info').length
    },
    questions: doubts.map((d) => d.question).filter(Boolean)
  };
}

module.exports = { computeCompleteness, buildDoubts, CLAIM_RULES, SEVERITY_ORDER };
