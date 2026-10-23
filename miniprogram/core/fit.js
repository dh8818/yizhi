/**
 * fit-advisor：版型与尺码建议。
 *
 * 硬性约束（规范 5.2 第 7 条 / 8.1–8.3）：
 * - 缺尺码表时**不给**具体尺码，只说明缺什么；
 * - 人体尺寸与成衣尺寸必须分开表述，不混用；
 * - 建议必须给理由，不能只输出一个 M/L/XL；
 * - 不使用身材评价性语言。
 *
 * 这里的放量（ease）是**经验启发式**，不是标准条款，也不是人体工程学测量结论。
 */

'use strict';

const { FIELD_STATUS, hasValue } = require('./fields');

const EASE = {
  修身: { bust: 4, waist: 2 },
  合体: { bust: 9, waist: 6 },
  宽松: { bust: 14, waist: 10 }
};

const PROFILE_LABELS = {
  height: '身高',
  weight: '体重',
  bust: '胸围',
  waist: '腰围',
  hip: '臀围',
  shoulder: '肩宽',
  usual_size: '常穿尺码',
  looseness: '喜欢的宽松程度'
};

function normalizeLooseness(value) {
  const v = String(value || '');
  if (/修身|紧身|贴身/.test(v)) return '修身';
  if (/宽松|oversize|Oversize|廓形/.test(v)) return '宽松';
  if (/合体|常规|适中/.test(v)) return '合体';
  return null;
}

function chartArray(fields) {
  const f = fields && fields.size_chart;
  if (!f || !hasValue(f)) return [];
  const v = f.normalized_value;
  if (Array.isArray(v)) return v;
  return [];
}

function measurementOf(row, keys) {
  if (!row || !row.measurements) return null;
  for (const k of keys) {
    if (row.measurements[k] != null) return { key: k, value: Number(row.measurements[k]) };
  }
  return null;
}

const BUST_KEYS = ['胸围', '胸宽', 'Bust', 'bust', ' Chest', 'chest'];
const WAIST_KEYS = ['腰围', 'Waist', 'waist'];
const SHOULDER_KEYS = ['肩宽', 'Shoulder', 'shoulder'];
const LENGTH_KEYS = ['衣长', 'Length', 'length'];

/**
 * @param {{fields: object, profile?: object}} input
 * @returns {object}
 */
function assessFit(input) {
  const fields = (input && input.fields) || {};
  const profile = (input && input.profile) || {};
  const chart = chartArray(fields);
  const preview = {
    status: 'unknown',
    recommendation: null,
    recommended_size: null,
    fit_description: hasValue(fields.fit_description) ? fields.fit_description.normalized_value : null,
    size_range: hasValue(fields.size_range) ? fields.size_range.normalized_value : null,
    chart_available: chart.length > 0,
    chart_sizes: chart.map((c) => c.size),
    profile_used: {},
    reasons: [],
    limits: [
      '人体测量值（你的身体）与成衣测量值（衣服平铺/围度）不是同一个口径，不能直接相等',
      '不同品牌同一标码的实际尺寸差异很大，建议以成衣尺寸为准',
      '本建议是启发式推断，不是试穿结果'
    ],
    missing_profile: [],
    missing_product: [],
    questions: []
  };

  const looseness = normalizeLooseness(profile.looseness);
  const bodyBust = profile.bust != null && profile.bust !== '' ? Number(profile.bust) : null;
  const bodyWaist = profile.waist != null && profile.waist !== '' ? Number(profile.waist) : null;
  const bodyShoulder = profile.shoulder != null && profile.shoulder !== '' ? Number(profile.shoulder) : null;

  preview.profile_used = {
    bust: bodyBust,
    waist: bodyWaist,
    shoulder: bodyShoulder,
    usual_size: profile.usual_size || null,
    looseness: looseness || null
  };

  const neededProfile = [];
  if (bodyBust == null) neededProfile.push('胸围');
  if (looseness == null) neededProfile.push('喜欢的宽松程度');
  preview.missing_profile = neededProfile;
  if (!chart.length) preview.missing_product.push('尺码表（成衣尺寸）');

  /* 先给版型描述与偏好的匹配（这个不需要尺码表） */
  const fitDesc = preview.fit_description;
  let fitMatch = 'unknown';
  if (fitDesc && looseness) {
    const sameDirection =
      (looseness === '宽松' && /宽松|oversize|廓形|落肩/i.test(lit(fitDesc))) ||
      (looseness === '修身' && /修身|紧身|贴身/.test(lit(fitDesc))) ||
      (looseness === '合体' && /合体|常规|直筒|正肩/.test(lit(fitDesc)));
    const opposite =
      (looseness === '宽松' && /修身|紧身|贴身/.test(lit(fitDesc))) ||
      (looseness === '修身' && /宽松|oversize|廓形/.test(lit(fitDesc)));
    fitMatch = sameDirection ? 'match' : opposite ? 'mismatch' : 'unclear';
  }
  preview.fit_match = fitMatch;
  if (fitDesc && looseness) {
    preview.reasons.push(
      fitMatch === 'match'
        ? `商品版型描述为「${fitDesc}」，与你偏好的「${looseness}」方向一致。`
        : fitMatch === 'mismatch'
          ? `商品版型描述为「${fitDesc}」，与你偏好的「${looseness}」方向相反，穿着效果可能不符合预期。`
          : `商品版型描述为「${fitDesc}」，与「${looseness}」的对应关系不明确，需要看具体尺寸。`
    );
  }

  /* 没有尺码表：明确拒绝给尺码 */
  if (!chart.length) {
    preview.status = 'chart_missing';
    preview.reasons.push('没有尺码表或成衣尺寸，无法把标码对应到具体厘米数，因此不给出确定尺码。');
    preview.questions.push('能提供各尺码的成衣平铺尺寸（肩宽/胸围/衣长）吗？');
    preview.summary =
      `目前只能根据版型描述判断风格倾向${fitDesc ? `（${fitDesc}）` : ''}，` +
      '缺少成衣尺寸时给出具体尺码并不可靠。建议先核对肩宽、胸围与衣长。';
    return preview;
  }

  /* 没有个人数据：给"怎么读尺码表"，不给尺码 */
  if (bodyBust == null || !looseness) {
    preview.status = 'profile_incomplete';
    preview.reasons.push(
      `缺少你的${neededProfile.join('、')}，系统不会推测你的身体数据；下面只解释这张尺码表怎么读。`
    );
    const bustRow = chart.find((c) => measurementOf(c, BUST_KEYS));
    if (bustRow) {
      const m = measurementOf(bustRow, BUST_KEYS);
      preview.reasons.push(`例如「${bustRow.size}」码的成衣${m.key}为 ${m.value} cm，你可以用自己的常穿成衣尺寸对照。`);
    }
    preview.summary = '补充胸围与偏好后可以给出建议尺码；在此之前只做尺码表解读。';
    return preview;
  }

  /* 两个输入都有：按放量选择 */
  const ease = EASE[looseness];
  const targetBust = bodyBust + ease.bust;
  const rows = chart
    .map((c) => {
      const b = measurementOf(c, BUST_KEYS);
      const w = measurementOf(c, WAIST_KEYS);
      const s = measurementOf(c, SHOULDER_KEYS);
      const l = measurementOf(c, LENGTH_KEYS);
      return { size: c.size, bust: b ? b.value : null, waist: w ? w.value : null, shoulder: s ? s.value : null, length: l ? l.value : null };
    })
    .filter((r) => r.bust != null);

  if (!rows.length) {
    preview.status = 'chart_missing';
    preview.reasons.push('尺码表里没有可靠的胸围数值（可能列错位），无法计算。');
    preview.questions.push('尺码表能单独发一张清晰的胸围列吗？');
    preview.summary = '尺码表缺少胸围数值，无法给出建议尺码。';
    return preview;
  }

  const sorted = rows.slice().sort((a, b) => a.bust - b.bust);
  let pick = sorted.find((r) => r.bust >= targetBust) || null;
  let basis = 'body_bust_plus_ease';
  if (!pick) {
    pick = sorted[sorted.length - 1];
    basis = 'largest_available';
  }

  preview.recommendation = {
    size: pick.size,
    target_bust: Math.round(targetBust * 10) / 10,
    garment_bust: pick.bust,
    ease_applied: ease.bust,
    body_bust: bodyBust,
    basis,
    row: pick
  };
  preview.recommended_size = pick.size;
  preview.status = 'heuristic';

  preview.reasons.push(
    `你的胸围 ${bodyBust} cm，加上「${looseness}」偏好对应的经验放量 ${ease.bust} cm，目标是成衣胸围约 ${Math.round(targetBust)} cm。`
  );
  preview.reasons.push(`尺码表中「${pick.size}」的成衣胸围为 ${pick.bust} cm，是第一个不小于目标值的尺码。`);
  if (pick.shoulder != null && bodyShoulder != null) {
    const delta = Math.round((pick.shoulder - bodyShoulder) * 10) / 10;
    preview.reasons.push(
      `肩宽对照：成衣 ${pick.shoulder} cm，你的肩宽 ${bodyShoulder} cm，差 ${delta > 0 ? '+' : ''}${delta} cm` +
        (Math.abs(delta) > 4 ? '；差值较大，肩线位置可能明显偏移，建议再确认。' : '。')
    );
  }
  if (pick.length != null) preview.reasons.push(`「${pick.size}」的成衣衣长为 ${pick.length} cm。`);
  if (profile.usual_size) {
    if (String(profile.usual_size).toUpperCase() === String(pick.size).toUpperCase()) {
      preview.reasons.push(`与你常穿的「${profile.usual_size}」一致，风险较低。`);
    } else {
      preview.reasons.push(
        `与你常穿的「${profile.usual_size}」不同，这是按尺码表算出来的结果；若你平时习惯在某品牌买大一码，请以成衣尺寸为准。`
      );
    }
  }
  if (basis === 'largest_available') {
    preview.reasons.push('按目标胸围计算已超出尺码表最大码，最大码可能仍偏紧。');
  }

  preview.summary = `建议参考「${pick.size}」码：成衣胸围 ${pick.bust} cm，接近你需要的 ${Math.round(targetBust)} cm。这是按尺码表与你的偏好做的经验推算，建议下单前再核对一遍肩宽与衣长。`;
  preview.limits.push('放量数值是经验启发式（修身/合体/宽松分别 4/9/14 cm），不是标准规定，也未考虑面料弹性与版型差异');

  if (hasValue(fields.elasticity) === false && /氨纶|弹性/.test(JSON.stringify(fields.fiber_composition || {}))) {
    preview.reasons.push('成分里含弹性纤维，实际可穿范围可能比尺码表更宽；但具体回弹量需要看面料参数。');
  }

  return preview;
}

function lit(v) {
  return v == null ? '' : String(v);
}

module.exports = { assessFit, EASE, PROFILE_LABELS, normalizeLooseness };
