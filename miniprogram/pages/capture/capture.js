'use strict';

const upload = require('../../services/upload');
const analysis = require('../../services/analysis');
const storage = require('../../services/storage');
const { getSettings } = require('../../config');
const { DEMO_PRODUCTS } = require('../../core/data/demo.products');

const MANUAL_FIELDS = [
  { key: 'product_name', label: '商品名称', placeholder: '例如：纯棉短袖T恤', type: 'text' },
  { key: 'category', label: '品类', placeholder: '例如：T恤 / 衬衫 / 牛仔裤 / 大衣', type: 'text' },
  { key: 'price', label: '价格（元）', placeholder: '例如：199', type: 'digit' },
  { key: 'fiber_composition', label: '纤维成分', placeholder: '例如：棉 95% 氨纶 5%', type: 'text' },
  { key: 'fabric_weight', label: '面料克重', placeholder: '例如：190g/m²（注意不是单件重量）', type: 'text' },
  { key: 'standard_code', label: '执行标准号', placeholder: '例如：GB/T 22849-2024（原样填写，含年份）', type: 'text' },
  { key: 'safety_category', label: '安全类别', placeholder: '例如：B类', type: 'text' },
  { key: 'size_chart', label: '尺码表', placeholder: '每行一个尺码，例如：M 胸围 108 肩宽 47 衣长 68', type: 'text' },
  { key: 'care_instructions', label: '洗护信息', placeholder: '例如：40℃机洗，不可漂白，仅可干洗', type: 'text' }
];

Page({
  data: {
    mode: 'local',
    images: [],
    kinds: upload.IMAGE_KINDS,
    kindLabels: upload.IMAGE_KINDS.map((k) => k.label),
    demos: DEMO_PRODUCTS.map((p) => ({ id: p.id, label: p.label, summary: p.summary })),
    demoId: '',
    manualFields: MANUAL_FIELDS,
    manual: {},
    showManual: false,
    analyzing: false,
    step: '',
    progress: 0,
    error: null,
    savedProfile: false
  },

  onLoad(options) {
    const settings = getSettings();
    const demoId = options && options.demo ? options.demo : '';
    this.setData({
      mode: settings.mode,
      demoId: demoId || '',
      savedProfile: Boolean(storage.getProfile())
    });
  },

  /* ───────── 图片 ───────── */

  async addImages() {
    const settings = getSettings();
    const remaining = settings.maxImages - this.data.images.length;
    if (remaining <= 0) {
      wx.showToast({ title: `最多 ${settings.maxImages} 张`, icon: 'none' });
      return;
    }
    const res = await upload.chooseImages(remaining);
    if (!res.ok) {
      this.setData({ error: res.error });
      return;
    }
    if (res.cancel) return;

    const { accepted, rejected } = upload.validateFiles(this.data.images.concat(res.files));
    // 已选图片保持原有 id/kind；只有新加入的才用默认来源类型
    const existing = this.data.images;
    const next = existing
      .filter((img) => accepted.some((a) => a.id === img.id || a.path === img.path))
      .concat(
        res.files
          .filter((f) => accepted.some((a) => a.path === f.path))
          .map((f) => ({
            id: f.id,
            path: f.path,
            size: f.size,
            kind: f.kind || 'promo_screenshot',
            kindLabel: this.kindLabelOf(f.kind || 'promo_screenshot')
          }))
      );
    this.setData({
      images: next,
      error: rejected.length
        ? {
            code: 'FILE_REJECTED',
            message: `${rejected.length} 张图片被拒绝`,
            detail: rejected.map((r) => r.reason).join('；')
          }
        : null
    });
  },

  kindLabelOf(kind) {
    const k = upload.IMAGE_KINDS.find((x) => x.value === kind);
    return k ? k.label : kind;
  },

  changeKind(e) {
    const index = Number(e.currentTarget.dataset.index);
    const idx = Number(e.detail.value);
    const kind = upload.IMAGE_KINDS[idx];
    const images = this.data.images.slice();
    images[index] = Object.assign({}, images[index], { kind: kind.value, kindLabel: kind.label });
    this.setData({ images });
  },

  removeImage(e) {
    const index = Number(e.currentTarget.dataset.index);
    const images = this.data.images.slice();
    images.splice(index, 1);
    this.setData({ images });
  },

  previewImage(e) {
    const index = Number(e.currentTarget.dataset.index);
    upload.previewImage(this.data.images[index].path, this.data.images.map((i) => i.path));
  },

  /* ───────── 演示商品 ───────── */

  pickDemo(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ demoId: this.data.demoId === id ? '' : id, error: null });
  },

  /* ───────── 手动填写 ───────── */

  toggleManual() {
    this.setData({ showManual: !this.data.showManual });
  },

  onManualInput(e) {
    const key = e.currentTarget.dataset.key;
    const manual = Object.assign({}, this.data.manual, { [key]: e.detail.value });
    this.setData({ manual });
  },

  /* ───────── 分析 ───────── */

  canAnalyze() {
    const hasManual = Object.keys(this.data.manual).some((k) => String(this.data.manual[k] || '').trim());
    return Boolean(this.data.demoId || hasManual || this.data.mode === 'remote');
  },

  async startAnalyze() {
    if (this.data.analyzing) return;
    if (!this.canAnalyze()) {
      this.setData({
        error: {
          code: 'NEED_INPUT',
          message: '本地模式无法识别图片文字',
          detail: '请选择示例商品、手动填写至少一个字段，或到设置页切换到后端模式。'
        }
      });
      return;
    }

    this.setData({ analyzing: true, error: null, progress: 8, step: '准备图片' });

    const steps = this.data.mode === 'remote'
      ? ['上传图片', '服务端识别中', '提取字段', '核对标准', '生成分析卡']
      : ['准备图片', '按类型分组（演示）', '提取字段', '核对标准', '生成分析卡'];
    let i = 0;
    const timer = setInterval(() => {
      i = Math.min(i + 1, steps.length - 1);
      this.setData({ step: steps[i], progress: Math.min(92, 8 + i * 20) });
    }, 320);

    try {
      const result = await analysis.run({
        images: this.data.images,
        demoId: this.data.demoId || undefined,
        manual: this.data.manual,
        profile: storage.getProfile()
      });
      clearInterval(timer);
      this.setData({ progress: 100, step: '完成' });

      if (!result.ok) {
        this.setData({ analyzing: false, error: result.error, progress: 0, step: '' });
        return;
      }

      getApp().globalData.lastResult = result;
      wx.navigateTo({ url: `/pages/result/result?id=${result.history_id || ''}` });
      this.setData({ analyzing: false, progress: 0, step: '' });
    } catch (err) {
      clearInterval(timer);
      this.setData({
        analyzing: false,
        progress: 0,
        step: '',
        error: { code: 'UNEXPECTED', message: '分析过程中出现异常', detail: String(err && err.message ? err.message : err) }
      });
    }
  },

  goProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' });
  },

  goSettings() {
    wx.navigateTo({ url: '/pages/settings/settings' });
  }
});
