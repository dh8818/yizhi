'use strict';

const storage = require('../../services/storage');

Page({
  data: {
    filter: 'all',
    keyword: '',
    items: [],
    total: 0,
    favoriteCount: 0,
    usageText: '',
    emptyHint: ''
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const all = storage.listHistory();
    const favs = storage.listFavorites();
    const keyword = this.data.keyword.trim();
    let list = this.data.filter === 'fav' ? all.filter((h) => favs.indexOf(h.id) >= 0) : all;
    if (keyword) {
      list = list.filter(
        (h) =>
          String(h.name || '').indexOf(keyword) >= 0 ||
          String(h.category || '').indexOf(keyword) >= 0 ||
          String(h.conclusion || '').indexOf(keyword) >= 0
      );
    }
    const usage = storage.usage();
    this.setData({
      items: list.map((h) => ({
        id: h.id,
        name: h.name,
        category: h.category,
        price: h.price,
        level: h.level,
        level_label: h.level_label,
        conclusion: h.conclusion,
        demo: h.demo,
        created: String(h.created_at || '').slice(0, 16).replace('T', ' '),
        favorite: favs.indexOf(h.id) >= 0,
        doubts: h.doubts || { attention: 0, verify: 0, info: 0 }
      })),
      total: all.length,
      favoriteCount: favs.length,
      usageText: usage.currentSize != null ? `本地约 ${usage.currentSize}KB / 上限 ${usage.limitSize}KB` : '',
      emptyHint:
        this.data.filter === 'fav'
          ? '还没有收藏。分析结果页点"收藏"即可加入这里。'
          : keyword
            ? '没有匹配的记录。'
            : '还没有分析记录。回到首页上传一张商品截图，或用示例商品体验流程。'
    });
  },

  setFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.filter }, () => this.refresh());
  },

  onInput(e) {
    this.setData({ keyword: e.detail.value }, () => this.refresh());
  },

  open(e) {
    const id = e.currentTarget.dataset.id;
    const entry = storage.getHistory(id);
    if (!entry) {
      wx.showToast({ title: '记录不存在', icon: 'none' });
      return;
    }
    getApp().globalData.lastResult = { report: entry.report, fields: entry.fields || null, fromHistory: true };
    wx.navigateTo({ url: `/pages/result/result?id=${id}` });
  },

  toggleFav(e) {
    const id = e.currentTarget.dataset.id;
    storage.toggleFavorite(id);
    this.refresh();
  },

  remove(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.items.find((i) => i.id === id);
    wx.showModal({
      title: '删除这条记录',
      content: `「${item ? item.name : id}」将从本机删除，无法恢复。`,
      confirmText: '删除',
      confirmColor: '#b42318',
      success: (res) => {
        if (!res.confirm) return;
        storage.removeHistory(id);
        const app = getApp();
        app.globalData.compareIds = (app.globalData.compareIds || []).filter((x) => x !== id);
        this.refresh();
        wx.showToast({ title: '已删除', icon: 'none' });
      }
    });
  },

  clearAll() {
    wx.showModal({
      title: '清空全部记录',
      content: '会删除本机所有分析记录与收藏，无法恢复。身材资料不会被删除。',
      confirmText: '清空',
      confirmColor: '#b42318',
      success: (res) => {
        if (!res.confirm) return;
        storage.clearHistory();
        getApp().globalData.compareIds = [];
        this.refresh();
        wx.showToast({ title: '已清空', icon: 'none' });
      }
    });
  },

  goHome() {
    wx.reLaunch({ url: '/pages/index/index' });
  }
});
