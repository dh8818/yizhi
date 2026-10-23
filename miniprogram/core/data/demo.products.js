/**
 * 演示数据（DEMO）。
 *
 * 这些文本块是**人工构造的模拟 OCR 输出**，不是真实商品截图，也不代表真实品牌。
 * 目的是让"没有模型 API、没有 OCR 服务"的环境也能跑通完整流程。
 * 所有经由这里的分析结果都会带 demo=true，界面必须显示「演示数据」。
 *
 * 三个示例分别覆盖：
 * 1) 信息齐全 + 有营销宣称（触发宣称规则）
 * 2) 只有吊牌/水洗标 + 无克重缺尺码表（触发缺失规则）
 * 3) 宣传页与实物标签互相冲突（触发冲突规则）
 */

'use strict';

const DEMO_PRODUCTS = [
  {
    id: 'demo-tshirt',
    label: '示例A：纯棉宽松短袖T恤（信息较全）',
    category_hint: 'T恤',
    summary: '演示用：宣传页信息较完整，含克重、支数、尺码表，并带"抗菌"宣称',
    images: [
      {
        id: 'demo-tshirt-promo',
        kind: 'promo_screenshot',
        blocks: [
          { text: '【示例数据】纯棉宽松短袖T恤 男女同款', confidence: 0.92 },
          { text: '价格：¥89.00', confidence: 0.95 },
          { text: '品牌：示例品牌', confidence: 0.9 },
          { text: '面料成分：棉 100%', confidence: 0.93 },
          { text: '克重：190g/m²', confidence: 0.88 },
          { text: '纱支：40S 精梳棉', confidence: 0.86 },
          { text: '执行标准：GB/T 22849-2024', confidence: 0.9 },
          { text: '安全类别：B类', confidence: 0.88 },
          { text: '版型：宽松直筒，落肩设计', confidence: 0.85 },
          { text: '可选尺码：S-XXL', confidence: 0.9 },
          { text: '抗菌面料，久穿不臭', confidence: 0.83 }
        ]
      },
      {
        id: 'demo-tshirt-chart',
        kind: 'size_chart',
        blocks: [
          { text: '尺码表（成衣平铺/围度，单位 cm）', confidence: 0.9 },
          { text: 'S 胸围 104 肩宽 46 衣长 66', confidence: 0.85 },
          { text: 'M 胸围 108 肩宽 47 衣长 68', confidence: 0.85 },
          { text: 'L 胸围 112 肩宽 48 衣长 70', confidence: 0.85 },
          { text: 'XL 胸围 116 肩宽 49 衣长 72', confidence: 0.85 }
        ]
      },
      {
        id: 'demo-tshirt-label',
        kind: 'physical_label',
        blocks: [
          { text: '成分：100%棉', confidence: 0.94 },
          { text: '洗涤：可机洗，水温不超过40℃，不可漂白', confidence: 0.9 }
        ]
      }
    ]
  },
  {
    id: 'demo-coat',
    label: '示例B：羊毛混纺大衣（只有标签、缺尺码表）',
    category_hint: '大衣',
    summary: '演示用：信息只来自吊牌与水洗标，缺克重与尺码表',
    images: [
      {
        id: 'demo-coat-label',
        kind: 'physical_label',
        blocks: [
          { text: '【示例数据】女式羊毛混纺大衣', confidence: 0.9 },
          { text: '面料：羊毛 70% 聚酯纤维 30%', confidence: 0.9 },
          { text: '里料：聚酯纤维 100%', confidence: 0.88 },
          { text: '执行标准：GB/T 2665-2017', confidence: 0.9 },
          { text: '安全类别：B类', confidence: 0.88 },
          { text: '洗涤：仅可干洗，不可水洗，不可漂白', confidence: 0.9 },
          { text: '价格：¥899', confidence: 0.86 }
        ]
      },
      {
        id: 'demo-coat-promo',
        kind: 'promo_screenshot',
        blocks: [
          { text: '2024秋冬新款 双面呢大衣 显瘦收腰', confidence: 0.85 },
          { text: '进口面料 意大利工艺', confidence: 0.8 },
          { text: '版型：修身', confidence: 0.82 },
          { text: '可选尺码：S/M/L', confidence: 0.85 }
        ]
      }
    ]
  },
  {
    id: 'demo-jeans',
    label: '示例C：牛仔直筒裤（宣传页与标签冲突）',
    category_hint: '牛仔裤',
    summary: '演示用：宣传页写 98%棉+2%氨纶，吊牌写 100%棉，用于验证冲突处理',
    images: [
      {
        id: 'demo-jeans-promo',
        kind: 'promo_screenshot',
        blocks: [
          { text: '【示例数据】高腰直筒牛仔裤 显瘦百搭', confidence: 0.9 },
          { text: '价格：¥259', confidence: 0.93 },
          { text: '面料成分：棉 98% 氨纶 2%', confidence: 0.88 },
          { text: '克重：360g/m²', confidence: 0.82 },
          { text: '执行标准：GB/T 22700-2016', confidence: 0.85 },
          { text: '版型：直筒', confidence: 0.84 },
          { text: '可选尺码：25-32', confidence: 0.86 },
          { text: '德国机器 原单品质', confidence: 0.8 }
        ]
      },
      {
        id: 'demo-jeans-label',
        kind: 'physical_label',
        blocks: [
          { text: '成分：棉 100%', confidence: 0.9 },
          { text: '执行标准：GB/T 22700-2016', confidence: 0.88 },
          { text: '安全类别：B类', confidence: 0.87 },
          { text: '洗涤：40℃机洗，反面洗涤，不可漂白', confidence: 0.88 }
        ]
      }
    ]
  }
];

function findDemo(id) {
  return DEMO_PRODUCTS.find((p) => p.id === id) || null;
}

/** 演示用个人资料（仅在用户没填任何数据时用于演示，界面上必须标注"演示资料"） */
const DEMO_PROFILE = {
  height: 175,
  weight: 68,
  bust: 96,
  waist: 78,
  shoulder: 44,
  usual_size: 'M',
  looseness: '宽松',
  scenes: ['日常通勤', '周末出行'],
  warmth: '一般',
  breathability: '偏好透气',
  care: '希望好打理',
  demo: true
};

module.exports = { DEMO_PRODUCTS, DEMO_PROFILE, findDemo };
