/**
 * 标准的人工编辑元数据（不是官方页面字段）。
 *
 * 为什么要单独一个文件：
 * - openstd 的公开页面只给"标准号/名称/状态/日期/主管单位"，**不给**范围条文和条款内容；
 * - 所以凡是"适用范围""管控项目"这类信息，要么来自标准正文（需人工查阅后录入），
 *   要么只能从**标准名称**做保守推断。两者必须分开标注，不能混成"官方核验"。
 *
 * 字段口径：
 * - applicability_by_name: 仅由标准名称推导，applicability_basis = 'standard_name'
 * - key_requirement_topics: 公开科普/标准摘要层面常见的管控项目类别，**不含条款号与限值**，
 *   key_requirements_verified=false 表示未逐条核对正文
 */

'use strict';

const META = {
  'GB 18401': {
    role: '基本安全要求（强制性）',
    applies_to_all_textiles: true,
    applicability_by_name: ['纺织产品（服装、家用纺织品等）'],
    applicability_basis: 'standard_name',
    key_requirement_topics: [
      '甲醛含量',
      'pH 值',
      '色牢度（耐水、耐汗渍、耐干摩擦等）',
      '异味',
      '可分解致癌芳香胺染料'
    ],
    key_requirements_verified: false,
    notes: [
      '产品标注 GB 18401 只说明商家声称执行该强制性标准，不构成"实物已检测合格"的证明。',
      '安全类别（A/B/C 类）与产品用途相关，具体判定需按标准正文与产品实际用途核对。'
    ]
  },
  'GB 31701': {
    role: '婴幼儿及儿童纺织产品安全要求（强制性）',
    applicable_categories: ['童装', '婴幼儿服装'],
    applicability_by_name: ['婴幼儿及儿童纺织产品'],
    applicability_basis: 'standard_name',
    key_requirement_topics: ['绳带要求', '附件抗拉强力', '重金属', '燃烧性能', '基本安全项目'],
    key_requirements_verified: false,
    notes: ['只适用于婴幼儿及儿童纺织产品；成人服装不应引用本标准作为安全类别依据。']
  },
  'GB/T 5296.4': {
    role: '使用说明（标识）要求（推荐性）',
    applies_to_all_textiles: true,
    applicability_by_name: ['纺织品和服装的使用说明'],
    applicability_basis: 'standard_name',
    key_requirement_topics: ['制造者名称与地址', '产品名称', '号型或规格', '纤维成分及含量', '维护方法', '执行的产品标准', '安全类别'],
    key_requirements_verified: false,
    notes: ['这是"标签该怎么写"的标准，不是"衣服质量好不好"的标准。']
  },
  'GB/T 29862': {
    role: '纤维含量标识要求（推荐性）',
    applies_to_all_textiles: true,
    applicability_by_name: ['纺织品纤维含量的标识'],
    applicability_basis: 'standard_name',
    key_requirement_topics: ['纤维名称规范', '含量允差', '标识方式'],
    key_requirements_verified: false,
    notes: ['标注的纤维含量是否真实，需要检测才能确认；本标准规定的是"如何标识"。']
  },
  'GB/T 22849': {
    role: '产品标准（推荐性）',
    applicable_categories: ['T恤'],
    applicability_by_name: ['针织T恤衫'],
    applicability_basis: 'standard_name',
    key_requirement_topics: ['内在质量（如顶破强力、起球、水洗尺寸变化率等）', '外观质量', '标识要求'],
    key_requirements_verified: false,
    notes: ['2024 版已发布，旧版（2014）在此日期后标注的商品需要留意版本。']
  },
  'GB/T 2660': {
    role: '产品标准（推荐性）',
    applicable_categories: ['衬衫'],
    applicability_by_name: ['衬衫'],
    applicability_basis: 'standard_name',
    key_requirement_topics: ['理化性能', '外观质量', '标识'],
    key_requirements_verified: false,
    notes: []
  },
  'GB/T 2664': {
    role: '产品标准（推荐性）',
    applicable_categories: ['西装', '大衣'],
    applicability_by_name: ['男西服、大衣'],
    applicability_basis: 'standard_name',
    key_requirement_topics: ['理化性能', '外观质量', '标识'],
    key_requirements_verified: false,
    notes: ['名称限定"男"，女装对应 GB/T 2665。']
  },
  'GB/T 2665': {
    role: '产品标准（推荐性）',
    applicable_categories: ['西装', '大衣'],
    applicability_by_name: ['女西服、大衣'],
    applicability_basis: 'standard_name',
    key_requirement_topics: ['理化性能', '外观质量', '标识'],
    key_requirements_verified: false,
    notes: ['名称限定"女"，男装对应 GB/T 2664。']
  },
  'GB/T 14272': {
    role: '产品标准（推荐性）',
    applicable_categories: ['羽绒服'],
    applicability_by_name: ['羽绒服装'],
    applicability_basis: 'standard_name',
    key_requirement_topics: ['羽绒品质相关项目', '理化性能', '外观质量', '标识'],
    key_requirements_verified: false,
    notes: ['填充物为羽绒的服装才适用；棉服、夹棉外套不应引用本标准。']
  },
  'GB/T 22700': {
    role: '产品标准（推荐性）',
    applicable_categories: ['牛仔裤', '休闲裤'],
    applicability_by_name: ['水洗整理服装'],
    applicability_basis: 'standard_name',
    key_requirement_topics: ['水洗尺寸变化率', '理化性能', '外观质量'],
    key_requirements_verified: false,
    notes: ['适用于经水洗整理的服装，不是所有牛仔类商品的通用标准。']
  },
  'FZ/T 73020': {
    role: '行业产品标准（推荐性）',
    applicable_categories: ['T恤', '卫衣'],
    applicability_by_name: ['针织休闲服装'],
    applicability_basis: 'standard_name',
    key_requirement_topics: ['未录入（需查阅行业标准正文）'],
    key_requirements_verified: false,
    notes: ['行业标准不在国家标准全文公开系统范围内，状态需在行业标准平台人工核验。']
  },
  'FZ/T 81007': {
    role: '行业产品标准（推荐性）',
    applicable_categories: ['休闲裤', '半身裙'],
    applicability_by_name: ['单、夹服装'],
    applicability_basis: 'standard_name',
    key_requirement_topics: ['未录入（需查阅行业标准正文）'],
    key_requirements_verified: false,
    notes: ['行业标准不在国家标准全文公开系统范围内，状态需在行业标准平台人工核验。']
  }
};

/** 常见品类 → 可能被引用的产品标准（顺序即建议优先度），仅作"该查哪些标准"的提示 */
const CATEGORY_STANDARD_HINTS = {
  T恤: ['GB/T 22849', 'FZ/T 73020', 'GB 18401', 'GB/T 5296.4'],
  衬衫: ['GB/T 2660', 'GB 18401', 'GB/T 5296.4'],
  西装: ['GB/T 2664', 'GB/T 2665', 'GB 18401'],
  大衣: ['GB/T 2664', 'GB/T 2665', 'GB 18401'],
  羽绒服: ['GB/T 14272', 'GB 18401', 'GB/T 5296.4'],
  牛仔裤: ['GB/T 22700', 'GB 18401', 'GB/T 5296.4'],
  休闲裤: ['FZ/T 81007', 'GB/T 22700', 'GB 18401'],
  半身裙: ['FZ/T 81007', 'GB 18401', 'GB/T 5296.4'],
  连衣裙: ['GB 18401', 'GB/T 5296.4', 'GB/T 29862'],
  卫衣: ['FZ/T 73020', 'GB 18401', 'GB/T 5296.4'],
  羊毛衫: ['GB 18401', 'GB/T 5296.4', 'GB/T 29862'],
  风衣: ['FZ/T 81007', 'GB 18401'],
  内衣: ['GB 18401', 'GB/T 5296.4'],
  童装: ['GB 31701', 'GB 18401', 'GB/T 5296.4']
};

module.exports = { META, CATEGORY_STANDARD_HINTS };
