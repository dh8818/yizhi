/**
 * 应用入口。
 *
 * 启动时只做三件事：读设置、读个人资料、检查本地存储版本。
 * 不做网络请求（避免首屏卡住），也不在启动时请求任何权限。
 */

'use strict';

const { getSettings } = require('./config');
const storage = require('./services/storage');

const STORAGE_VERSION = 1;

App({
  globalData: {
    settings: null,
    profile: null,
    // 跨页传递的最近一次分析结果（避免把大对象塞进 URL）
    lastResult: null,
    compareIds: []
  },

  onLaunch() {
    this.globalData.settings = getSettings();
    this.globalData.profile = storage.getProfile();

    try {
      const version = wx.getStorageSync('yizhi:version');
      if (!version) {
        wx.setStorageSync('yizhi:version', STORAGE_VERSION);
      } else if (version !== STORAGE_VERSION) {
        // 未来做数据迁移时在这里处理；当前只记录
        console.log('[yizhi] storage version', version, '→', STORAGE_VERSION);
        wx.setStorageSync('yizhi:version', STORAGE_VERSION);
      }
    } catch (err) {
      console.error('[yizhi] storage init failed', err);
    }
  },

  onShow() {
    // 从设置页返回时刷新设置
    this.globalData.settings = getSettings();
  },

  /** 其他页面读取当前设置 */
  settings() {
    if (!this.globalData.settings) this.globalData.settings = getSettings();
    return this.globalData.settings;
  },

  /** 读取个人资料（可能为空） */
  profile() {
    if (this.globalData.profile === undefined) this.globalData.profile = storage.getProfile();
    return this.globalData.profile;
  },

  setProfile(profile) {
    this.globalData.profile = profile;
  }
});
