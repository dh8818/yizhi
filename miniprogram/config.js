/**
 * 运行配置。
 *
 * 小程序端没有 process.env，所以配置有两层：
 * 1) 这里的默认值（随包发布，**不含任何密钥**）；
 * 2) 运行时覆盖（storage: yizhi:settings），可在"设置"页切换模式和后端地址。
 *
 * 密钥只存在于服务端 .env，永远不进小程序包。
 */

'use strict';

const DEFAULTS = {
  // local = 纯本地演示/规则分析；remote = 走 server/ 的 API（后端再决定 OCR/模型走真实还是模拟）
  mode: 'local',
  apiBase: 'http://127.0.0.1:8787',
  maxImages: 9,
  maxFileSizeMB: 5,
  allowedExt: ['jpg', 'jpeg', 'png', 'webp'],
  requestTimeoutMs: 30000,
  // 模型能力声明：小程序端不做视觉推理，只负责上传与展示
  clientVision: false
};

const STORAGE_KEY = 'yizhi:settings';

function getSettings() {
  let override = {};
  try {
    override = wx.getStorageSync(STORAGE_KEY) || {};
  } catch (err) {
    override = {};
  }
  return Object.assign({}, DEFAULTS, override);
}

function saveSettings(patch) {
  const next = Object.assign({}, getSettings(), patch || {});
  wx.setStorageSync(STORAGE_KEY, next);
  return next;
}

function resetSettings() {
  try {
    wx.removeStorageSync(STORAGE_KEY);
  } catch (err) {
    // ignore
  }
  return Object.assign({}, DEFAULTS);
}

module.exports = { DEFAULTS, getSettings, saveSettings, resetSettings, STORAGE_KEY };
