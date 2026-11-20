import { useRef, useState } from 'react';
import type { ChangeEvent, ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { useUiStore } from '../../store/ui.ts';

const MODE_LABEL: Record<string, string> = { default: '默认模式', strict: '严格模式' };
const MAX_FILE_BYTES = 25 * 1024 * 1024;

interface Attachment {
  id: string;
  filename: string;
  size: number;
  status: 'uploading' | 'uploaded' | 'error';
  uploadId: string;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * 新建会话页（hero + composer）。
 * 结构、id、类名与 index.html 的 #empty-view 一致；提交走旧实现的两条路径：
 * 与旧版一致：先 /api/uploads 上传简历，再 POST /api/run 起流水线；没有纯文本对话路径。
 */
export function EmptyView({ hidden = false }: { hidden?: boolean }): ReactElement {
  const [modeOpen, setModeOpen] = useState(false);
  const [mode, setMode] = useState<'default' | 'strict'>('default');
  const [mailOpen, setMailOpen] = useState(false);
  const [requirements, setRequirements] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [hint, setHint] = useState('');
  const [hintError, setHintError] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const setActiveJob = useUiStore((state) => state.setActiveJob);
  const queryClient = useQueryClient();
  // 默认团队 / 默认评分标准在「设置」里维护，这里只读取
  const teamKey = useUiStore((state) => state.defaultTeamKey);
  const policyVersionId = useUiStore((state) => state.defaultPolicyVersionId);

  const showHint = (message: string, isError = false): void => {
    setHint(message);
    setHintError(isError);
  };

  const upload = async (files: FileList): Promise<void> => {
    for (const file of Array.from(files)) {
      if (file.size > MAX_FILE_BYTES) {
        showHint(`${file.name} 超过 25MB`, true);
        continue;
      }
      const id = `local_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
      setAttachments((list) => [...list, { id, filename: file.name, size: file.size, status: 'uploading', uploadId: '' }]);
      try {
        const contentBase64 = await fileToBase64(file);
        const data = await api<{ upload: { uploadId: string } }>('/api/uploads', {
          method: 'POST',
          body: JSON.stringify({ filename: file.name, contentBase64 }),
        });
        setAttachments((list) => list.map((item) => (item.id === id ? { ...item, status: 'uploaded', uploadId: data.upload.uploadId } : item)));
      } catch (error) {
        setAttachments((list) => list.map((item) => (item.id === id ? { ...item, status: 'error' } : item)));
        showHint(`${file.name} 上传失败：${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  };

  const start = async (): Promise<void> => {
    const text = requirements.trim();
    const uploaded = attachments.filter((item) => item.status === 'uploaded');
    // 与旧版一致：必须至少上传一份简历，没有纯文本对话这条路径
    if (text.length < 5) {
      showHint('请填写至少 5 个字符的招聘需求', true);
      return;
    }
    if (uploaded.length === 0) {
      showHint('请上传简历或选择从招聘邮箱收取', true);
      return;
    }
    if (attachments.some((item) => item.status !== 'uploaded')) {
      showHint('请等待简历上传完成，或移除上传失败的文件', true);
      return;
    }
    setBusy(true);
    showHint('正在创建会话并启动真实模型流水线…');
    try {
      const data = await api<{ jobId: string }>('/api/run', {
        method: 'POST',
        body: JSON.stringify({
          requirements: text,
          uploadIds: uploaded.map((item) => item.uploadId),
          executionMode: mode,
          agentTeamKey: teamKey || undefined,
          policyVersionId: policyVersionId || undefined,
        }),
      });
      setRequirements('');
      setAttachments([]);
      showHint('');
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      setActiveJob(data.jobId);
    } catch (error) {
      showHint(`启动失败：${error instanceof Error ? error.message : String(error)}`, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="empty-view" className={`empty-view${hidden ? ' hidden' : ''}`}>
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
              value={requirements}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setRequirements(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void start(); } }}
            />
            <div id="new-attachments" className="attachments">
              {attachments.map((item) => (
                <span className={`chat-attachment ${item.status}`} key={item.id}>
                  <span className="name">{item.filename}</span>
                  <button
                    type="button"
                    aria-label={`移除 ${item.filename}`}
                    onClick={() => setAttachments((list) => list.filter((entry) => entry.id !== item.id))}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
            <div className="dsh-composer-row">
              <div className="dsh-composer-tools">
                <button
                  className="dsh-composer-add"
                  id="attach-btn"
                  type="button"
                  title="添加简历 · PDF / DOCX / 图片 / TXT / HTML，单文件 ≤25MB"
                  aria-label="添加简历"
                  onClick={() => fileInput.current?.click()}
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                    <path d="M8 3.25v9.5M3.25 8h9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  id="file-input"
                  onChange={(event) => { const files = event.target.files; if (files && files.length > 0) void upload(files); event.target.value = ''; }}
                />
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
                  <div id="mode-menu" className={`mode-menu ${modeOpen ? '' : 'hidden'}`} role="menu" aria-label="执行模式">
                    <button type="button" role="menuitemradio" aria-checked={mode === 'default'} data-mode="default" onClick={() => { setMode('default'); setModeOpen(false); }}>
                      <span>默认模式<small>按流程自动执行</small></span><span className="mode-check" aria-hidden="true">✓</span>
                    </button>
                    <button type="button" role="menuitemradio" aria-checked={mode === 'strict'} data-mode="strict" onClick={() => { setMode('strict'); setModeOpen(false); }}>
                      <span>严格模式<small>计划、工具与发布需审批</small></span><span className="mode-check" aria-hidden="true">✓</span>
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
                  <div id="mail-source-menu" className={`mode-menu ${mailOpen ? '' : 'hidden'}`} role="menu" aria-label="简历来源">
                    <button type="button" role="menuitemradio" className="hidden" aria-checked={false} data-mail-source="mail">
                      <span>从招聘邮箱收取</span>
                    </button>
                    <button type="button" role="menuitemradio" className="hidden" aria-checked data-mail-source="upload">
                      <span>仅使用上传简历</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      id="mail-source-settings"
                      onClick={() => {
                        setMailOpen(false);
                        setRequirements((text) => (text.trim()
                          ? text
                          : '请帮我接入招聘邮箱：说明需要准备什么、授权步骤，以及如何按岗位收取简历。'));
                        document.getElementById('new-requirements')?.focus();
                      }}
                    >
                      <span>让伯乐处理招聘邮箱<small>直接说明接入方式、时间范围和人才要求</small></span>
                      <span aria-hidden="true">›</span>
                    </button>
                  </div>
                </div>
              </div>
              <button
                className={`dsh-composer-primary${busy ? ' is-sending' : ''}`}
                id="new-start"
                title="发送"
                aria-label="发送"
                disabled={busy}
                onClick={() => { void start(); }}
              >
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                  <path d="M8 13V3m-4 4 4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>
        </div>
        <div id="new-hint" className={`hint ${hintError ? 'error' : ''}`}>{hint}</div>
      </div>
    </section>
  );
}
