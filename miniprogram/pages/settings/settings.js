'use strict';

const { getSettings, saveSettings, resetSettings, DEFAULTS } = require('../../config');
const storage = require('../../services/storage');
const api = require('../../services/api');
const { dataset } = require('../../core/standards');
const knowledge = require('../../core/knowledge');

const APP_VERSION = '0.1.0';

Page({
  data: {
    mode: 'local',
    apiBase: '',
    defaults: DEFAULTS,
    health: null,
    checking: false,
    feedback: '',
    privacyOpen: false,
    modelOpen: false,
    version: APP_VERSION,
    datasetInfo: '',
    knowledgeUpdated: knowledge.UPDATED_AT,
    usageText: '',
    historyCount: 0,
    profileSaved: false
  },

  onShow() {
    const s = getSettings();
    const usage = storage.usage();
    this.setData({
      mode: s.mode,
      apiBase: s.apiBase,
      datasetInfo: `${Object.keys(dataset.records || {}).length} 条标准 · 核验于 ${String(dataset.generated_at || '').slice(0, 10)}`,
      usageText: usage.currentSize != null ? `${usage.currentSize}KB / ${usage.limitSize}KB` : '未知',
      historyCount: storage.listHistory().length,
      profileSaved: Boolean(storage.getProfile())
    });
  },

  setMode(e) {
    const mode = e.currentTarget.dataset.mode;
    saveSettings({ mode });
    getApp().globalData.settings = getSettings();
    this.setData({ mode, health: null });
    wx.showToast({ title: mode === 'remote' ? '已切换到后端模式' : '已切换到本地模式', icon: 'none' });
  },

  onApiInput(e) {
    this.setData({ apiBase: e.detail.value });
  },

  saveApi() {
    const base = String(this.data.apiBase || '').trim();
    if (!/^https?:\/\//.test(base)) {
      wx.showToast({ title: '地址需以 http:// 或 https:// 开头', icon: 'none' });
      return;
    }
    saveSettings({ apiBase: base });
    getApp().globalData.settings = getSettings();
    this.setData({ health: null });
    wx.showToast({ title: '已保存', icon: 'success' });
  },

  async checkHealth() {
    if (this.data.checking) return;
    this.setData({ checking: true, health: null });
    const res = await api.health();
    this.setData({
      checking: false,
      health: res.ok
        ? { ok: true, text: `连接成功：${res.data.service || 'yizhi-api'} v${res.data.version || '?'}，模式 ${res.data.mode || '?'}` }
        : { ok: false, text: `${res.error.message}${res.error.detail ? '（' + res.error.detail + '）' : ''}` }
    });
  },

  resetApi() {
    resetSettings();
    const s = getSettings();
    this.setData({ mode: s.mode, apiBase: s.apiBase, health: null });
    wx.showToast({ title: '已恢复默认设置', icon: 'none' });
  },

  toggle(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ [key]: !this.data[key] });
  },

  onFeedback(e) {
    this.setData({ feedback: e.detail.value });
  },

  submitFeedback() {
    const text = String(this.data.feedback || '').trim();
    if (!text) {
      wx.showToast({ title: '请先写点内容', icon: 'none' });
      return;
    }
    storage.saveFeedback(text);
    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showModal({
          title: '反馈已保存到本机',
          content: '当前没有接入反馈服务器，所以已把内容复制到剪贴板。你可以粘贴到项目仓库的 issue 或直接发给开发者。',
          showCancel: false
        });
      }
    });
    this.setData({ feedback: '' });
  },

  clearHistory() {
    wx.showModal({
      title: '清空分析记录',
      content: '会删除本机的历史记录与收藏（共 ' + this.data.historyCount + ' 条），无法恢复。',
      confirmText: '清空',
      confirmColor: '#b42318',
      success: (res) => {
        if (!res.confirm) return;
        storage.clearHistory();
        this.onShow();
        wx.showToast({ title: '已清空', icon: 'none' });
      }
    });
  },

  clearProfile() {
    wx.showModal({
      title: '删除身材资料',
      content: '会删除本机保存的身高、围度与偏好数据。',
      confirmText: '删除',
      confirmColor: '#b42318',
      success: (res) => {
        if (!res.confirm) return;
        storage.clearProfile();
        getApp().setProfile(null);
        this.onShow();
        wx.showToast({ title: '已删除', icon: 'none' });
      }
    });
  },

  clearAll() {
    wx.showModal({
      title: '删除我的全部数据',
      content: '会清空本机的一切：分析记录、收藏、身材资料、设置与反馈草稿。无法恢复。',
      confirmText: '全部删除',
      confirmColor: '#b42318',
      success: (res) => {
        if (!res.confirm) return;
        storage.clearAll();
        const s = getSettings();
        getApp().globalData.compareIds = [];
        getApp().setProfile(null);
        this.onShow();
        this.setData({ mode: s.mode, apiBase: s.apiBase });
        wx.showToast({ title: '本机数据已清空', icon: 'none' });
      }
    });
  },

  copyPolicy() {
    const text = [
      '衣知 · 数据处理说明（v' + APP_VERSION + '）',
      '1. 我们收集什么：你主动上传的商品截图、你手动填写的字段、可选的身材与偏好数据、分析记录。',
      '2. 本地模式：以上数据只保存在本机小程序 storage，不上传任何服务器。',
      '3. 后端模式：图片会发送到你配置的服务端地址；服务端是否调用第三方视觉模型取决于服务端配置（见 .env）。',
      '4. 我们不会把你的图片用于训练模型，也不会在未告知的情况下转交第三方。',
      '5. 你可以随时在设置页删除单条记录、全部记录或身材资料。',
      '6. 本应用不提供账号体系，不做跨设备同步。',
      '7. 分析结果属于信息整理与规则提示，不是检测报告，不构成质量、真伪或合规判定。'
    ].join('\n');
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '说明已复制', icon: 'none' })
    });
  }
});
