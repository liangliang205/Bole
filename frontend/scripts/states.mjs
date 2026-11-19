/**
 * 对照配方：12 个状态。
 *
 * 约束（来自 Global Constraints）：
 * - 选择器只用 #id、属性与结构伪类，绝不能用 class——迁移后 class 会被 CSS Modules 哈希。
 * - manual: true 的状态 F0 阶段无法稳定自动驱动，先登记；对应批次把它们变成可驱动的。
 *
 * 已核实的事实（F0 实测）：
 * - 页面加载会自动选中最后一个会话并进入对话视图，所以「空状态」必须先点 #new-run-btn。
 * - 设置弹窗的导航容器是 <aside class="settings-nav">，没有 id；靠 #settings-modal 加属性选择器定位。
 * - 帮助弹窗是原生 <dialog>，用 [open] 判定。
 */
export const states = [
  {
    name: '01-empty',
    batch: 'f1',
    steps: [
      { waitFor: '#new-run-btn' },
      { click: '#new-run-btn' },
      { waitFor: '#empty-view:not(.hidden)' },
      { waitMs: 400 },
    ],
  },
  {
    // 只比 F2 的范围：侧栏 + 对话列。旧版选中会话会自动展开右侧抽屉，抽屉属 F3，
    // 这里用 clip 裁掉右侧面板，避免把 F3 的未实现算成 F2 的视觉回归。
    name: '02-chat-default',
    batch: 'f2',
    clip: { x: 0, y: 0, width: 920, height: 900 },
    steps: [{ waitFor: '#chat-view:not(.hidden)' }, { waitMs: 800 }],
  },
  {
    name: '03-drawer-candidates',
    batch: 'f3',
    steps: [
      { waitFor: '#panel-btn' },
      { click: '#panel-btn' },
      { waitFor: '#drawer:not(.hidden)' },
      { waitMs: 900 },
    ],
  },
  {
    name: '04-settings-models',
    batch: 'f4',
    steps: [
      { click: '#open-settings' },
      { waitFor: '#settings-modal:not(.hidden)' },
      { waitMs: 500 },
    ],
  },
  {
    name: '05-settings-plugins',
    batch: 'f4',
    steps: [
      { click: '#open-settings' },
      { waitFor: '#settings-modal:not(.hidden)' },
      { click: '#settings-modal [data-settings-tab="plugins"]' },
      { waitMs: 700 },
    ],
  },
  {
    name: '06-settings-agents',
    batch: 'f4',
    steps: [
      { click: '#open-settings' },
      { waitFor: '#settings-modal:not(.hidden)' },
      { click: '#settings-modal [data-settings-tab="agents"]' },
      { waitMs: 700 },
    ],
  },
  {
    name: '07-mailbox',
    batch: 'f5',
    steps: [
      { click: '#open-mailbox' },
      { waitFor: '#mailbox-modal:not(.hidden)' },
      { waitMs: 700 },
    ],
  },
  {
    name: '08-knowledge',
    batch: 'f5',
    steps: [
      { click: '#open-knowledge' },
      { waitFor: '#knowledge-modal:not(.hidden)' },
      { waitMs: 700 },
    ],
  },
  {
    name: '09-help',
    batch: 'f5',
    steps: [{ click: '#help-open' }, { waitFor: '#help-dialog[open]' }, { waitMs: 500 }],
  },
  { name: '10-hitl', batch: 'f2', manual: true, reason: '需要一次运行中的 HITL 暂停，F2 用受控 run 造出来' },
  { name: '11-approval', batch: 'f2', manual: true, reason: '需要严格模式下的一次待审批运行，F2 造出来' },
  { name: '12-preview', batch: 'f3', manual: true, reason: '需要会话里已产出文件，F3 造出来' },
];
