'use strict';

const storage = require('../../services/storage');

const NUMERIC = [
  { key: 'height', label: '身高（cm）', min: 120, max: 230 },
  { key: 'weight', label: '体重（kg）', min: 30, max: 200 },
  { key: 'bust', label: '胸围（cm）', min: 50, max: 160 },
  { key: 'waist', label: '腰围（cm）', min: 40, max: 160 },
  { key: 'hip', label: '臀围（cm）', min: 50, max: 170 },
  { key: 'shoulder', label: '肩宽（cm）', min: 28, max: 70 }
];

const LOOSENESS = ['修身', '合体', '宽松'];
const WARMTH = ['偏薄', '一般', '偏厚'];
const BREATH = ['偏好透气', '一般', '不在意'];
const CARE = ['希望好打理', '可以手洗/干洗', '不在意'];
const SCENES = ['日常通勤', '居家', '运动', '正式场合', '周末出行', '旅行'];

Page({
  data: {
    numeric: NUMERIC,
    form: {},
    looseness: LOOSENESS,
    loosenessIndex: 1,
    warmth: WARMTH,
    warmthIndex: 1,
    breath: BREATH,
    breathIndex: 1,
    care: CARE,
    careIndex: 1,
    scenes: SCENES.map((s) => ({ label: s, checked: false })),
    saved: false,
    warnings: [],
    savedAt: ''
  },

  onLoad() {
    const p = storage.getProfile();
    if (!p) {
      this.setData({ saved: false });
      return;
    }
    const form = {};
    NUMERIC.forEach((f) => {
      form[f.key] = p[f.key] != null ? String(p[f.key]) : '';
    });
    form.usual_size = p.usual_size || '';
    const scenes = SCENES.map((s) => ({ label: s, checked: Array.isArray(p.scenes) && p.scenes.indexOf(s) >= 0 }));
    this.setData({
      form,
      loosenessIndex: Math.max(0, LOOSENESS.indexOf(p.looseness)),
      warmthIndex: Math.max(0, WARMTH.indexOf(p.warmth)),
      breathIndex: Math.max(0, BREATH.indexOf(p.breathability)),
      careIndex: Math.max(0, CARE.indexOf(p.care)),
      scenes,
      saved: true,
      savedAt: p.updated_at ? String(p.updated_at).slice(0, 10) : ''
    });
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key;
    const form = Object.assign({}, this.data.form, { [key]: e.detail.value });
    this.setData({ form, warnings: [] });
  },

  onPicker(e) {
    const key = e.currentTarget.dataset.key;
    const index = Number(e.detail.value);
    if (key === 'looseness') this.setData({ loosenessIndex: index });
    if (key === 'warmth') this.setData({ warmthIndex: index });
    if (key === 'breath') this.setData({ breathIndex: index });
    if (key === 'care') this.setData({ careIndex: index });
  },

  onSceneChange(e) {
    const values = e.detail.value || [];
    const scenes = SCENES.map((s) => ({ label: s, checked: values.indexOf(s) >= 0 }));
    this.setData({ scenes });
  },

  validate() {
    const warnings = [];
    for (const f of NUMERIC) {
      const raw = String(this.data.form[f.key] || '').trim();
      if (!raw) continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        warnings.push(`${f.label}不是有效数字，已忽略`);
        continue;
      }
      if (n < f.min || n > f.max) {
        warnings.push(`${f.label}填的是 ${n}，超出常见范围（${f.min}–${f.max}），请确认是否填错`);
      }
    }
    return warnings;
  },

  save() {
    const warnings = this.validate();
    const form = this.data.form;
    const profile = {
      height: numOrNull(form.height),
      weight: numOrNull(form.weight),
      bust: numOrNull(form.bust),
      waist: numOrNull(form.waist),
      hip: numOrNull(form.hip),
      shoulder: numOrNull(form.shoulder),
      usual_size: (form.usual_size || '').trim() || null,
      looseness: LOOSENESS[this.data.loosenessIndex],
      warmth: WARMTH[this.data.warmthIndex],
      breathability: BREATH[this.data.breathIndex],
      care: CARE[this.data.careIndex],
      scenes: this.data.scenes.filter((s) => s.checked).map((s) => s.label)
    };
    const filled = Object.keys(profile).filter((k) => {
      const v = profile[k];
      if (Array.isArray(v)) return v.length > 0;
      return v !== null && v !== '';
    });
    if (filled.length === 0) {
      wx.showToast({ title: '还没填写任何内容', icon: 'none' });
      return;
    }
    const saved = storage.saveProfile(profile);
    getApp().setProfile(saved);
    this.setData({ saved: true, warnings, savedAt: String(saved.updated_at).slice(0, 10) });
    wx.showToast({ title: '已保存到本机', icon: 'success' });
  },

  clear() {
    wx.showModal({
      title: '删除身材资料',
      content: '只会删除本机保存的身材与偏好数据，无法恢复。',
      confirmText: '删除',
      confirmColor: '#b42318',
      success: (res) => {
        if (!res.confirm) return;
        storage.clearProfile();
        getApp().setProfile(null);
        this.setData({
          form: {},
          scenes: SCENES.map((s) => ({ label: s, checked: false })),
          loosenessIndex: 1,
          warmthIndex: 1,
          breathIndex: 1,
          careIndex: 1,
          saved: false,
          warnings: [],
          savedAt: ''
        });
        wx.showToast({ title: '已删除', icon: 'none' });
      }
    });
  }
});

function numOrNull(v) {
  const raw = String(v == null ? '' : v).trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
