'use strict';

const storage = require('../../services/storage');
const analysis = require('../../services/analysis');
const { SEVERITY_ORDER } = require('../../core/rules');
const { getSettings } = require('../../config');

const SEVERITY_META = {
  attention: { tone: 'alert', label: '需重点核实' },
  verify: { tone: 'warn', label: '建议确认' },
  info: { tone: 'muted', label: '提示' }
};

Page({
  data: {
    ready: false,
    report: null,
    view: null,
    fields: null,
    isFavorite: false,
    demo: false,
    demoLabel: '',
    inCompare: false,
    expanded: { evidence: false, limits: true, questions: true },
    error: null
  },

  onLoad(options) {
    const app = getApp();
    const cached = app.globalData.lastResult;
    const id = options && options.id;
    let report = null;
    let fields = null;
    let fromHistory = false;

    if (cached && cached.report && (!id || !cached.report.analysis_id || cached.report.analysis_id === id || cached.fromHistory)) {
      report = cached.report;
      fields = cached.fields || null;
      fromHistory = Boolean(cached.fromHistory);
    }
    if (!report && id) {
      const entry = storage.getHistory(id);
      if (entry) {
        report = entry.report;
        fields = entry.fields || null;
        fromHistory = true;
      }
    }
    if (!report) {
      this.setData({ ready: false, error: '没有找到这次分析结果（可能已被删除）。' });
      return;
    }

    this.hydrate(report, fields, fromHistory);
  },

  hydrate(report, fields, fromHistory) {
    const settings = getSettings();
    const view = this.buildView(report, settings.mode);
    const id = report.analysis_id || '';
    this.setData({
      ready: true,
      report,
      view,
      fields: fields || null,
      isFavorite: id ? storage.isFavorite(id) : false,
      demo: Boolean(report.demo),
      demoLabel: report.demo_label || report.demo_note || '',
      inCompare: (getApp().globalData.compareIds || []).indexOf(id) >= 0,
      error: null
    });
    wx.setNavigationBarTitle({ title: view.category ? `分析卡 · ${view.category}` : '分析卡' });
    if (fromHistory) {
      getApp().globalData.lastResult = null;
    }
  },

  buildView(report, mode) {
    const h = report.header || {};
    const comp = h.completeness || {};
    const doubts = (report.doubts || []).map((d) => {
      const meta = SEVERITY_META[d.severity] || SEVERITY_META.info;
      return Object.assign({}, d, { tone: meta.tone, severity_label: meta.label });
    });
    const counts = report.doubt_counts || { attention: 0, verify: 0, info: 0 };

    const sections = (report.sections || []).map((s) => {
      if (s.key === 'fit') {
        return Object.assign({}, s, {
          status_label:
            s.status === 'heuristic'
              ? '按尺码表与偏好推算'
              : s.status === 'chart_missing'
                ? '缺尺码表，未给尺码'
                : s.status === 'profile_incomplete'
                  ? '缺个人数据，仅解读尺码表'
                  : '信息不足'
        });
      }
      return s;
    });

    return {
      title: h.product_name || '未识别商品名称',
      sec: {
        basic: sections.find((s) => s.key === 'basic') || null,
        standard: sections.find((s) => s.key === 'standard') || null,
        fabric: sections.find((s) => s.key === 'fabric') || null,
        fit: sections.find((s) => s.key === 'fit') || null,
        doubts: sections.find((s) => s.key === 'doubts') || null,
        care: sections.find((s) => s.key === 'care') || null
      },
      category: h.category || '',
      priceText: h.price != null ? `¥${h.price}` : '',
      priceNote: h.price_note || '',
      conclusion: h.conclusion || '',
      conclusionDetail: h.conclusion_detail || '',
      level: comp.level || 'low',
      levelLabel: comp.level_label || '信息不足',
      completenessPercent: Math.round((comp.ratio || 0) * 100),
      keyMissing: comp.key_missing || [],
      images: h.images || [],
      sections,
      doubts,
      counts,
      questions: report.questions || [],
      limits: report.limits || [],
      disclaimer: report.disclaimer || '',
      confidenceNote: report.confidence_note || '',
      evidence: report.evidence || [],
      standard: report.standard || null,
      officialUrl: (report.standard && report.standard.official_source_url) || '',
      lastVerified: report.standard && report.standard.last_verified_at ? String(report.standard.last_verified_at).slice(0, 10) : '',
      standardStatusLabel: (report.standard && report.standard.official_status_label) || (report.standard && report.standard.registry_label) || '未核验',
      created: String(report.created_at || '').slice(0, 16).replace('T', ' '),
      mode,
      demoNote: report.demo_note || ''
    };
  },

  /* ───────── 字段修正 ───────── */

  onEditField(e) {
    const key = e.detail.key;
    const item = e.detail.item || {};
    const current = item.raw_text || (item.value != null ? String(item.value) : '');
    wx.showModal({
      title: `修正「${item.label || key}」`,
      editable: true,
      placeholderText: '输入正确内容（原文/标准写法）',
      content: String(current || ''),
      success: (res) => {
        if (!res.confirm) return;
        const value = (res.content || '').trim();
        if (!value) {
          wx.showToast({ title: '内容不能为空', icon: 'none' });
          return;
        }
        this.applyCorrection(key, value);
      }
    });
  },

  applyCorrection(fieldKey, value) {
    const report = this.data.report;
    const fields = this.data.fields;
    if (!fields) {
      wx.showToast({ title: '该记录缺少字段明细，无法修正', icon: 'none' });
      return;
    }
    try {
      const res = analysis.applyCorrectionLocal({
        fields,
        fieldKey,
        value,
        profile: storage.getProfile(),
        images: (report.header && report.header.images) || []
      });
      const merged = Object.assign({}, res.report, {
        analysis_id: report.analysis_id,
        created_at: report.created_at,
        demo: report.demo,
        mode: report.mode,
        demo_label: report.demo_label,
        demo_note: report.demo_note
      });
      storage.saveHistory(merged, { fields: res.fields, images: (report.header && report.header.images) || [] });
      this.hydrate(merged, res.fields, false);
      wx.showToast({ title: '已按你的修正重算', icon: 'success' });
    } catch (err) {
      wx.showToast({ title: '修正失败：' + String(err.message || err).slice(0, 30), icon: 'none' });
    }
  },

  /* ───────── 操作 ───────── */

  toggleFav() {
    const id = this.data.report.analysis_id;
    if (!id) return;
    const now = storage.toggleFavorite(id);
    this.setData({ isFavorite: now });
    wx.showToast({ title: now ? '已收藏' : '已取消收藏', icon: 'none' });
  },

  addToCompare() {
    const app = getApp();
    const id = this.data.report.analysis_id;
    const list = (app.globalData.compareIds || []).slice();
    const idx = list.indexOf(id);
    if (idx >= 0) {
      list.splice(idx, 1);
      app.globalData.compareIds = list;
      this.setData({ inCompare: false });
      wx.showToast({ title: '已移出对比', icon: 'none' });
      return;
    }
    if (list.length >= 3) {
      wx.showToast({ title: '最多比较 3 件', icon: 'none' });
      return;
    }
    list.push(id);
    app.globalData.compareIds = list;
    this.setData({ inCompare: true });
    wx.showToast({ title: `已加入对比（${list.length}）`, icon: 'none' });
  },

  goCompare() {
    wx.navigateTo({ url: '/pages/compare/compare' });
  },

  goStandard() {
    const code = this.data.report && this.data.report.standard && this.data.report.standard.normalized_code;
    wx.navigateTo({ url: `/pages/standard/standard${code ? `?code=${encodeURIComponent(code)}` : ''}` });
  },

  goKnowledge() {
    wx.navigateTo({ url: '/pages/knowledge/knowledge' });
  },

  toggleSection(e) {
    const key = e.currentTarget.dataset.key;
    const expanded = Object.assign({}, this.data.expanded, { [key]: !this.data.expanded[key] });
    this.setData({ expanded });
  },

  copyQuestions() {
    const list = this.data.view.questions || [];
    if (!list.length) {
      wx.showToast({ title: '没有待确认问题', icon: 'none' });
      return;
    }
    const text = list.map((q, i) => `${i + 1}. ${q}`).join('\n');
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '问题已复制，可发给客服', icon: 'none' })
    });
  },

  copyConclusion() {
    wx.setClipboardData({
      data: `${this.data.view.title}\n${this.data.view.conclusion}\n（信息整理，非质量/真伪判定）`,
      success: () => wx.showToast({ title: '已复制', icon: 'none' })
    });
  },

  openOfficial() {
    const url = this.data.view.officialUrl;
    if (!url) {
      wx.showToast({ title: '没有官方链接', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: url,
      success: () => wx.showModal({
        title: '官方查询链接已复制',
        content: '小程序不能直接打开外部网页。请把链接粘贴到浏览器打开 openstd.samr.gov.cn 核对标准状态。',
        showCancel: false
      })
    });
  },

  previewImage(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    const urls = (this.data.view.images || []).map((i) => i.preview).filter(Boolean);
    if (urls.length) wx.previewImage({ current: url, urls });
  },

  onShareAppMessage() {
    const v = this.data.view || {};
    return {
      title: `${v.title}：${String(v.conclusion || '').slice(0, 40)}`,
      path: '/pages/index/index'
    };
  },

  backHome() {
    wx.reLaunch({ url: '/pages/index/index' });
  },

  reAnalyze() {
    wx.redirectTo({ url: '/pages/capture/capture' });
  }
});
