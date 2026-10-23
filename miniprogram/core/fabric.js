/**
 * fabric-reference：克重/支数的"同类参考"评估。
 *
 * 这一层刻意**不给高/中/低品质评级**：
 * - 克重参考区间来自公开资料，不是本项目抽样实测，因此只能标 reference_only；
 * - 支数连参考区间都不给（不同体系不可比、样本不足），只做"已知信息 + 口径提醒"。
 * 规范 7.1/7.2/7.3/7.5 的要求都落在这里。
 */

'use strict';

/**
 * 参考区间表。samples=0 表示本项目没有实测样本，只有公开资料区间。
 * 更新时必须同步 updated_at。
 */
const WEIGHT_REFERENCES = {
  T恤: {
    label: '短袖T恤（针织，单面/双面）',
    min: 140,
    max: 240,
    typical: '150–200',
    samples: 0,
    source: '公开纺织/电商科普中的常见克重描述区间',
    updated_at: '2026-10-20'
  },
  卫衣: {
    label: '卫衣（针织，抓绒/毛圈）',
    min: 240,
    max: 420,
    typical: '280–380',
    samples: 0,
    source: '公开纺织/电商科普中的常见克重描述区间',
    updated_at: '2026-10-20'
  },
  衬衫: {
    label: '衬衫（梭织）',
    min: 100,
    max: 180,
    typical: '110–140',
    samples: 0,
    source: '公开纺织/电商科普中的常见克重描述区间',
    updated_at: '2026-10-20'
  },
  牛仔裤: {
    label: '牛仔（梭织，斜纹）',
    min: 280,
    max: 480,
    typical: '320–400',
    samples: 0,
    source: '公开纺织/电商科普中的常见克重描述区间',
    updated_at: '2026-10-20'
  }
};

/**
 * @param {{category?:string, weightField?:object, garmentWeightField?:object}} input
 */
function assessWeight(input) {
  const { category, weightField, garmentWeightField } = input || {};
  const base = {
    status: 'insufficient_reference',
    value: null,
    unit: null,
    category: category || null,
    reference: null,
    position: null,
    message: '',
    limits: [
      '克重是面料单位面积质量，不能直接等同"厚不厚""暖不暖"；组织与纤维同样重要',
      '不同品类的克重不可横向比较（短袖T恤与羊毛大衣没有可比性）'
    ]
  };

  if (garmentWeightField && garmentWeightField.normalized_value != null && !weightField) {
    return {
      ...base,
      status: 'incomparable',
      value: garmentWeightField.normalized_value,
      unit: garmentWeightField.unit,
      message: '截图里只有"成衣重量"，没有"面料克重"，两者量纲不同，不能换算也不做评级',
      reference: null
    };
  }

  if (!weightField || weightField.normalized_value == null) {
    return {
      ...base,
      status: 'missing',
      message: '当前材料没有提供面料克重，系统不会估算具体数值；可向商家索取克重或面料参数'
    };
  }

  const value = Number(weightField.normalized_value);
  const unit = weightField.unit;
  if (weightField.status === 'pending_verification' || !unit) {
    return {
      ...base,
      status: 'ambiguous',
      value,
      unit: unit || null,
      message: weightField.evidence_note || '数值单位不明确，无法判断是 g/m² 还是成衣克重'
    };
  }
  if (unit !== 'g/m²') {
    return {
      ...base,
      status: 'incomparable',
      value,
      unit,
      message: '这不是面料单位面积质量（g/m²），不参与同类克重比较'
    };
  }

  const ref = WEIGHT_REFERENCES[category];
  if (!ref) {
    return {
      ...base,
      status: 'insufficient_reference',
      value,
      unit,
      message: `已记录克重 ${value} g/m²，但「${category || '该品类'}」没有可用的同类参考区间，因此不给评级`,
      reference: null
    };
  }

  let position = 'in_range';
  if (value < ref.min) position = 'below_range';
  else if (value > ref.max) position = 'above_range';

  return {
    ...base,
    status: 'reference_only',
    value,
    unit,
    position,
    reference: {
      label: ref.label,
      min: ref.min,
      max: ref.max,
      typical: ref.typical,
      samples: ref.samples,
      source: ref.source,
      updated_at: ref.updated_at
    },
    message:
      `已记录克重 ${value} g/m²，落在公开资料给出的 ${ref.label} 参考区间 ${ref.min}–${ref.max} g/m² 之${position === 'in_range' ? '内' : position === 'below_range' ? '下' : '上'}。` +
      '这是区间对照，不是品质评级（本项目没有实测样本）。',
    limits: [
      ...base.limits,
      '参考区间 samples=0，仅来自公开资料，未经本项目抽样验证',
      '未考虑纤维种类、组织密度与后整理，不能据此判断保暖或耐用'
    ]
  };
}

/**
 * 支数：只做"已知/口径"说明，绝不给高低。
 */
function assessYarnCount(yarnField) {
  const out = {
    status: 'insufficient_reference',
    value: null,
    system: null,
    message: '',
    limits: [
      '支数体系（英制 S / 公制 Nm / 特数 tex / 旦数 D）不同，数值不可直接排名',
      '支数高只说明纱线更细，不代表更耐穿或更好；细纱更柔软但强度与起球表现取决于原料与捻度',
      '本项目没有同类样本数据库，不提供支数评级'
    ]
  };
  if (!yarnField || yarnField.normalized_value == null) {
    return { ...out, status: 'missing', message: '当前材料没有支数信息，系统不做推测' };
  }
  const system = /英制|\(S\)/.test(String(yarnField.normalized_value)) ? '英制支数(S)' : /Nm/.test(String(yarnField.normalized_value)) ? '公制支数(Nm)' : /tex/.test(String(yarnField.normalized_value)) ? '特数(tex)' : /\(D\)/.test(String(yarnField.normalized_value)) ? '旦数(D)' : null;
  return {
    ...out,
    status: system ? 'known_unrated' : 'ambiguous_system',
    value: yarnField.normalized_value,
    system,
    message: system
      ? `已记录 ${yarnField.normalized_value}；仅有口径信息，不做品质评级`
      : '支数体系不明，不同体系不可比，需向商家确认口径'
  };
}

module.exports = { assessWeight, assessYarnCount, WEIGHT_REFERENCES };
