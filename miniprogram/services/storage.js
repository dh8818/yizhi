/**
 * 本地持久化（wx storage）——只存本地，不假装同步到云端。
 *
 * 键空间：
 *   yizhi:settings     运行设置
 *   yizhi:profile      身材与偏好（用户自愿填写）
 *   yizhi:history      分析历史（最多 30 条，按时间倒序）
 *   yizhi:favorites    收藏的分析 id 列表
 *   yizhi:feedback     本地保存的反馈草稿（可选）
 */

'use strict';

const KEY = {
  SETTINGS: 'yizhi:settings',
  PROFILE: 'yizhi:profile',
  HISTORY: 'yizhi:history',
  FAVORITES: 'yizhi:favorites',
  FEEDBACK: 'yizhi:feedback'
};

const MAX_HISTORY = 30;

function read(key, fallback) {
  try {
    const v = wx.getStorageSync(key);
    return v === '' || v == null ? fallback : v;
  } catch (err) {
    console.error('[storage] read failed', key, err);
    return fallback;
  }
}

function write(key, value) {
  try {
    wx.setStorageSync(key, value);
    return true;
  } catch (err) {
    console.error('[storage] write failed', key, err);
    return false;
  }
}

function remove(key) {
  try {
    wx.removeStorageSync(key);
    return true;
  } catch (err) {
    return false;
  }
}

/* ───────────────── 历史 ───────────────── */

function listHistory() {
  const list = read(KEY.HISTORY, []);
  return Array.isArray(list) ? list : [];
}

function getHistory(id) {
  return listHistory().find((h) => h.id === id) || null;
}

/**
 * 保存一次分析。为了不突破 storage 上限，只保留报告的必要字段。
 * @param {object} report buildReport 的输出
 * @param {object} extra { images: [{id, kind}] }
 */
function saveHistory(report, extra) {
  const entry = {
    id: report.analysis_id || `local-${Date.now()}`,
    created_at: report.created_at || new Date().toISOString(),
    name: (report.header && report.header.product_name) || '未命名商品',
    category: (report.header && report.header.category) || null,
    price: (report.header && report.header.price) || null,
    level: report.header && report.header.completeness ? report.header.completeness.level : null,
    level_label: report.header && report.header.completeness ? report.header.completeness.level_label : null,
    conclusion: report.header ? report.header.conclusion : '',
    doubts: report.doubt_counts || null,
    demo: Boolean(report.demo),
    mode: report.mode || 'local',
    images: ((extra && extra.images) || (report.header && report.header.images) || []).map((i) => ({ id: i.id, kind: i.kind, preview: i.preview || null })),
    fields: (extra && extra.fields) || null,
    report
  };
  const list = listHistory().filter((h) => h.id !== entry.id);
  list.unshift(entry);
  const trimmed = list.slice(0, MAX_HISTORY);
  write(KEY.HISTORY, trimmed);
  return entry;
}

function removeHistory(id) {
  const next = listHistory().filter((h) => h.id !== id);
  write(KEY.HISTORY, next);
  const favs = listFavorites().filter((f) => f !== id);
  write(KEY.FAVORITES, favs);
  return next;
}

function clearHistory() {
  write(KEY.HISTORY, []);
  write(KEY.FAVORITES, []);
}

/* ───────────────── 收藏 ───────────────── */

function listFavorites() {
  const list = read(KEY.FAVORITES, []);
  return Array.isArray(list) ? list : [];
}

function isFavorite(id) {
  return listFavorites().indexOf(id) >= 0;
}

function toggleFavorite(id) {
  const list = listFavorites();
  const idx = list.indexOf(id);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(id);
  write(KEY.FAVORITES, list);
  return idx < 0;
}

function listFavoriteReports() {
  const ids = listFavorites();
  return listHistory().filter((h) => ids.indexOf(h.id) >= 0);
}

/* ───────────────── 个人资料 ───────────────── */

function getProfile() {
  const p = read(KEY.PROFILE, null);
  return p && typeof p === 'object' ? p : null;
}

function saveProfile(profile) {
  const next = Object.assign({}, profile, { updated_at: new Date().toISOString() });
  write(KEY.PROFILE, next);
  return next;
}

function clearProfile() {
  remove(KEY.PROFILE);
}

/* ───────────────── 其它 ───────────────── */

function saveFeedback(text) {
  const entry = { text, created_at: new Date().toISOString() };
  const list = read(KEY.FEEDBACK, []);
  const next = Array.isArray(list) ? list.concat([entry]).slice(-20) : [entry];
  write(KEY.FEEDBACK, next);
  return entry;
}

function listFeedback() {
  const list = read(KEY.FEEDBACK, []);
  return Array.isArray(list) ? list : [];
}

function usage() {
  try {
    const info = wx.getStorageInfoSync();
    return { currentSize: info.currentSize, limitSize: info.limitSize };
  } catch (err) {
    return { currentSize: null, limitSize: null };
  }
}

/** 一键清除本地数据（设置页"删除我的数据"） */
function clearAll() {
  Object.values(KEY).forEach((k) => remove(k));
}

module.exports = {
  KEY,
  MAX_HISTORY,
  listHistory,
  getHistory,
  saveHistory,
  removeHistory,
  clearHistory,
  listFavorites,
  isFavorite,
  toggleFavorite,
  listFavoriteReports,
  getProfile,
  saveProfile,
  clearProfile,
  saveFeedback,
  listFeedback,
  usage,
  clearAll
};
