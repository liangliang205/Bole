import type { ReactElement } from 'react';
import { useUiStore } from '../../store/ui.ts';

/**
 * 招聘邮箱弹窗：结构与 index.html 的 #mailbox-modal 一致。
 * 授权轮询、适配器编辑器与偏好保存尚未接入（后续批次）。
 */
export function MailboxModal(): ReactElement {
  const open = useUiStore((state) => state.mailboxOpen);
  const close = useUiStore((state) => state.closeMailbox);
  return (
    <div
      id="mailbox-modal"
      className={`modal${open ? '' : ' hidden'}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="mailbox-title"
      onClick={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <section className="modal-card mailbox-card">
        <div className="modal-head">
          <div>
            <h2 id="mailbox-title">招聘邮箱</h2>
            <p className="muted">管理已接入的邮箱，选择伯乐默认使用的邮箱。</p>
          </div>
          <button className="btn ghost" id="mailbox-close" type="button" aria-label="关闭招聘邮箱" onClick={close}>✕</button>
        </div>
        <div className="mailbox-account">
          <div className="mailbox-account-icon" aria-hidden="true">✉</div>
          <div>
            <span className="muted">当前邮箱</span>
            <div id="mail-status" role="status" aria-live="polite">尚未检查连接</div>
          </div>
          <div className="mailbox-account-actions">
            <button type="button" className="btn" id="mail-auth">认证邮箱</button>
            <button type="button" className="btn ghost" id="mail-test">检查邮箱连接</button>
          </div>
        </div>
        <div id="mail-auth-panel" className="mail-auth-panel hidden" role="status" aria-live="polite">
          <p id="mail-auth-message" />
          <div id="mail-auth-links" />
        </div>
        <label className="mailbox-provider-label">
          已接入的邮箱
          <select id="mail-provider" className="input"><option value="">请选择邮箱连接</option></select>
        </label>
        <p className="muted" id="mail-selection-note" role="status">选择后自动保存。接入邮箱和收取简历，请直接在主页与伯乐对话。</p>
        <button id="mail-plugin-add" type="button" className="btn ghost hidden">添加邮箱插件</button>
        <details className="mailbox-adapter-editor hidden">
          <summary>高级连接配置</summary>
          <p className="muted">由伯乐根据已安装插件的接口说明维护。</p>
          <label>关联 Skill<select id="mail-adapter-skill" className="input"><option value="">独立 CLI（不关联 Skill）</option></select></label>
          <label>适配器配置<textarea id="mail-adapter-config" className="input" rows={12} spellCheck={false} aria-label="邮箱适配器 JSON 配置" /></label>
          <button id="mail-adapter-template" type="button" className="btn ghost">填入通用示例</button>
          <button id="mail-adapter-save" type="button" className="btn">保存适配器</button>
          <p id="mail-adapter-status" className="settings-status" role="status" />
        </details>
        <div className="mailbox-preferences hidden">
          <h3>简历收取范围</h3>
          <label className="mailbox-enabled"><input type="checkbox" id="new-mail-enabled" readOnly /> 新建筛选时从招聘邮箱收取简历</label>
          <div className="form-grid">
            <label className="span-2">邮件关键词<input id="new-mail-query" className="input" maxLength={300} placeholder="如：全栈（留空检索收件箱附件）" /><small className="muted">搜索邮件主题和正文，岗位匹配由伯乐评估。</small></label>
            <label>起始日期<input id="new-mail-after" className="input" type="date" /></label>
            <label>最多检查邮件<input id="new-mail-limit" className="input" type="number" min={1} max={200} defaultValue={50} /><small className="muted">每次 1–200 封，默认 50 封。</small></label>
          </div>
          <p className="settings-status" id="mailbox-settings-status" role="status">收取范围用于下一次新建筛选，不改变已运行的任务。</p>
        </div>
        <button type="button" className="btn primary hidden" id="mailbox-new-run">使用邮箱新建筛选</button>
      </section>
    </div>
  );
}
