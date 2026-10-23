/* 衣知 · 网页演示版（非小程序本体）
 *
 * 数据流与小程序完全一致：全部计算来自 window.YizhiCore（由 miniprogram/core 打包），
 * 本文件只负责：读表单 → 调 core → 渲染 DOM。
 */

(function () {
  'use strict';

  var C = window.YizhiCore;
  var STATUS = C.fields.STATUS_META;
  var SOURCE = C.fields.SOURCE_META;

  var state = {
    demoId: '',
    cards: [],
    picked: [],
    tab: 'analyze',
    lastReport: null
  };

  var LS_KEY = 'yizhi:web:cards';

  /* ───────── 工具 ───────── */

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function tag(status, label) {
    var meta = STATUS[status] || { tone: 'muted', label: status };
    return '<span class="tag tag-' + meta.tone + '">' + esc(label || meta.label) + '</span>';
  }

  function toneClass(status) {
    var meta = STATUS[status];
    return 'cell-' + (meta ? meta.tone : 'muted');
  }

  function arr(v) {
    if (v == null) return [];
    return Array.isArray(v) ? v : [v];
  }

  function joinList(v) {
    return arr(v).map(function (x) { return typeof x === 'string' ? x : JSON.stringify(x); }).join('、');
  }

  function save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ cards: state.cards, picked: state.picked }));
    } catch (err) { /* localStorage 满了就算了，不编造 */ }
  }

  function load() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      state.cards = Array.isArray(data.cards) ? data.cards : [];
      state.picked = Array.isArray(data.picked) ? data.picked : [];
    } catch (err) { state.cards = []; }
  }

  /* ───────── 标签页 ───────── */

  function setTab(name) {
    state.tab = name;
    $$('.tab').forEach(function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-tab') === name);
    });
    $$('.view').forEach(function (v) {
      v.classList.toggle('is-on', v.id === 'view-' + name);
    });
    if (name === 'compare') renderPicks();
    if (name === 'knowledge' && !$('#kn-list').dataset.ready) renderKnowledge('');
    if (name === 'standard' && !$('#std-results').dataset.ready) runStandardSearch('GB 18401');
  }

  /* ───────── 示例商品 ───────── */

  function renderDemos() {
    var box = $('#demo-list');
    box.innerHTML = C.demos.DEMO_PRODUCTS.map(function (d) {
      return '<div class="demo' + (state.demoId === d.id ? ' is-on' : '') + '" data-id="' + esc(d.id) + '">' +
        '<div class="demo__label">' + esc(d.label) + '</div>' +
        '<div class="demo__summary">' + esc(d.summary) + '</div>' +
      '</div>';
    }).join('');
    box.querySelectorAll('.demo').forEach(function (el) {
      el.addEventListener('click', function () {
        var id = el.getAttribute('data-id');
        state.demoId = state.demoId === id ? '' : id;
        renderDemos();
        updateHint();
      });
    });
  }

  /* ───────── 表单 ───────── */

  var MANUAL_KEYS = ['product_name', 'category', 'price', 'fiber_composition', 'fabric_weight', 'standard_code', 'safety_category', 'size_chart', 'care_instructions'];

  function readManual() {
    var out = {};
    MANUAL_KEYS.forEach(function (k) {
      var el = document.getElementById('f-' + k);
      if (el && String(el.value || '').trim()) out[k] = String(el.value).trim();
    });
    return out;
  }

  function readProfile() {
    var p = {};
    var bust = $('#p-bust').value.trim();
    var shoulder = $('#p-shoulder').value.trim();
    var usual = $('#p-usual_size').value.trim();
    var loose = $('#p-looseness').value;
    if (bust) p.bust = Number(bust);
    if (shoulder) p.shoulder = Number(shoulder);
    if (usual) p.usual_size = usual;
    if (loose) p.looseness = loose;
    return Object.keys(p).length ? p : null;
  }

  function updateHint() {
    var hint = $('#analyze-hint');
    hint.className = 'hint';
    if (state.demoId) {
      hint.textContent = '已选择示例商品，结果会标注「演示数据」。';
    } else if (Object.keys(readManual()).length) {
      hint.textContent = '将使用你填写的信息（标记为「你填写」），不做 OCR。';
    } else {
      hint.textContent = '本地演示没有 OCR：请选择示例商品，或至少填写一项。';
    }
  }

  /* ───────── 生成分析卡 ───────── */

  function analyze() {
    var manual = readManual();
    var demo = state.demoId ? C.demos.findDemo(state.demoId) : null;

    if (!demo && Object.keys(manual).length === 0) {
      var hint = $('#analyze-hint');
      hint.className = 'hint is-alert';
      hint.textContent = '没有可分析的输入：请选择一个示例商品，或至少填写一项已知信息。';
      return;
    }

    var report;
    try {
      var meta = {
        mode: 'local',
        demo: Boolean(demo),
        images: demo ? demo.images.map(function (i) { return { id: i.id, kind: i.kind }; }) : [],
        analysis_id: 'web-' + Date.now(),
        created_at: new Date().toISOString()
      };
      var res = C.analyze({
        ocr: demo ? { images: demo.images } : { images: [] },
        profile: readProfile(),
        meta: meta,
        manualFields: Object.keys(manual).length ? C.buildManualFields(manual) : null
      });
      report = res.report;
      report.demo_label = demo
        ? '演示数据：' + demo.label
        : '手动填写模式（无 OCR 结果）';
    } catch (err) {
      $('#analyze-hint').className = 'hint is-alert';
      $('#analyze-hint').textContent = '分析失败：' + (err && err.message ? err.message : err);
      return;
    }

    state.lastReport = report;
    var existing = state.cards.filter(function (c) { return c.analysis_id !== report.analysis_id; });
    state.cards = [report].concat(existing).slice(0, 6);
    save();

    renderReport(report);
    $('#analyze-hint').className = 'hint is-ok';
    $('#analyze-hint').textContent = '已生成。可以「加入对比」或到「标准」页查执行标准。';
    if (window.innerWidth < 980) {
      document.getElementById('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  /* ───────── 渲染分析卡 ───────── */

  function fieldRow(item) {
    var metaBits = [];
    metaBits.push(tag(item.status, item.status_label));
    if (item.source) metaBits.push('<span class="tiny faint">来源：' + esc(item.source) + '</span>');
    if (item.confidence) metaBits.push('<span class="tiny faint">自评置信 ' + esc(item.confidence) + '</span>');
    var value = item.value
      ? '<span>' + esc(item.value) + '</span>'
      : '<span class="faint">' + esc(item.placeholder || '未提供') + '</span>';
    return '<div class="row">' +
      '<div class="row__label">' + esc(item.label) + '</div>' +
      '<div class="row__value">' + value +
        '<div class="row__meta">' + metaBits.join('') + '</div>' +
        (item.note ? '<div class="tiny muted">' + esc(item.note) + '</div>' : '') +
      '</div></div>';
  }

  function renderReport(r) {
    var h = r.header;
    var sec = {};
    r.sections.forEach(function (s) { sec[s.key] = s; });

    var html = '';

    html += '<div class="notice notice-warn"><strong>' + esc(r.demo_label || '演示数据') + '</strong>' +
      ' —— 本次结果由内置示例文本生成，不能作为真实商品分析。</div>';

    html += '<div class="verdict">' +
      '<div class="verdict__label">一句话结论</div>' +
      '<div class="verdict__text">' + esc(h.conclusion) + '</div>' +
      (h.conclusion_detail ? '<div class="verdict__meta">' + esc(h.conclusion_detail) + '</div>' : '') +
      '<div class="verdict__meta">信息完整度：' + esc(h.completeness.level_label) + '（' + Math.round(h.completeness.ratio * 100) + '%）' +
      (h.completeness.key_missing.length ? ' · 缺 ' + h.completeness.key_missing.length + ' 项关键信息' : '') +
      '</div></div>';

    html += '<div class="card"><div style="font-size:16px;font-weight:650">' + esc(h.product_name) + '</div>' +
      '<div class="headmeta">' +
      (h.category ? '<span class="tag tag-accent">' + esc(h.category) + '</span>' : '') +
      (h.price != null ? '<span class="tag tag-muted">¥' + esc(h.price) + '</span>' : '') +
      '<span class="tag tag-info">' + r.evidence.length + ' 个字段</span>' +
      '<span class="tag tag-' + (r.doubt_counts.attention ? 'alert' : r.doubt_counts.verify ? 'warn' : 'ok') + '">' +
        '疑点 重点' + r.doubt_counts.attention + ' / 确认' + r.doubt_counts.verify + '</span>' +
      '</div>' +
      '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn btn-sm" id="btn-add-compare">' + (state.picked.indexOf(r.analysis_id) >= 0 ? '✓ 已在对比中' : '＋ 加入对比') + '</button>' +
        '<button class="btn btn-sm" id="btn-copy-questions">复制待确认问题</button>' +
        '<button class="btn btn-sm" id="btn-copy-conclusion">复制结论</button>' +
      '</div></div>';

    /* 基本信息 */
    html += secWrap('基本信息', '图片/填写里写明的内容，逐项标注来源与状态', sec.basic.items.map(fieldRow).join(''));

    /* 标准解读 */
    var std = sec.standard;
    var stdRows = std.items.map(function (i) {
      return '<div class="row"><div class="row__label">' + esc(i.label) + '</div>' +
        '<div class="row__value">' + esc(i.value) +
        (i.note ? '<div class="tiny muted">' + esc(i.note) + '</div>' : '') + '</div></div>';
    }).join('');
    var stdExtra = '';
    if (std.official_source_url) {
      stdExtra += '<div class="notice notice-muted">官方查询来源：' +
        '<a href="' + esc(std.official_source_url) + '" target="_blank" rel="noopener">' + esc(std.official_source_url) + '</a>' +
        (std.last_verified_at ? '<br/>核验时间：' + esc(String(std.last_verified_at).slice(0, 10)) : '') + '</div>';
    }
    if (std.caveats && std.caveats.length) {
      stdExtra += '<div class="notice notice-muted">' + std.caveats.map(function (c) { return '· ' + esc(c); }).join('<br/>') + '</div>';
    }
    html += secWrap('标准解读', '标准号只是「声称执行」，不等于「已符合」', stdRows + stdExtra);

    /* 面料 */
    var fab = sec.fabric;
    var fabHtml = '';
    if (fab.composition) fabHtml += fieldRow(fab.composition);
    fabHtml += fab.items.map(fieldRow).join('');
    fabHtml += '<div class="row"><div class="row__label">克重参考</div><div class="row__value">' + esc(fab.weight_assessment.message) +
      (fab.weight_assessment.reference
        ? '<div class="tiny faint">参考区间 ' + fab.weight_assessment.reference.min + '–' + fab.weight_assessment.reference.max +
          ' g/m² · 样本 ' + fab.weight_assessment.reference.samples + ' · ' + esc(fab.weight_assessment.reference.source) + '</div>'
        : '') + '</div></div>';
    fabHtml += '<div class="row"><div class="row__label">支数参考</div><div class="row__value">' + esc(fab.yarn_assessment.message) +
      '<div class="tiny faint">' + fab.yarn_assessment.limits.map(esc).join('<br/>') + '</div></div></div>';

    if (fab.fiber_notes.items.length) {
      fabHtml += '<div style="margin-top:14px;font-weight:600;font-size:13.5px">成分含义</div>';
      fabHtml += fab.fiber_notes.items.map(function (i) {
        return '<div style="padding:10px 0;border-bottom:1px dashed #eef0f2">' +
          '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
          '<strong>' + esc(i.fiber) + '</strong>' +
          (i.percent ? '<span class="tag tag-muted">' + esc(i.percent) + '%</span>' : '') +
          (!i.found ? '<span class="tag tag-warn">知识库未收录</span>' : '') +
          '<span class="tag tag-muted">待专业审校</span></div>' +
          '<div class="tiny" style="margin-top:4px">' + esc(i.plain) + '</div>' +
          (i.pros && i.pros.length ? '<div class="tiny" style="color:var(--ok)">可能优点：' + esc(joinList(i.pros)) + '</div>' : '') +
          (i.cons && i.cons.length ? '<div class="tiny" style="color:var(--warn)">可能局限：' + esc(joinList(i.cons)) + '</div>' : '') +
          (i.note_on_quality ? '<div class="tiny muted">' + esc(i.note_on_quality) + '</div>' : '') +
          '</div>';
      }).join('');
    }
    if (fab.fiber_notes.summary.length) {
      fabHtml += fab.fiber_notes.summary.map(function (s) { return '<div class="tiny muted" style="margin-top:6px">· ' + esc(s) + '</div>'; }).join('');
    }
    fabHtml += '<div class="tiny faint" style="margin-top:8px">' + esc(fab.disclaimer) + '</div>';
    html += secWrap('面料与工艺参考', '通用纤维特性 + 已知参数，不是实测结论', fabHtml);

    /* 版型 */
    var fit = sec.fit;
    var fitHtml = '';
    if (fit.recommended_size) {
      fitHtml += '<div class="size-box"><div class="tiny muted">建议参考尺码</div>' +
        '<div class="size-box__value">' + esc(fit.recommended_size) + '</div>' +
        '<div class="tiny muted">按尺码表 + 你的偏好推算，不是试穿结果</div></div>';
    }
    if (fit.summary) fitHtml += '<div style="font-size:13.5px;color:#374151">' + esc(fit.summary) + '</div>';
    fitHtml += fit.reasons.map(function (s) { return '<div class="tiny" style="color:#4b5563;margin-top:4px">· ' + esc(s) + '</div>'; }).join('');
    fitHtml += fit.limits.map(function (s) { return '<div class="tiny faint" style="margin-top:4px">· ' + esc(s) + '</div>'; }).join('');
    if (fit.missing_product && fit.missing_product.length) {
      fitHtml += '<div class="notice notice-warn">还缺商品信息：' + esc(joinList(fit.missing_product)) + '</div>';
    }
    if (fit.missing_profile && fit.missing_profile.length) {
      fitHtml += '<div class="notice notice-info">还缺你的信息（可选）：' + esc(joinList(fit.missing_profile)) + '。系统不会推测你的身体数据。</div>';
    }
    html += secWrap('版型与尺码', fit.status === 'heuristic' ? '按尺码表与偏好推算' : fit.status === 'chart_missing' ? '缺尺码表，未给尺码' : '信息不足', fitHtml);

    html += renderWear(r.wear);

    /* 疑点 */
    var doubtsHtml = r.doubts.length
      ? r.doubts.map(function (d) {
          var meta = d.severity === 'attention' ? { t: 'alert', l: '需重点核实' } : d.severity === 'verify' ? { t: 'warn', l: '建议确认' } : { t: 'muted', l: '提示' };
          return '<div class="doubt"><div class="doubt__head"><div class="doubt__title">' + esc(d.title) + '</div>' +
            '<span class="tag tag-' + meta.t + '">' + meta.l + '</span></div>' +
            '<div class="doubt__reason">' + esc(d.reason) + '</div>' +
            (d.action ? '<div class="doubt__action">下一步：' + esc(d.action) + '</div>' : '') +
            '<div class="doubt__basis">' + esc(d.category) + ' · ' + arr(d.basis).length + ' 条依据</div></div>';
        }).join('')
      : '<div class="tiny" style="color:var(--ok)">当前材料下没有需要特别核实的点；这不等于商品没问题。</div>';
    html += secWrap('信息可信度与疑点', '重点 ' + r.doubt_counts.attention + ' · 确认 ' + r.doubt_counts.verify + ' · 提示 ' + r.doubt_counts.info, doubtsHtml);

    /* 洗护 */
    var care = sec.care;
    var careHtml = fieldRow(care.label_item);
    if (care.keywords && care.keywords.length) careHtml += '<div class="tiny">标签要求：' + esc(joinList(care.keywords)) + '</div>';
    if (care.symbols && care.symbols.length) {
      careHtml += care.symbols.map(function (s) { return '<div class="tiny muted">· ' + esc(s.text) + '：' + esc(s.meaning) + '</div>'; }).join('');
    }
    careHtml += (care.fiber_care || []).map(function (f) {
      return '<div style="margin-top:8px"><div class="tiny strong">' + esc(f.fiber) + ' 的通用注意</div>' +
        f.advice.map(function (a) { return '<div class="tiny muted">· ' + esc(a) + '</div>'; }).join('') + '</div>';
    }).join('');
    careHtml += '<div class="tiny muted" style="margin-top:8px">' + esc(care.note) + '</div>';
    careHtml += '<div class="tiny faint">' + esc(care.caution) + '</div>';
    html += secWrap('穿着与洗护', '标签优先，成分建议只作参考', careHtml);

    /* 待确认问题 */
    var qHtml = r.questions.length
      ? r.questions.map(function (q, i) { return '<div class="q"><span class="q__idx">' + (i + 1) + '</span><span>' + esc(q) + '</span></div>'; }).join('')
      : '<div class="tiny muted">暂无可直接询问的问题。</div>';
    html += secWrap('购买前建议确认', '可直接复制发给客服', qHtml);

    /* 证据 + 边界 */
    var evRows = r.evidence.map(function (e) {
      return '<div class="row"><div class="row__label">' + esc(e.field_name) + '</div><div class="row__value">' +
        (e.value ? esc(e.value) : '<span class="faint">—</span>') +
        '<div class="row__meta">' + tag(e.status, e.status_label) + '<span class="tiny faint">来源：' + esc(e.source_label) + '</span>' +
        (e.confidence ? '<span class="tiny faint">自评 ' + esc(e.confidence) + '</span>' : '') + '</div>' +
        (e.raw_text ? '<div class="tiny faint">原文：' + esc(String(e.raw_text).slice(0, 120)) + '</div>' : '') +
        '</div></div>';
    }).join('');
    html += secWrap('证据清单', r.evidence.length + ' 个字段',
      '<details class="evidence"><summary>展开逐字段来源</summary>' + evRows +
      '<div class="tiny faint" style="margin-top:8px">' + esc(r.confidence_note) + '</div></details>');

    html += secWrap('这份分析的能力边界', r.limits.length + ' 条限制',
      r.limits.map(function (l) { return '<div class="tiny muted">· ' + esc(l) + '</div>'; }).join('') +
      '<div class="notice notice-muted">' + esc(r.disclaimer) + '</div>');

    var box = $('#result');
    box.innerHTML = html;

    var addBtn = $('#btn-add-compare');
    if (addBtn) addBtn.addEventListener('click', function () { togglePick(r.analysis_id); });
    var copyQ = $('#btn-copy-questions');
    if (copyQ) copyQ.addEventListener('click', function () {
      copy(r.questions.map(function (q, i) { return (i + 1) + '. ' + q; }).join('\n'), '问题已复制');
    });
    var copyC = $('#btn-copy-conclusion');
    if (copyC) copyC.addEventListener('click', function () {
      copy(h.product_name + '\n' + h.conclusion + '\n（信息整理，非质量/真伪判定）', '结论已复制');
    });
  }

  /* 穿久了会怎么样？ */
  function renderWear(wear) {
    if (!wear) return '';
    var tone = function (lv) {
      if (lv === 'high') return 'alert';
      if (lv === 'medium') return 'warn';
      if (lv === 'low') return 'ok';
      return 'muted';
    };
    var html = '';

    html += '<div class="wear-summary">' + esc(wear.summary) + '</div>';

    /* 区域分布 */
    html += '<div style="margin-top:14px;font-weight:600;font-size:13.5px">风险分布（示意）</div>';
    html += '<div class="chips">' + (wear.regions.regions || []).map(function (r) {
      return '<span class="chip chip--' + tone(r.level) + '"><b>' + esc(r.name) + '</b><span>' + esc(r.level_label) + '</span></span>';
    }).join('') + '</div>';
    html += '<div class="tiny faint">' + esc(wear.regions.note) + '</div>';

    /* 风险条目 */
    html += '<div style="margin-top:16px;font-weight:600;font-size:13.5px">风险条目（点开看依据）</div>';
    html += (wear.items || []).map(function (it, idx) {
      var body =
        wearRow('当前观察', it.observed_feature) +
        wearRow('已知材料', it.identified_material) +
        wearRow('结构/工艺', it.construction_feature) +
        wearRow('潜在变化', it.possible_failure) +
        wearRow('为什么会这样', it.mechanism) +
        wearRow('风险判断', '可能性 ' + it.likelihood_label + ' · 影响 ' + it.impact_label + ' → ' + it.overall_label) +
        wearRow('判断置信', it.confidence_label) +
        (it.missing_information && it.missing_information.length ? wearRow('还缺什么', it.missing_information.join('、')) : '') +
        (it.mitigation && it.mitigation.length ? wearRow('降低风险', it.mitigation.join('；')) : '') +
        (it.seller_questions && it.seller_questions.length ? wearRow('可以问', it.seller_questions.join('；')) : '') +
        '<div class="tiny faint" style="margin-top:6px">' + esc(it.disclaimer) + '</div>';

      return '<details class="wear-item"' + (idx === 0 ? ' open' : '') + '>' +
        '<summary><span class="wear-item__title">' + esc(it.item_name) + '</span>' +
        '<span class="tag tag-' + tone(it.overall_risk) + '">' + esc(it.overall_label) + '</span>' +
        '<span class="tiny muted" style="margin-left:8px">' + esc(it.garment_area) + '</span></summary>' +
        body + '</details>';
    }).join('');

    /* 时间轴 */
    html += '<div style="margin-top:16px;font-weight:600;font-size:13.5px">从新到旧（定性阶段）</div>';
    html += '<div class="timeline">' + (wear.timeline || []).map(function (s) {
      return '<div class="tl"><div class="tl__stage">' + esc(s.stage) + '</div>' +
        '<div class="tl__body"><div class="tiny strong">' + esc(s.title) + '</div>' +
        '<div class="tiny muted">' + esc(s.text) + '</div></div></div>';
    }).join('') + '</div>';

    /* 长期外观 */
    html += '<div style="margin-top:16px;font-weight:600;font-size:13.5px">长期外观与搭配</div>';
    html += (wear.appearance.style || []).map(function (s) {
      return '<div class="tiny" style="margin-top:4px">· <span class="strong">' + esc(s.title) + '</span>：' + esc(s.text) + '</div>';
    }).join('');
    html += '<div class="tiny muted" style="margin-top:6px">' + esc(wear.appearance.durability_note) + '</div>';
    html += '<div class="tiny faint">' + esc(wear.appearance.disclaimer) + '</div>';

    /* 补图建议 */
    if (wear.evidence_gaps && wear.evidence_gaps.length) {
      html += '<div style="margin-top:16px;font-weight:600;font-size:13.5px">补充什么能提高可靠性</div>';
      html += wear.evidence_gaps.map(function (g) {
        return '<div class="gap"><div class="tiny strong">' + esc(g.what) + '</div>' +
          '<div class="tiny muted">' + esc(g.why) + '</div>' +
          '<div class="tiny faint">' + esc(g.how) + '</div></div>';
      }).join('');
    }

    html += '<div class="notice notice-muted" style="margin-top:10px">' + esc(wear.disclaimer) + '</div>';
    html += '<div class="tiny faint" style="margin-top:4px">' + esc(wear.confidence_note) + '</div>';

    return secWrap('穿久了会怎么样？', '重点 ' + wear.counts.high + ' · 中 ' + wear.counts.medium + ' · 证据不足 ' + wear.counts.insufficient, html);
  }

  function wearRow(label, value) {
    return '<div class="row"><div class="row__label">' + esc(label) + '</div>' +
      '<div class="row__value tiny">' + esc(value) + '</div></div>';
  }

  function secWrap(title, sub, body) {
    return '<div class="sec"><div class="sec__head"><div class="sec__title">' + esc(title) + '</div>' +
      '<div class="sec__sub">' + esc(sub) + '</div></div><div class="sec__body">' + body + '</div></div>';
  }

  function copy(text, msg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(msg); }).catch(function () { fallbackCopy(text, msg); });
    } else {
      fallbackCopy(text, msg);
    }
  }

  function fallbackCopy(text, msg) {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(msg); } catch (err) { toast('复制失败，请手动选择'); }
    document.body.removeChild(ta);
  }

  function toast(msg) {
    var hint = $('#analyze-hint');
    if (hint) {
      hint.className = 'hint is-ok';
      hint.textContent = msg;
    }
  }

  /* ───────── 对比 ───────── */

  function togglePick(id) {
    var idx = state.picked.indexOf(id);
    if (idx >= 0) state.picked.splice(idx, 1);
    else {
      if (state.picked.length >= 3) { toast('最多比较 3 件'); return; }
      state.picked.push(id);
    }
    save();
    if (state.lastReport && state.lastReport.analysis_id === id) renderReport(state.lastReport);
    renderPicks();
  }

  function renderPicks() {
    var box = $('#compare-picks');
    if (!state.cards.length) {
      box.innerHTML = '<div class="placeholder" style="padding:28px"><div class="placeholder__title">还没有分析结果</div>先到「分析」页生成一张卡。</div>';
      return;
    }
    box.innerHTML = state.cards.map(function (r) {
      var on = state.picked.indexOf(r.analysis_id) >= 0;
      return '<div class="pick' + (on ? ' is-on' : '') + '" data-id="' + esc(r.analysis_id) + '">' +
        '<span class="pick__box">' + (on ? '✓' : '') + '</span>' +
        '<span class="pick__main"><div class="pick__name">' + esc(r.header.product_name) + '</div>' +
        '<div class="pick__meta">' + esc(r.header.category || '未识别品类') + ' · ' + esc(r.header.completeness.level_label) +
        (r.header.price != null ? ' · ¥' + esc(r.header.price) : '') +
        (r.demo ? ' · 演示数据' : '') + '</div></span></div>';
    }).join('');
    box.querySelectorAll('.pick').forEach(function (el) {
      el.addEventListener('click', function () { togglePick(el.getAttribute('data-id')); });
    });
  }

  function runCompare() {
    var hint = $('#compare-hint');
    if (state.picked.length < 2) {
      hint.className = 'hint is-alert';
      hint.textContent = '至少选择 2 件（最多 3 件）。';
      return;
    }
    var reports = state.picked.map(function (id) {
      return state.cards.filter(function (c) { return c.analysis_id === id; })[0];
    }).filter(Boolean);
    var res = C.compare({ reports: reports, profile: readProfile() });
    if (!res.ok) {
      hint.className = 'hint is-alert';
      hint.textContent = res.message;
      return;
    }
    hint.className = 'hint is-ok';
    hint.textContent = '已生成对比。';

    var html = '<div class="sec"><div class="sec__head"><div class="sec__title">对比表</div>' +
      '<div class="sec__sub">' + res.items.length + ' 件</div></div><div class="sec__body">' +
      '<div style="overflow-x:auto"><table class="cmp"><thead><tr><th></th>' +
      res.items.map(function (i) { return '<th>' + esc(i.name) + '<div class="tiny muted">' + esc(i.category || '—') + '</div></th>'; }).join('') +
      '</tr></thead><tbody>';

    res.rows.forEach(function (row) {
      html += '<tr><td class="label">' + esc(row.label) + '</td>';
      row.cells.forEach(function (lines) {
        html += '<td>' + arr(lines).map(function (l) {
          return '<div class="cell-line ' + toneClass(l.status) + '">' + esc(l.value) +
            (l.note ? '<div class="tiny muted">' + esc(l.note) + '</div>' : '') + '</div>';
        }).join('') + '</td>';
      });
      html += '</tr>';
    });

    html += '</tbody></table></div></div></div>';

    html += '<div class="sec"><div class="sec__head"><div class="sec__title">建议（与你的偏好挂钩）</div></div><div class="sec__body">' +
      (res.suggestion.preferences.length ? '<div class="tiny muted">你的偏好：' + esc(joinList(res.suggestion.preferences)) + '</div>' : '') +
      res.suggestion.lines.map(function (l) { return '<div style="font-size:13.5px;margin-top:6px">· ' + esc(l) + '</div>'; }).join('') +
      '<div class="notice notice-info">' + esc(res.suggestion.next_step) + '</div>' +
      '<div class="tiny faint" style="margin-top:8px">' + esc(res.suggestion.basis) + '</div>' +
      '</div></div>';

    html += '<div class="notice notice-muted">' + esc(res.disclaimer) + '</div>';
    $('#compare-result').innerHTML = html;
  }

  /* ───────── 标准 ───────── */

  function runStandardSearch(q) {
    var box = $('#std-results');
    box.dataset.ready = '1';
    if (q !== undefined) $('#std-q').value = q;
    var query = String($('#std-q').value || '').trim();
    if (!query) { box.innerHTML = ''; return; }

    var res = C.standards.search(query);
    if (!res.results.length) {
      box.innerHTML = '<div class="notice notice-warn">本地核验库里没有匹配条目。' +
        '系统不判断它是否存在或是否现行，请到 openstd.samr.gov.cn 自行确认。</div>';
      return;
    }
    box.innerHTML = res.results.map(function (r) {
      var tone = r.status === 'current' ? 'ok' : r.status === 'abolished' ? 'alert' : r.status === 'upcoming' ? 'warn' : 'muted';
      return '<div class="std-hit" data-code="' + esc(r.standard_number) + '">' +
        '<div class="std-hit__code">' + esc(r.standard_number) + ' <span class="tag tag-' + tone + '">' + esc(r.status_label) + '</span></div>' +
        '<div class="std-hit__name">' + esc(r.name) + '</div>' +
        '<div class="tiny faint">核验：' + (r.verification_status === 'official_verified' ? '官方页面已核验' : '待人工核验') +
        ' · ' + esc(String(r.last_verified_at || '').slice(0, 10)) + '</div></div>';
    }).join('');

    box.querySelectorAll('.std-hit').forEach(function (el) {
      el.addEventListener('click', function () { showStandard(el.getAttribute('data-code')); });
    });
  }

  function showStandard(code) {
    var d = C.standards.detail(code);
    var html = '<div class="sec"><div class="sec__head"><div class="sec__title">' + esc(d.standard_number) + '</div>' +
      '<div class="sec__sub">' + esc(d.label) + '</div></div><div class="sec__body">';

    if (d.record) {
      var rows = [
        ['标准名称', d.record.name],
        ['英文名称', d.record.name_en],
        ['标准性质', d.record.standard_type],
        ['状态', d.record.status_label],
        ['发布日期', d.record.publication_date],
        ['实施日期', d.record.implementation_date],
        ['CCS / ICS', (d.record.ccs || '—') + ' / ' + (d.record.ics || '—')],
        ['主管 / 发布', (d.record.competent_department || '—') + ' / ' + (d.record.issuing_body || '—')],
        ['核验时间', d.record.last_verified_at]
      ];
      html += rows.filter(function (r) { return r[1]; }).map(function (r) {
        return '<div class="row"><div class="row__label">' + esc(r[0]) + '</div><div class="row__value">' + esc(r[1]) + '</div></div>';
      }).join('');
    } else {
      html += '<div class="notice notice-warn">' + esc(d.message || '未找到官方核验记录') + '</div>';
    }

    if (d.editorial) {
      html += '<div style="margin-top:12px"><div style="font-weight:600;font-size:13.5px">人工整理（非官方页面字段）</div>' +
        '<div class="tiny muted">角色：' + esc(d.editorial.role) + '</div>' +
        (d.editorial.applicability_by_name && d.editorial.applicability_by_name.length
          ? '<div class="tiny">依据标准名称：' + esc(joinList(d.editorial.applicability_by_name)) + '</div>' : '') +
        (d.editorial.key_requirement_topics && d.editorial.key_requirement_topics.length
          ? '<div class="tiny">常见管控项目类别：' + esc(joinList(d.editorial.key_requirement_topics)) +
            (!d.editorial.key_requirements_verified ? '（未逐条核对正文，不含条款号与限值）' : '') + '</div>' : '') +
        (d.editorial.notes || []).map(function (n) { return '<div class="tiny" style="color:var(--warn)">· ' + esc(n) + '</div>'; }).join('') +
        '</div>';
    }

    if (d.versions && d.versions.length > 1) {
      html += '<div style="margin-top:12px"><div style="font-weight:600;font-size:13.5px">版本记录</div>' +
        d.versions.map(function (v) {
          return '<div class="tiny">' + esc(v.standard_number) + ' · ' + esc(v.status_label) +
            ' · 发布 ' + esc(v.publication_date || '—') + ' · 实施 ' + esc(v.implementation_date || '—') + '</div>';
        }).join('') + '</div>';
    }

    html += '<div class="notice notice-muted">公开页面只提供标准号、名称、状态、日期等字段；' +
      '范围与条款需查阅标准正文（官方「在线预览」）。本工具不代填、不虚构条款内容。</div>';

    if (d.official_source_url) {
      html += '<div class="notice notice-info">官方来源：<a href="' + esc(d.official_source_url) + '" target="_blank" rel="noopener">' +
        esc(d.official_source_url) + '</a></div>';
    }
    html += '</div></div>';
    $('#std-detail').innerHTML = html;
    $('#std-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ───────── 知识库 ───────── */

  function renderKnowledge(q) {
    var entries = C.knowledge.search(q || '');
    $('#kn-list').dataset.ready = '1';
    $('#kn-list').innerHTML = entries.map(function (e) {
      return '<div class="entry"><div class="entry__head" data-id="' + esc(e.id) + '">' +
        '<span class="entry__name">' + esc(e.name) + '</span>' +
        '<span class="tag tag-muted">' + (e.kind === 'fiber' ? '纤维' : '织物组织') + '</span>' +
        (e.needs_review ? '<span class="tag tag-warn">待专业审校</span>' : '') +
        '<span class="faint" style="margin-left:auto">＋</span></div>' +
        '<div class="entry__plain">' + esc(e.plain) + '</div>' +
        '<div class="entry__detail" hidden>' +
          '<div class="tiny muted">定义：' + esc(e.definition) + '</div>' +
          '<div class="tiny">常见用途：' + esc(joinList(e.common_uses)) + '</div>' +
          '<div class="tiny" style="color:var(--ok)">可能优点：' + esc(joinList(e.pros)) + '</div>' +
          '<div class="tiny" style="color:var(--warn)">可能局限：' + esc(joinList(e.cons)) + '</div>' +
          '<div class="tiny muted">影响实际表现的因素：' + esc(joinList(e.factors)) + '</div>' +
          (e.note_on_quality ? '<div class="tiny">' + esc(e.note_on_quality) + '</div>' : '') +
          '<div class="tiny faint">来源：' + esc(joinList(e.sources)) + '</div>' +
        '</div></div>';
    }).join('');

    $('#kn-list').querySelectorAll('.entry__head').forEach(function (el) {
      el.addEventListener('click', function () {
        var detail = el.parentNode.querySelector('.entry__detail');
        detail.hidden = !detail.hidden;
        el.querySelector('.faint').textContent = detail.hidden ? '＋' : '−';
      });
    });
  }

  /* ───────── 事件绑定 ───────── */

  document.getElementById('tabs').addEventListener('click', function (e) {
    var btn = e.target.closest('.tab');
    if (btn) setTab(btn.getAttribute('data-tab'));
  });

  $('#btn-analyze').addEventListener('click', analyze);
  $('#btn-compare').addEventListener('click', runCompare);
  $('#btn-std').addEventListener('click', function () { runStandardSearch(); });
  $('#std-q').addEventListener('keydown', function (e) { if (e.key === 'Enter') runStandardSearch(); });
  $('#kn-q').addEventListener('input', function (e) { renderKnowledge(e.target.value); });

  ['#f-product_name', '#f-category', '#f-price', '#f-fiber_composition', '#f-fabric_weight', '#f-standard_code', '#f-safety_category', '#f-size_chart', '#f-care_instructions'].forEach(function (sel) {
    var el = $(sel);
    if (el) el.addEventListener('input', updateHint);
  });

  /* ───────── 启动 ───────── */

  load();
  renderDemos();
  renderPicks();
  updateHint();
  if (state.cards.length) {
    state.lastReport = state.cards[0];
    renderReport(state.lastReport);
  }
})();
