Component({
  properties: {
    status: { type: String, value: 'missing' },
    label: { type: String, value: '' }
  },
  data: {
    tone: 'muted',
    text: '未提供'
  },
  observers: {
    'status, label': function (status, label) {
      const { STATUS_META } = require('../../core/fields');
      const meta = STATUS_META[status] || { label: status, tone: 'muted' };
      this.setData({ tone: meta.tone, text: label || meta.label });
    }
  },
  lifetimes: {
    attached() {
      const { STATUS_META } = require('../../core/fields');
      const meta = STATUS_META[this.data.status] || { label: this.data.status, tone: 'muted' };
      this.setData({ tone: meta.tone, text: this.data.label || meta.label });
    }
  }
});
