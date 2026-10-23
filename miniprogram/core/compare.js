/**
 * comparison-service：2–3 件商品的横向比较。
 *
 * 硬性约束（规范 页面 F）：
 * - 不把"信息完整"的商品判定为"质量最好"，也不把"信息缺失"判定为差；
 * - 最终建议必须挂到用户偏好上，并说明依据；
 * - 价格只在有可靠来源时展示，并且不参与"值不值"的品质判断。
 */

'use strict';

const MAX_ITEMS = 3;

/**
 * @param {{reports: Array<object>, profile?: object}} input
 */
function buildComparison(input) {
  const reports = (input && input.reports) || [];
  const profile = (input && input.profile) || null;
  if (reports.length < 2) {
    return {
      ok: false,
      message: '至少需要两件商品才能比较',
      rows: [],
      suggestion: null
    };
  }
  const items = reports.slice(0, MAX_ITEMS);

  const col = (r) => ({
    id: r.analysis_id,
    name: r.header.product_name,
    category: r.header.category,
    demo: Boolean(r.demo),
    mode: r.mode
  });

  const rows = [
    row('基本信息', items, (r) => [
      text(r.header.product_name || '未识别'),
      text(r.header.category || '未识别', r.header.category ? 'extracted' : 'missing')
    ]),
    row('价格', items, (r) => {
      if (r.header.price == null) return [text('未提供', 'missing', '缺少可靠价格来源，不参与比较')];
      return [text(`¥${r.header.price}`, 'extracted', r.header.price_note || '来自截图，可能随促销变化')];
    }),
    row('纤维成分（商家标注）', items, (r) => {
      const f = r.sections.find((s) => s.key === 'fabric');
      const comp = f && f.composition;
      if (!comp || !comp.value) return [text('未提供', 'missing', '没有成分标注')];
      return [text(comp.value, 'extracted', '标注内容，非实测')];
    }),
    row('克重 / 支数', items, (r) => {
      const w = r.weight || {};
      const y = r.yarn || {};
      const wText = w.status === 'reference_only' ? `${w.value} g/m²（区间内对照）` : w.status === 'missing' ? '未提供' : w.status === 'ambiguous' ? `${w.value == null ? '' : w.value} 口径待确认` : '未评级';
      const yText = y.status === 'missing' ? '未提供' : `${y.value}${y.system ? ' ' + y.system : ''}`;
      return [text(`${wText} / ${yText}`, w.status === 'reference_only' ? 'extracted' : 'missing', w.message || '')];
    }),
    row('执行标准与核验状态', items, (r) => {
      const s = r.standard || {};
      if (!s.appears_in_product) return [text('未标注', 'missing', '截图中没有标准号')];
      const label = s.registry_match ? `${s.normalized_code} · ${s.official_status_label}` : `${s.normalized_code || '原文'} · 未核验`;
      return [text(label, s.registry_match ? 'official_verified' : 'pending_verification', s.registry_match ? `核验于 ${String(s.last_verified_at || '').slice(0, 10)}` : '需人工核实')];
    }),
    row('标准与品类匹配', items, (r) => {
      const s = r.standard || {};
      const map = { likely: '可能匹配', unlikely: '可能不匹配', unknown: '无法判断' };
      return [text(map[s.applicability] || '无法判断', s.applicability === 'likely' ? 'inferred' : s.applicability === 'unlikely' ? 'conflict' : 'pending_verification', s.applicability_reason || '')];
    }),
    row('信息完整度', items, (r) => [
      text(`${r.header.completeness.level_label}（${r.header.completeness.ratio * 100}%）`, r.header.completeness.level === 'high' ? 'ok' : r.header.completeness.level === 'medium' ? 'warn' : 'alert', r.header.completeness.note)
    ]),
    row('主要疑点', items, (r) => {
      const top = (r.doubts || []).slice(0, 3);
      if (!top.length) return [text('暂未发现', 'ok')];
      return top.map((d) => text(d.title, d.severity === 'attention' ? 'alert' : 'warn', d.reason));
    }),
    row('洗护要求', items, (r) => {
      const s = r.sections.find((x) => x.key === 'care');
      if (!s) return [text('未提供', 'missing')];
      const has = s.label_item && s.label_item.value;
      return [text(has ? s.label_item.value : '无标签信息', has ? 'extracted' : 'missing', has ? '来自洗护标签' : '只能给成分层面的通用建议')];
    }),
    row('使用场景建议', items, (r) => [text(sceneAdvice(r, profile), 'inferred', '基于品类与成分的通用推断，不是实测')]),
    row('购买前需确认', items, (r) => {
      const qs = (r.questions || []).slice(0, 3);
      return qs.length ? qs.map((q) => text(q, 'warn')) : [text('无特别事项', 'ok')];
    })
  ];

  const suggestion = buildSuggestion({ items, profile, rows });

  return {
    ok: true,
    items: items.map(col),
    rows,
    suggestion,
    disclaimer:
      '比较表只呈现"已知信息的差异"。信息更完整 ≠ 质量更好；价格更低 ≠ 更值得买。请结合你的使用场景与偏好判断。'
  };
}

function row(label, items, fn) {
  return {
    label,
    cells: items.map((r) => {
      const cells = fn(r) || [];
      return cells.length ? cells : [text('—', 'missing')];
    })
  };
}

function text(value, status, note) {
  return { value: value == null ? '' : String(value), status: status || 'info', note: note || null };
}

function sceneAdvice(report, profile) {
  const category = report.header.category;
  const fibers = (report.sections.find((s) => s.key === 'fabric') || {}).fiber_notes;
  const items = (fibers && fibers.items) || [];
  const names = items.map((i) => i.fiber).join('、');
  const bits = [];
  if (category) bits.push(category);
  if (names) bits.push(names);
  if (/聚酯|锦纶|氨纶/.test(names)) bits.push('偏运动/外套场景');
  if (/棉|亚麻|莫代尔|莱赛尔/.test(names)) bits.push('日常贴身穿着');
  if (/羊毛|羊绒|羽绒|腈纶/.test(names)) bits.push('保暖场景，注意洗护');
  const scenes = Array.isArray(profile && profile.scenes) ? profile.scenes.filter(Boolean) : [];
  if (scenes.length) {
    const matches = scenes.filter((s) => bits.join('').includes(s.slice(0, 2)));
    bits.push(matches.length ? `与你常穿场景（${matches.join('、')}）方向一致` : `与你常穿场景（${scenes.join('、')}）关系不明确`);
  }
  return bits.length ? bits.join('；') : '信息不足，无法给出场景建议';
}

/**
 * 最终建议：只与偏好挂钩，并且明确说明"这不是质量排名"。
 */
function buildSuggestion({ items, profile, rows }) {
  const prefs = profile || {};
  const preferences = [];
  if (prefs.looseness) preferences.push(`宽松程度：${prefs.looseness}`);
  if (prefs.warmth) preferences.push(`保暖偏好：${prefs.warmth}`);
  if (prefs.breathability) preferences.push(`透气偏好：${prefs.breathability}`);
  if (prefs.care) preferences.push(`洗护难度接受度：${prefs.care}`);
  if (Array.isArray(prefs.scenes) && prefs.scenes.length) preferences.push(`常穿场景：${prefs.scenes.join('、')}`);

  const lines = [];
  const perItem = items.map((r) => {
    const fit = r.fit || {};
    const comp = r.header.completeness;
    return {
      id: r.header.product_name,
      fit_status: fit.status,
      fit_match: fit.fit_match || null,
      completeness: comp.level,
      doubts: r.doubt_counts,
      price: r.header.price
    };
  });

  const fitMatched = perItem.filter((p) => p.fit_match === 'match');
  const fitMismatched = perItem.filter((p) => p.fit_match === 'mismatch');
  if (fitMatched.length) lines.push(`${fitMatched.map((p) => `「${p.id}」`).join('、')}的版型方向与你的偏好一致。`);
  if (fitMismatched.length) lines.push(`${fitMismatched.map((p) => `「${p.id}」`).join('、')}的版型方向与偏好相反，谨慎考虑。`);

  const mostComplete = perItem.slice().sort((a, b) => (b.completeness === 'high' ? 1 : 0) - (a.completeness === 'high' ? 1 : 0))[0];
  if (mostComplete) {
    lines.push(
      `信息最完整的是「${mostComplete.id}」（${mostComplete.completeness === 'high' ? '较完整' : mostComplete.completeness === 'medium' ? '部分完整' : '信息不足'}），` +
        '这只说明它的参数更可核实，不代表质量更好。'
    );
  }
  const withStandard = perItem.filter((p) => {
    const r = items.find((x) => x.header.product_name === p.id);
    return r && r.standard && r.standard.registry_match;
  });
  if (withStandard.length) {
    lines.push(`${withStandard.map((p) => `「${p.id}」`).join('、')}的执行标准号已在官方平台核验到状态，其余需自行确认。`);
  }

  const priceKnown = perItem.filter((p) => p.price != null);
  if (priceKnown.length >= 2) {
    const min = priceKnown.slice().sort((a, b) => a.price - b.price)[0];
    lines.push(`价格最低的是「${min.id}」（¥${min.price}），但价格高低与面料品质没有必然关系，不参与质量判断。`);
  }

  lines.push('没有哪一件可以被称为"质量最好"：本系统没有检测数据，也没有同类样本评分。');

  return {
    preferences,
    lines,
    next_step: '建议把每件商品的"购买前需确认"问题发给对应客服，得到答复后再决定。',
    basis: '以上建议依据：版型描述与你偏好的对应关系、信息完整度、标准号核验结果。不包含实测数据。',
    rows_reference: rows.map((r) => r.label)
  };
}

module.exports = { buildComparison, MAX_ITEMS };
