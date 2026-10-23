'use strict';

const storage = require('../../services/storage');
const { getSettings } = require('../../config');
const { DEMO_PRODUCTS } = require('../../core/data/demo.products');
const { dataset } = require('../../core/standards');

Page({
  data: {
    mode: 'local',
    modeLabel: '本地演示模式',
    recent: [],
    demoProducts: [],
    knowsProfile: false,
    standardCount: 0,
    datasetDate: '',
    favoriteCount: 0
  },

  onShow() {
    const settings = getSettings();
    const history = storage.listHistory();
    const profile = storage.getProfile();
    this.setData({
      mode: settings.mode,
      modeLabel: settings.mode === 'remote' ? '后端模式' : '本地演示模式',
      recent: history.slice(0, 3).map((h) => ({
        id: h.id,
        name: h.name,
        category: h.category,
        conclusion: h.conclusion,
        level_label: h.level_label,
        level: h.level,
        demo: h.demo,
        created_at: (h.created_at || '').slice(0, 16).replace('T', ' ')
      })),
      demoProducts: DEMO_PRODUCTS.map((p) => ({ id: p.id, label: p.label, summary: p.summary })),
      knowsProfile: Boolean(profile && (profile.bust || profile.height || profile.usual_size)),
      standardCount: Object.keys(dataset.records || {}).length,
      datasetDate: String(dataset.generated_at || '').slice(0, 10),
      favoriteCount: storage.listFavorites().length
    });
  },

  goCapture(e) {
    const demo = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.demo : '';
    wx.navigateTo({ url: `/pages/capture/capture${demo ? `?demo=${demo}` : ''}` });
  },

  goHistory() {
    wx.navigateTo({ url: '/pages/history/history' });
  },

  goCompare() {
    wx.navigateTo({ url: '/pages/compare/compare' });
  },

  goKnowledge() {
    wx.navigateTo({ url: '/pages/knowledge/knowledge' });
  },

  goStandard() {
    wx.navigateTo({ url: '/pages/standard/standard' });
  },

  goProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' });
  },

  goSettings() {
    wx.navigateTo({ url: '/pages/settings/settings' });
  },

  openResult(e) {
    const id = e.currentTarget.dataset.id;
    const entry = storage.getHistory(id);
    if (!entry) {
      wx.showToast({ title: '记录不存在', icon: 'none' });
      return;
    }
    getApp().globalData.lastResult = { report: entry.report, fields: null, fromHistory: true };
    wx.navigateTo({ url: `/pages/result/result?id=${id}` });
  }
});
