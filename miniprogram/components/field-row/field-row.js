/**
 * 字段行：标签 + 值 + 状态标签 + 来源/原文说明。
 * 用户点"改"会抛出 edit 事件，由页面决定怎么编辑（小程序端用 modal 输入）。
 */
Component({
  properties: {
    item: { type: Object, value: {} },
    showEdit: { type: Boolean, value: true }
  },
  methods: {
    onEdit() {
      if (!this.properties.showEdit) return;
      this.triggerEvent('edit', { key: this.properties.item.key, item: this.properties.item });
    },
    onShowRaw() {
      this.triggerEvent('showraw', { key: this.properties.item.key, item: this.properties.item });
    }
  }
});
