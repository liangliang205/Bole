import { useState } from 'react';
import type { ReactElement } from 'react';

const MODE_LABEL: Record<string, string> = { default: '默认模式', strict: '严格模式' };

/**
 * 新建会话页（hero + composer）。
 * 结构、id、类名与 index.html 的 #empty-view 逐字对齐；提交逻辑留给 F2。
 */
export function EmptyView(): ReactElement {
  const [modeOpen, setModeOpen] = useState(false);
  const [mode, setMode] = useState<'default' | 'strict'>('default');
  const [mailOpen, setMailOpen] = useState(false);

  return (
    <section id="empty-view" className="empty-view">
      <div className="hero">
        <h1>今天想寻找什么样的人才？</h1>
        <p className="hero-copy">描述招聘需求，或直接告诉伯乐如何接入你的招聘邮箱。</p>
        <div className="new-composer dsh-composer">
          <div className="composer dsh-composer-card">
            <textarea
              id="new-requirements"
              rows={3}
              aria-label="招聘需求或消息"
              placeholder="描述招聘需求，或粘贴邮箱安装文档，让伯乐帮你接入…"
            />
            <div id="new-attachments" className="attachments" />
            <div className="dsh-composer-row">
              <div className="dsh-composer-tools">
                <button
                  className="dsh-composer-add"
                  id="attach-btn"
                  type="button"
                  title="添加简历 · PDF / DOCX / 图片 / TXT / HTML，单文件 ≤25MB"
                  aria-label="添加简历"
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                    <path d="M8 3.25v9.5M3.25 8h9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
                <div className="mode-picker">
                  <input id="new-execution-mode" type="hidden" value={mode} readOnly />
                  <button
                    id="mode-trigger"
                    className="mode-trigger"
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={modeOpen}
                    aria-controls="mode-menu"
                    title="修改执行模式"
                    onClick={() => setModeOpen((open) => !open)}
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                      <path d="M8 1.5 13 3.5v4c0 3-5 6.5-5 6.5S3 10.5 3 7.5v-4Z" fill="none" stroke="currentColor" strokeWidth="1.2" />
                    </svg>
                    <span id="mode-label">{MODE_LABEL[mode]}</span>
                    <span className="mode-chevron" aria-hidden="true">⌃</span>
                  </button>
                  <div
                    id="mode-menu"
                    className={`mode-menu ${modeOpen ? '' : 'hidden'}`}
                    role="menu"
                    aria-label="执行模式"
                  >
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={mode === 'default'}
                      data-mode="default"
                      onClick={() => { setMode('default'); setModeOpen(false); }}
                    >
                      <span>默认模式<small>按流程自动执行</small></span>
                      <span className="mode-check" aria-hidden="true">✓</span>
                    </button>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={mode === 'strict'}
                      data-mode="strict"
                      onClick={() => { setMode('strict'); setModeOpen(false); }}
                    >
                      <span>严格模式<small>计划、工具与发布需审批</small></span>
                      <span className="mode-check" aria-hidden="true">✓</span>
                    </button>
                  </div>
                </div>
                <div className="mode-picker mail-source-picker">
                  <button
                    className="mode-trigger"
                    id="new-mail-summary"
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={mailOpen}
                    aria-controls="mail-source-menu"
                    onClick={() => setMailOpen((open) => !open)}
                  >
                    <span aria-hidden="true">✉</span><span>招聘邮箱</span>
                    <span id="new-mail-source-state" className="mail-source-state">未启用</span>
                    <span aria-hidden="true">⌃</span>
                  </button>
                  <div
                    id="mail-source-menu"
                    className={`mode-menu ${mailOpen ? '' : 'hidden'}`}
                    role="menu"
                    aria-label="简历来源"
                  >
                    <button type="button" role="menuitemradio" className="hidden" aria-checked={false} data-mail-source="mail">
                      <span>从招聘邮箱收取</span>
                    </button>
                    <button type="button" role="menuitemradio" className="hidden" aria-checked data-mail-source="upload">
                      <span>仅使用上传简历</span>
                    </button>
                    <button type="button" role="menuitem" id="mail-source-settings">
                      <span>让伯乐处理招聘邮箱<small>直接说明接入方式、时间范围和人才要求</small></span>
                      <span aria-hidden="true">›</span>
                    </button>
                  </div>
                </div>
              </div>
              <button className="dsh-composer-primary" id="new-start" title="发送" aria-label="发送">
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                  <path d="M8 13V3m-4 4 4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>
        </div>
        <div id="new-hint" className="hint" />
      </div>
    </section>
  );
}
