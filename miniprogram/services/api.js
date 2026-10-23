/**
 * API 客户端：统一超时、重试、错误结构与后端不可用的降级。
 *
 * 返回约定（全项目一致）：
 *   { ok: true, data }
 *   { ok: false, error: { code, message, retryable, detail } }
 *
 * 注意：本地演示模式**不会**走这里（见 services/analysis.js），
 * 所以即使没有后端，首页与演示流程也能完整跑通。
 */

'use strict';

const { getSettings } = require('../config');

const RETRYABLE_CODES = ['TIMEOUT', 'NETWORK', 'HTTP_502', 'HTTP_503', 'HTTP_504'];

function request({ path, method = 'GET', data, timeout, retries = 1 }) {
  const settings = getSettings();
  const url = `${settings.apiBase.replace(/\/$/, '')}${path}`;
  const timeoutMs = timeout || settings.requestTimeoutMs;

  return new Promise((resolve) => {
    const attempt = (left) => {
      const task = wx.request({
        url,
        method,
        data,
        timeout: timeoutMs,
        header: { 'content-type': 'application/json' },
        success(res) {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            const body = res.data || {};
            if (body.ok === false) {
              resolve({ ok: false, error: normalizeError(body.error) });
              return;
            }
            resolve({ ok: true, data: body.data !== undefined ? body.data : body });
            return;
          }
          const err = {
            code: `HTTP_${res.statusCode}`,
            message: httpMessage(res.statusCode),
            retryable: res.statusCode >= 500,
            detail: typeof res.data === 'string' ? res.data.slice(0, 300) : null
          };
          if (err.retryable && left > 0) {
            setTimeout(() => attempt(left - 1), 600);
            return;
          }
          resolve({ ok: false, error: err });
        },
        fail(e) {
          const isTimeout = /timeout/i.test(String(e && e.errMsg));
          const err = {
            code: isTimeout ? 'TIMEOUT' : 'NETWORK',
            message: isTimeout ? '请求超时，请检查网络或后端服务' : '无法连接后端服务（未启动或地址不正确）',
            retryable: true,
            detail: e && e.errMsg ? String(e.errMsg).slice(0, 200) : null
          };
          if (left > 0) {
            setTimeout(() => attempt(left - 1), 800);
            return;
          }
          resolve({ ok: false, error: err });
        }
      });
      return task;
    };
    attempt(retries);
  });
}

function httpMessage(code) {
  if (code === 400) return '请求参数不合法';
  if (code === 401 || code === 403) return '没有权限访问该接口';
  if (code === 404) return '接口不存在（检查后端版本与地址）';
  if (code === 413) return '图片太大，服务端拒绝接收';
  if (code === 429) return '请求过于频繁，请稍后再试';
  if (code >= 500) return '服务端处理失败';
  return `请求失败（HTTP ${code}）`;
}

function normalizeError(err) {
  if (!err || typeof err !== 'object') return { code: 'UNKNOWN', message: '未知错误', retryable: false, detail: null };
  return {
    code: err.code || 'UNKNOWN',
    message: err.message || '未知错误',
    retryable: err.retryable !== undefined ? Boolean(err.retryable) : RETRYABLE_CODES.indexOf(err.code) >= 0,
    detail: err.detail || null
  };
}

/* ───────────── 具体接口（与 server/server.js 一一对应） ───────────── */

function health() {
  return request({ path: '/api/health', method: 'GET', retries: 0 });
}

function createAnalysis(payload) {
  return request({ path: '/api/analyses', method: 'POST', data: payload, timeout: 60000, retries: 1 });
}

function getAnalysis(id) {
  return request({ path: `/api/analyses/${encodeURIComponent(id)}`, method: 'GET' });
}

function correctField(id, fieldKey, patch) {
  return request({ path: `/api/analyses/${encodeURIComponent(id)}/fields/${encodeURIComponent(fieldKey)}`, method: 'PATCH', data: patch });
}

function lookupStandard(code) {
  return request({ path: `/api/standards/${encodeURIComponent(code)}`, method: 'GET' });
}

function searchStandards(q) {
  return request({ path: `/api/standards?q=${encodeURIComponent(q)}`, method: 'GET' });
}

function knowledgeList(q) {
  return request({ path: `/api/knowledge${q ? `?q=${encodeURIComponent(q)}` : ''}`, method: 'GET' });
}

function saveComparison(payload) {
  return request({ path: '/api/comparisons', method: 'POST', data: payload });
}

function deleteAnalysis(id) {
  return request({ path: `/api/analyses/${encodeURIComponent(id)}`, method: 'DELETE' });
}

module.exports = {
  request,
  health,
  createAnalysis,
  getAnalysis,
  correctField,
  lookupStandard,
  searchStandards,
  knowledgeList,
  saveComparison,
  deleteAnalysis
};
