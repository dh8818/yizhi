/**
 * textile-knowledge-service：面料知识查询与"成分 → 特性/洗护提示"的映射。
 *
 * 注意：这里给的是**通用纤维特性**，不是当前单件衣服的实测表现（规范 5.2 第 10 条）。
 * 所有输出都带 disclaimer，展示层必须保留。
 */

'use strict';

const { FIBERS, STRUCTURES, CARE_SYMBOLS, CARE_BY_FIBER, UPDATED_AT } = require('./data/knowledge.data');

const DISCLAIMER = '以下为该纤维/组织的通用特性，不是对这件衣服的实测结论；实际表现受纱线、密度、后整理影响。';

function allEntries() {
  return [
    ...FIBERS.map((f) => ({ ...f, kind: 'fiber' })),
    ...STRUCTURES.map((s) => ({ ...s, kind: 'structure' }))
  ];
}

function findByName(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const entries = allEntries();
  const exact = entries.find((e) => e.name === n || e.name.indexOf(n) >= 0);
  if (exact) return exact;
  const aliasMap = {
    涤纶: '聚酯纤维',
    尼龙: '锦纶',
    天丝: '莱赛尔纤维',
    人造棉: '粘胶纤维',
    人棉: '粘胶纤维',
    桑蚕丝: '蚕丝',
    真丝: '蚕丝',
    棉麻: null
  };
  const alias = aliasMap[n];
  if (alias) return entries.find((e) => e.name.indexOf(alias) >= 0) || null;
  return null;
}

function search(keyword) {
  const q = String(keyword || '').trim().toLowerCase();
  const entries = allEntries();
  if (!q) return entries;
  return entries.filter(
    (e) =>
      e.name.toLowerCase().includes(q) ||
      (e.plain || '').toLowerCase().includes(q) ||
      (e.common_uses || []).some((u) => u.toLowerCase().includes(q))
  );
}

/**
 * 成分列表 → 面料参考区块数据。
 * @param {Array<{fiber:string, percent:number}>} items
 */
function composeFabricNotes(items) {
  const list = Array.isArray(items) ? items : [];
  const notes = [];
  for (const item of list) {
    const entry = findByName(item.fiber);
    if (!entry) {
      notes.push({
        fiber: item.fiber,
        percent: item.percent,
        found: false,
        plain: '知识库暂未收录该纤维，未做特性推断',
        pros: [],
        cons: [],
        care: [],
        needs_review: true
      });
      continue;
    }
    notes.push({
      fiber: entry.name,
      percent: item.percent,
      found: true,
      plain: entry.plain,
      pros: entry.pros,
      cons: entry.cons,
      factors: entry.factors,
      note_on_quality: entry.note_on_quality || null,
      care: CARE_BY_FIBER[entry.name] || [],
      sources: entry.sources,
      needs_review: entry.needs_review
    });
  }

  const dominant = list.slice().sort((a, b) => (b.percent || 0) - (a.percent || 0))[0] || null;
  const hasSpandex = list.some((i) => /氨纶/.test(i.fiber));
  const allNatural = list.length > 0 && list.every((i) => /棉|羊毛|羊绒|蚕丝|亚麻|麻/.test(i.fiber));

  const summary = [];
  if (dominant) {
    summary.push(`主要成分是${dominant.fiber}（${dominant.percent}%），它的特性在很大程度上决定这件衣服的手感与洗护方式。`);
  }
  if (hasSpandex) {
    const pct = list.filter((i) => /氨纶/.test(i.fiber)).reduce((s, i) => s + (i.percent || 0), 0);
    summary.push(`含氨纶 ${pct}%，会有一定弹性；氨纶怕高温，熨烫与烘干温度要控制。`);
  }
  if (allNatural) {
    summary.push('成分均为天然纤维，通常吸湿透气较好，但抗皱与尺寸稳定性一般需要靠后整理或混纺改善。');
  }
  if (list.length >= 3) {
    summary.push('成分较复杂（三种及以上），不同部位/批次的表现可能不一致，建议核对各部件标注。');
  }

  return {
    items: notes,
    summary,
    disclaimer: DISCLAIMER,
    updated_at: UPDATED_AT,
    coverage: {
      known: notes.filter((n) => n.found).length,
      unknown: notes.filter((n) => !n.found).length
    }
  };
}

/** 根据洗护文本/符号给解释 */
function explainCare(careText) {
  const text = String(careText || '');
  const matched = CARE_SYMBOLS.filter((s) => text.includes(s.text));
  const keywords = [
    { re: /不可水洗/, text: '不可水洗' },
    { re: /手洗/, text: '手洗' },
    { re: /干洗/, text: '干洗' },
    { re: /不可漂白|勿漂白/, text: '不可漂白' },
    { re: /低温熨烫|中温熨烫|熨烫/, text: '熨烫' },
    { re: /悬挂晾干|晾干/, text: '晾干' },
    { re: /平摊|平铺/, text: '平摊晾干' },
    { re: /不可烘干/, text: '不可烘干' },
    { re: /分开洗涤|单独洗涤/, text: '分开洗涤' },
    { re: /30|40|30℃|40℃/, text: '水温限制' }
  ];
  const hits = keywords.filter((k) => k.re.test(text)).map((k) => k.text);
  return {
    raw: text || null,
    has_text: Boolean(text.trim()),
    symbols: matched,
    keywords: hits,
    from_label: Boolean(text.trim()),
    note: text.trim()
      ? '以上为标签原文的解释；标签没写的项目，本系统不会替你补。'
      : '当前材料没有洗护标签信息；下面是基于成分的一般参考，不能替代商品标签。'
  };
}

module.exports = { allEntries, findByName, search, composeFabricNotes, explainCare, CARE_SYMBOLS, DISCLAIMER, UPDATED_AT };
