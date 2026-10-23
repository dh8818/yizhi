/**
 * wear/features.js —— 从"已识别的字段 + OCR 原文"里提出**设计特征**。
 *
 * 为什么单独一层：
 *   老化风险规则不应该直接读原始文本（那样每条规则都要写一遍正则），
 *   也不应该直接读字段（字段里没有"罗纹领口"这种设计信息）。
 *   所以先把文本/字段提炼成一组带证据来源的特征，规则只对特征做匹配。
 *
 * 三原则：
 *   1. 特征只记录"文中/图里出现了什么"，不记录"所以质量如何"；
 *   2. 每条特征都带 evidence（原句）与 source（promo_screenshot / physical_label / user_input）；
 *   3. 没识别到的特征一律不假设存在（不推断"应该有罗纹领口"）。
 */

'use strict';

const { hasValue } = require('../fields');

/** 特征定义：key / 中文名 / 匹配文本 / 说明 */
const FEATURE_DEFS = [
  {
    key: 'rib_collar',
    label: '罗纹领口',
    re: /(罗纹.{0,4}领|领口.{0,4}罗纹|罗纹领口|rib\s*collar)/i,
    note: '领口采用罗纹针织（线圈纵行相间），横向弹性好但长期拉伸会疲劳'
  },
  {
    key: 'rib_cuff_hem',
    label: '罗纹袖口/下摆',
    re: /(罗纹.{0,4}(袖口|下摆|裤脚)|(袖口|下摆|裤脚).{0,4}罗纹|收口|束口)/,
    note: '边缘用罗纹或弹性收口，反复拉伸后可能出现松弛'
  },
  {
    key: 'big_print',
    label: '大面积印花/胶印',
    re: /(大面积.{0,4}(印花|图案|胶印)|胶印|丝印|厚板|发泡印|烫画|热转印|满印)/,
    note: '塑胶类印花覆盖在面料表面，弯折与洗涤后可能开裂或翘边'
  },
  {
    key: 'print_any',
    label: '有印花/图案',
    re: /(印花|印图|图案|logo|LOGO|Logo|刺绣图案)/,
    note: '存在表面图案工艺，耐久性取决于工艺与洗护'
  },
  {
    key: 'coating_faux_leather',
    label: '涂层/仿皮结构',
    re: /(仿皮|PU皮|PU|聚氨酯涂层|涂层|覆膜|贴膜|防水涂层|皮革)/,
    note: '表面有高分子涂层或膜层，弯折处与接缝边缘是常见失效起点'
  },
  {
    key: 'brushed_surface',
    label: '磨毛/绒面',
    re: /(磨毛|拉绒|绒面|仿麂皮|麂皮绒|摇粒绒|抓绒|珊瑚绒|法兰绒)/,
    note: '表面纤维被拉起形成绒感，摩擦后可能起球、压亮或局部倒绒'
  },
  {
    key: 'fleece_lining',
    label: '起绒内里',
    re: /(内里.{0,4}(抓绒|起绒|加绒)|加绒|抓绒内里|摇粒绒内里)/,
    note: '内里起绒保暖，但容易掉毛、吸灰、与粗糙衣物摩擦起球'
  },
  {
    key: 'embroidery_beads',
    label: '刺绣/珠片/装饰件',
    re: /(刺绣|珠片|亮片|钉珠|水钻|铆钉|贴布|布贴|流苏|挂饰|五金装饰)/,
    note: '装饰件与底布的连接处是受力集中点，洗护时还可能勾挂'
  },
  {
    key: 'metal_hardware',
    label: '金属五金（拉链/扣）',
    re: /(金属拉链|金属扣|五金|拉链|YKK|铜扣|铆钉扣)/,
    note: '金属件与面料摩擦、以及镀层磨损，是常见的外观老化点'
  },
  {
    key: 'drawstring_hood',
    label: '帽绳/连帽结构',
    re: /(连帽|帽绳|抽绳|卫衣帽)/,
    note: '帽绳孔、帽与衣身连接处是拉扯与磨损集中区'
  },
  {
    key: 'splice_multi',
    label: '拼接/拼色/异材质',
    re: /(拼接|拼色|撞色|异材质|复合面料)/,
    note: '不同材质/颜色的拼接处，收缩率与色牢度差异会放大老化差异'
  },
  {
    key: 'elastic_waist',
    label: '松紧腰/弹性腰头',
    re: /(松紧腰|弹力腰|橡筋腰|抽绳腰)/,
    note: '橡筋长期受热与拉伸会衰减，腰头可能出现松弛与卷边'
  },
  {
    key: 'stretch_fabric',
    label: '弹力/紧身结构',
    re: /(弹力|高弹|紧身|瑜伽|速干|压缩|氨纶)/,
    note: '高伸展区域的接缝与弹性纤维承受反复拉伸'
  },
  {
    key: 'pleats_structure',
    label: '褶裥/定型结构',
    re: /(褶|压褶|定型|烫衬|粘合衬|硬挺)/,
    note: '定型与粘合结构依赖工艺，洗护不当可能失去形状'
  },
  {
    key: 'long_knit',
    label: '长款针织/垂坠结构',
    re: /(长款|中长|垂坠|针织衫|毛衣|毛衣裙)/,
    note: '针织长款受重力影响更明显，悬挂储存会拉伸'
  },
  {
    key: 'thin_fabric',
    label: '偏薄面料',
    re: /(轻薄|薄款|超薄|透气网眼|冰丝)/,
    note: '薄面料单位面积纤维少，耐磨与抗勾丝余量较小'
  },
  {
    key: 'performance_claim',
    label: '性能宣称（抗起球/耐磨/防水等）',
    re: /(抗起球|不易起球|耐磨|防泼水|防水|抗皱|免烫|抗静电|防紫外线|抗菌)/,
    note: '性能宣称需要检测报告支撑，页面文案本身不是证据'
  },
  {
    key: 'visible_defect',
    label: '已存在的损伤迹象',
    re: /(起球|勾丝|开裂|脱层|掉皮|开线|脱线|破损|破洞|掉色|发白|变形|磨损)/,
    note: '这是**当前已经存在**的迹象，与"未来可能发生"必须分开表述'
  }
];

/** 由字段直接得出的结构特征（不依赖文本） */
function structureFromFields(fields) {
  const out = [];
  const knit = /针织|T恤|卫衣|毛衣|针织衫|打底/.test(String(fields.category && fields.category.normalized_value || ''));
  const woven = /牛仔|衬衫|西服|西装|大衣|风衣|休闲裤|西裤/.test(String(fields.category && fields.category.normalized_value || ''));
  if (knit) out.push({ key: 'knit_structure', label: '针织结构', note: '线圈串套，有弹性、易变形', evidence: '品类', source: 'field' });
  if (woven) out.push({ key: 'woven_structure', label: '梭织结构', note: '经纬交织，尺寸稳定、弹性差', evidence: '品类', source: 'field' });

  const fiber = fields.fiber_composition;
  if (fiber && fiber.parsed && Array.isArray(fiber.parsed.items)) {
    const spandex = fiber.parsed.items.filter((i) => /氨纶|弹性/.test(i.fiber)).reduce((s, i) => s + (i.percent || 0), 0);
    if (spandex >= 5) {
      out.push({ key: 'high_spandex', label: `高氨纶（${spandex}%）`, note: '弹性好，但耐热与长期回弹需要关注', evidence: fiber.normalized_value, source: 'field' });
    } else if (spandex > 0) {
      out.push({ key: 'spandex_low', label: `含氨纶（${spandex}%）`, note: '少量弹性纤维，改善活动度', evidence: fiber.normalized_value, source: 'field' });
    }
    const wool = fiber.parsed.items.filter((i) => /羊毛|羊绒/.test(i.fiber)).reduce((s, i) => s + (i.percent || 0), 0);
    if (wool >= 30) out.push({ key: 'wool_rich', label: `羊毛/羊绒 ${wool}%`, note: '动物纤维，缩绒与起球风险与工艺相关', evidence: fiber.normalized_value, source: 'field' });
    const cotton = fiber.parsed.items.filter((i) => i.fiber === '棉').reduce((s, i) => s + (i.percent || 0), 0);
    if (cotton >= 50) out.push({ key: 'cotton_rich', label: `棉 ${cotton}%`, note: '吸湿亲肤，但易皱、缩水与显旧取决于整理工艺', evidence: fiber.normalized_value, source: 'field' });
    const cellulosic = fiber.parsed.items.filter((i) => /粘胶|莫代尔|莱赛尔/.test(i.fiber)).reduce((s, i) => s + (i.percent || 0), 0);
    if (cellulosic >= 30) out.push({ key: 'regenerated_cellulose', label: `再生纤维素 ${cellulosic}%`, note: '湿态强度低，易缩水与变形', evidence: fiber.normalized_value, source: 'field' });
  }

  const weight = fields.fabric_weight;
  if (hasValue(weight) && weight.unit === 'g/m²' && typeof weight.normalized_value === 'number') {
    if (weight.normalized_value >= 300) out.push({ key: 'heavy_fabric', label: `克重较高（${weight.normalized_value} g/m²）`, note: '厚实，但弯折处更易形成硬折痕', evidence: weight.raw_text, source: 'field' });
    if (weight.normalized_value <= 150) out.push({ key: 'light_fabric', label: `克重较低（${weight.normalized_value} g/m²）`, note: '偏薄，耐磨余量较小', evidence: weight.raw_text, source: 'field' });
  }

  if (hasValue(fields.care_instructions)) {
    const care = String(fields.care_instructions.normalized_value || '');
    if (/干洗/.test(care)) out.push({ key: 'dry_clean_only', label: '需干洗', note: '干洗依赖度高的商品，日常维护成本更高', evidence: care, source: 'field' });
    if (/不可漂白|勿漂白/.test(care)) out.push({ key: 'no_bleach', label: '不可漂白', note: '漂白限制通常与染料/纤维稳定性相关', evidence: care, source: 'field' });
  }

  return out;
}

/**
 * 识别特征。
 * @param {{fields: object, rawText?: string}} input
 * @returns {{features: Array<object>, byKey: Object<string, object>, text_hits: Array<object>}}
 */
function detectFeatures(input) {
  const fields = (input && input.fields) || {};
  const rawText = String((input && input.rawText) || '');
  const features = [];
  const byKey = {};

  for (const def of FEATURE_DEFS) {
    const m = rawText.match(def.re);
    if (!m) continue;
    const feat = {
      key: def.key,
      label: def.label,
      note: def.note,
      evidence: String(m[0]),
      source: 'text',
      from_observed_text: true
    };
    features.push(feat);
    byKey[def.key] = feat;
  }

  for (const feat of structureFromFields(fields)) {
    if (byKey[feat.key]) continue;
    features.push(feat);
    byKey[feat.key] = feat;
  }

  return { features, byKey, text_hits: features.filter((f) => f.source === 'text') };
}

module.exports = { detectFeatures, FEATURE_DEFS, structureFromFields };
