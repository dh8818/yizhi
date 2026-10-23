'use strict';

const knowledge = require('../../core/knowledge');
const { CARE_SYMBOLS } = require('../../core/data/knowledge.data');

Page({
  data: {
    keyword: '',
    entries: [],
    expanded: '',
    careSymbols: CARE_SYMBOLS,
    updatedAt: knowledge.UPDATED_AT,
    disclaimer: knowledge.DISCLAIMER
  },

  onLoad() {
    this.refresh('');
  },

  refresh(keyword) {
    const entries = knowledge.search(keyword).map((e) => ({
      id: e.id,
      kind: e.kind,
      kindLabel: e.kind === 'fiber' ? '纤维' : '织物组织',
      name: e.name,
      plain: e.plain,
      definition: e.definition,
      common_uses: e.common_uses || [],
      pros: e.pros || [],
      cons: e.cons || [],
      factors: e.factors || [],
      note_on_quality: e.note_on_quality || '',
      sources: e.sources || [],
      needs_review: Boolean(e.needs_review)
    }));
    this.setData({ entries });
  },

  onInput(e) {
    const keyword = e.detail.value;
    this.setData({ keyword });
    this.refresh(keyword);
  },

  toggle(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ expanded: this.data.expanded === id ? '' : id });
  }
});
