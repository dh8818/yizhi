'use strict';

const storage = require('../../services/storage');
const { buildComparison } = require('../../core/compare');

Page({
  data: {
    candidates: [],
    selected: [],
    result: null,
    error: null,
    profileNote: ''
  },

  onShow() {
    const history = storage.listHistory();
    const selected = (getApp().globalData.compareIds || []).filter((id) => history.some((h) => h.id === id)).slice(0, 3);
    const profile = storage.getProfile();
    this.setData({
      candidates: history.map((h) => ({
        id: h.id,
        name: h.name,
        category: h.category,
        price: h.price,
        level_label: h.level_label,
        demo: h.demo,
        created: String(h.created_at || '').slice(0, 10)
      })),
      selected,
      profileNote: profile
        ? `已使用你的偏好：${[profile.looseness, profile.warmth, (profile.scenes || []).join('/')].filter(Boolean).join(' · ')}`
        : '未填写个人偏好：对比只呈现信息差异，不判断版型适配'
    });
    if (selected.length >= 2) this.build(true);
  },

  toggle(e) {
    const id = e.currentTarget.dataset.id;
    const selected = this.data.selected.slice();
    const idx = selected.indexOf(id);
    if (idx >= 0) {
      selected.splice(idx, 1);
    } else {
      if (selected.length >= 3) {
        wx.showToast({ title: '最多比较 3 件', icon: 'none' });
        return;
      }
      selected.push(id);
    }
    getApp().globalData.compareIds = selected;
    this.setData({ selected, result: null, error: null });
  },

  build(silent) {
    if (this.data.selected.length < 2) {
      if (!silent) wx.showToast({ title: '至少选择 2 件', icon: 'none' });
      return;
    }
    const reports = [];
    for (const id of this.data.selected) {
      const entry = storage.getHistory(id);
      if (!entry || !entry.report) {
        this.setData({ error: '有一件商品的分析记录已被删除，请重新选择。' });
        return;
      }
      reports.push(entry.report);
    }
    const profile = storage.getProfile();
    const result = buildComparison({ reports, profile });
    if (!result.ok) {
      this.setData({ error: result.message });
      return;
    }
    // 为模板准备带稳定 key 的结构（小程序 wx:key 不接受数组索引空值）
    const view = Object.assign({}, result, {
      rows: result.rows.map((r) => ({
        label: r.label,
        cells: r.cells.map((lines, i) => ({ i: `c${i}`, lines }))
      }))
    });
    this.setData({ result: view, error: null });
  },

  removeFromCompare(e) {
    this.toggle(e);
  },

  goHistory() {
    wx.navigateTo({ url: '/pages/history/history' });
  },

  copySuggestion() {
    const r = this.data.result;
    if (!r) return;
    const text = [].concat(r.suggestion.lines, ['', r.suggestion.next_step, r.suggestion.basis]).join('\n');
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制对比结论', icon: 'none' })
    });
  }
});
