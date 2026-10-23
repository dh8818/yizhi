/**
 * 图片选择与前置校验（上传前就在客户端拦住明显不合法的文件）。
 *
 * 平台能力边界：
 * - wx.chooseMedia 支持相册与拍照；HEIC 在部分机型会被转码，转不了的按"不支持的格式"提示；
 * - 这里不做裁剪/旋转（小程序端没有内置的图片编辑器），
 *   但提供"移除重选"，并在分析页说明拍摄建议。
 */

'use strict';

const { getSettings } = require('../config');

const IMAGE_KINDS = [
  { value: 'promo_screenshot', label: '商品宣传截图', hint: '商品详情页、参数页' },
  { value: 'physical_label', label: '实物吊牌/水洗标', hint: '吊牌、水洗标、检测报告照片' },
  { value: 'size_chart', label: '尺码表', hint: '详情页里的尺码表截图' },
  { value: 'detail_photo', label: '实物细节', hint: '面料、做工、车线照片' }
];

function extOf(path) {
  const m = String(path || '').match(/\.([a-zA-Z0-9]+)(\?|$)/);
  return m ? m[1].toLowerCase() : '';
}

function chooseImages(count) {
  const settings = getSettings();
  const max = Math.min(count || settings.maxImages, settings.maxImages);
  return new Promise((resolve) => {
    wx.chooseMedia({
      count: max,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success(res) {
        const files = (res.tempFiles || []).map((f, i) => ({
          id: `img-${Date.now()}-${i}`,
          path: f.tempFilePath,
          size: f.size || 0,
          kind: 'promo_screenshot'
        }));
        resolve({ ok: true, files, from: res.type || 'album' });
      },
      fail(err) {
        const msg = String((err && err.errMsg) || '');
        if (/cancel/i.test(msg)) {
          resolve({ ok: true, cancel: true, files: [] });
          return;
        }
        resolve({ ok: false, error: { code: 'CHOOSE_FAILED', message: '无法打开相册/相机，请检查权限设置', detail: msg } });
      }
    });
  });
}

/**
 * 校验一批图片：数量、大小、扩展名。
 * @returns {{accepted: Array, rejected: Array<{file:object, reason:string}>}}
 */
function validateFiles(files) {
  const settings = getSettings();
  const accepted = [];
  const rejected = [];
  const list = Array.isArray(files) ? files : [];
  if (list.length > settings.maxImages) {
    return {
      accepted: [],
      rejected: list.map((f) => ({ file: f, reason: `最多 ${settings.maxImages} 张图片` }))
    };
  }
  for (const f of list) {
    const ext = extOf(f.path);
    if (ext && settings.allowedExt.indexOf(ext) < 0) {
      rejected.push({ file: f, reason: `不支持的格式 .${ext}（支持 ${settings.allowedExt.join('/')}）` });
      continue;
    }
    const mb = (f.size || 0) / (1024 * 1024);
    if (mb > settings.maxFileSizeMB) {
      rejected.push({ file: f, reason: `图片 ${mb.toFixed(1)}MB，超过 ${settings.maxFileSizeMB}MB 上限` });
      continue;
    }
    accepted.push(f);
  }
  return { accepted, rejected };
}

/** 读取文件为 base64（remote 模式上传用） */
function readAsBase64(path) {
  return new Promise((resolve) => {
    try {
      wx.getFileSystemManager().readFile({
        filePath: path,
        encoding: 'base64',
        success(res) {
          resolve({ ok: true, base64: res.data });
        },
        fail(err) {
          resolve({ ok: false, error: { code: 'READ_FAILED', message: '读取图片失败', detail: String(err && err.errMsg) } });
        }
      });
    } catch (err) {
      resolve({ ok: false, error: { code: 'READ_FAILED', message: '读取图片失败', detail: String(err && err.message) } });
    }
  });
}

/** 预览（点击图片放大） */
function previewImage(current, urls) {
  wx.previewImage({ current, urls });
}

module.exports = { IMAGE_KINDS, chooseImages, validateFiles, readAsBase64, previewImage, extOf };
