'use strict';

const standards = require('../../core/standards');
const { CATEGORY_STANDARD_HINTS } = require('../../core/data/standards.meta');

const STATUS_TONE = {
  current: 'ok',
  upcoming: 'warn',
  abolished: 'alert',
  superseded: 'alert',
  under_revision: 'warn',
  unknown: 'muted'
};

Page({
  data: {
    query: '',
    results: [],
    hints: [],
    detail: null,
    dataset: null,
    copied: false,
    categories: Object.keys(CATEGORY_STANDARD_HINTS)
  },

  onLoad(options) {
    this.setData({ dataset: standards.dataset });
    if (options && options.code) {
      this.loadDetail(decodeURIComponent(options.code));
    }
  },

  onInput(e) {
    this.setData({ query: e.detail.value });
  },

  doSearch() {
    const q = this.data.query.trim();
    if (!q) {
      this.setData({ results: [], hints: [] });
      return;
    }
    const res = standards.search(q);
    this.setData({
      results: res.results.map((r) => Object.assign({}, r, { tone: STATUS_TONE[r.status] || 'muted' })),
      hints: res.hints
    });
  },

  quickSearch(e) {
    const q = e.currentTarget.dataset.q;
    this.setData({ query: q }, () => this.doSearch());
  },

  loadDetail(code) {
    const d = standards.detail(code);
    this.setData({
      detail: Object.assign({}, d, { tone: STATUS_TONE[d.record ? d.record.status : 'unknown'] || 'muted' }),
      copied: false
    });
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },

  openResult(e) {
    this.loadDetail(e.currentTarget.dataset.code);
  },

  closeDetail() {
    this.setData({ detail: null });
  },

  copySource() {
    const d = this.data.detail;
    const url = (d && d.official_source_url) || '';
    if (!url) {
      wx.showToast({ title: '没有官方链接', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: url,
      success: () => {
        this.setData({ copied: true });
        wx.showModal({
          title: '链接已复制',
          content: '小程序内不能直接打开外部网站。请把链接粘贴到浏览器，在 openstd.samr.gov.cn 核对标准状态与正文。',
          showCancel: false
        });
      }
    });
  }
});
