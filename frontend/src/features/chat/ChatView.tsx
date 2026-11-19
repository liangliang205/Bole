import { useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useChatMessages, useRun, useRunEvents, formatClock, type ChatMessage, type RunEvent } from '../../api/run.ts';
import { api } from '../../api/client.ts';
import { Markdown } from '../../components/Markdown.tsx';
import { useRunStream } from '../../hooks/useRunStream.ts';
import { useStreamingText } from '../../store/stream.ts';
import { ApprovalHost, HitlHost, type PendingHitl, type RunApproval } from './Hosts.tsx';

const MILESTONES = new Set([
  'jd.analyzed', 'fetch.completed', 'hitl.question', 'hitl.answered', 'escalate.human',
  'run.failed', 'report.generated', 'report.exported',
]);

const AGENT_NAMES: Record<string, string> = {
  coordinator: '伯乐', profiler: '画像师', fetcher: '探马', parser: '录事',
  assessor: '相马官', auditor: '监军', advisor: '谋士',
};

function agentName(actor: string | undefined): string {
  const key = String(actor ?? '').split('#')[0];
  return AGENT_NAMES[key] ?? key ?? '系统';
}

function payloadOf(event: RunEvent): Record<string, unknown> {
  return event.payload ?? {};
}

/** 事件行文案：只覆盖对话里真正会显示的节点；完整 44 条映射留给抽屉（F3）。 */
function eventLine(event: RunEvent): { title: string; detail: string; agent: string } {
  const payload = payloadOf(event);
  const label = payload.label ? `${String(payload.label)} ` : '';
  const agent = agentName(event.actor);
  switch (event.type) {
    case 'run.created': return { title: '运行已创建', detail: `provider=${String(payload.provider ?? '')}`, agent };
    case 'jd.analyzed': return { title: `JD 已结构化：${String(payload.title ?? '')}`, detail: `${String(payload.dimensions ?? 0)} 个评分维度`, agent };
    case 'fetch.started': return { title: `开始接入 ${String(payload.files ?? '')} 份简历`, detail: '', agent };
    case 'fetch.completed': return { title: '简历接入完成', detail: `成功 ${String(payload.pulled ?? 0)} · 重复 ${String(payload.duplicates ?? 0)} · 失败 ${String(payload.failed ?? 0)}`, agent };
    case 'resume.fetched': return { title: `${label}接入成功`, detail: `${String(payload.filename ?? '')} · ${String(payload.format ?? '')} · ${String(payload.chars ?? '')} 字符`, agent };
    case 'hitl.question': return { title: '需要你确认', detail: String(payload.question ?? ''), agent };
    case 'hitl.answered': return { title: '你的回答', detail: String(payload.answer ?? ''), agent };
    case 'escalate.human': return { title: `${label}转人工`, detail: String(payload.reason ?? ''), agent };
    case 'report.generated': return { title: '报告已生成', detail: '', agent };
    case 'report.exported': return { title: '终稿文件已导出', detail: (Array.isArray(payload.formats) ? payload.formats : []).join(' · '), agent };
    case 'run.completed': return { title: '运行完成', detail: '', agent };
    case 'run.failed': return { title: '运行失败', detail: String(payload.error ?? ''), agent };
    default: return { title: event.type, detail: JSON.stringify(payload).slice(0, 160), agent };
  }
}

function Message({ kind, name, time, children }: {
  kind: 'user' | 'assistant' | 'tool';
  name: string;
  time: string;
  children: ReactNode;
}): ReactElement {
  const avatar = kind === 'user' ? '你' : kind === 'assistant' ? '伯' : '⚙';
  return (
    <div className={`msg ${kind}`}>
      <div className="msg-avatar">{avatar}</div>
      <div className="msg-body">
        <div className="msg-head"><span className="msg-name">{name}</span><span className="msg-time">{time}</span></div>
        {children}
      </div>
    </div>
  );
}

function ChatMessageRow({ message, jobId }: { message: ChatMessage; jobId: string }): ReactElement {
  const isUser = message.role === 'user';
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  return (
    <Message kind={isUser ? 'user' : 'assistant'} name={isUser ? 'HR' : '伯乐'} time={formatClock(message.created_ts)}>
      <div className="msg-text chat-markdown"><Markdown source={message.content ?? ''} /></div>
      {attachments.length > 0 ? (
        <div className="msg-attachments">
          {attachments.map((attachment) => (
            <span className="chat-attachment" key={attachment.name}><span className="name">{attachment.name}</span></span>
          ))}
        </div>
      ) : null}
      {Array.isArray(message.files) && message.files.length > 0 ? <FileCards files={message.files} jobId={jobId} /> : null}
    </Message>
  );
}

function FileCards({ files, jobId }: { files: string[]; jobId: string }): ReactElement {
  return (
    <div className="file-grid">
      {files.map((file) => {
        const name = file.split(/[\\/]/).pop() ?? file;
        const isPdf = /\.pdf$/i.test(name);
        return (
          <div className="file-card" data-preview-file={name} role="button" tabIndex={0} title={`预览 ${name}`} key={name}>
            <span className={`file-icon ${isPdf ? 'pdf' : 'word'}`}>{isPdf ? 'PDF' : 'W'}</span>
            <span className="file-meta">
              <span className="file-name">{name}</span>
              <span className="file-desc">{isPdf ? '只读文件，适合分发与归档' : '可编辑文档，适合修改与签字'}</span>
            </span>
            <a className="file-download" href={`/api/run/${encodeURIComponent(jobId)}/files/${encodeURIComponent(name)}`} download title={`下载 ${name}`}>↓</a>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 对话流：复刻 app.js 的 renderChat——需求气泡、里程碑消息、执行轨迹折叠组、历史消息。
 * HITL / 审批 / 流式输出在后续步骤接入。
 */
export function ChatView({ jobId, hidden }: { jobId: string; hidden: boolean }): ReactElement {
  const { data: runData } = useRun(jobId);
  const { data: events = [] } = useRunEvents(jobId);
  const { data: messages = [] } = useChatMessages(jobId);
  const snapshot = runData?.snapshot ?? {};
  const run = runData?.run ?? {};
  const job = snapshot.job ?? {};
  const queryClient = useQueryClient();
  useRunStream(jobId, queryClient);
  const streamingText = useStreamingText();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLDivElement>(null);

  const pendingHitl = (run as { pendingHitl?: PendingHitl | null }).pendingHitl ?? null;
  const approvals = ((run as { approvals?: RunApproval[] }).approvals) ?? [];
  const executionMode = (run as { executionMode?: string }).executionMode;

  const refreshRun = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['run', jobId] });
    await queryClient.invalidateQueries({ queryKey: ['events', jobId] });
    await queryClient.invalidateQueries({ queryKey: ['chat', jobId] });
  };

  const answerHitl = async (answer: string): Promise<void> => {
    if (sending || !answer) return;
    setSending(true);
    try {
      await api(`/api/run/${encodeURIComponent(jobId)}/hitl`, {
        method: 'POST',
        body: JSON.stringify({ answer, actor: 'HR(web)' }),
      });
      await refreshRun();
    } finally {
      setSending(false);
    }
  };

  const decideApproval = async (approvalId: string, decision: 'approve' | 'reject'): Promise<void> => {
    if (sending) return;
    setSending(true);
    try {
      const data = await api<{ resumeRequired?: boolean }>(
        `/api/run/${encodeURIComponent(jobId)}/approvals/${encodeURIComponent(approvalId)}`,
        { method: 'POST', body: JSON.stringify({ decision }) },
      );
      if (data.resumeRequired) {
        await api(`/api/run/${encodeURIComponent(jobId)}/resume`, { method: 'POST' });
      }
      await refreshRun();
    } finally {
      setSending(false);
    }
  };

  const send = async (): Promise<void> => {
    const content = (inputRef.current?.innerText ?? '').replace(/\u00a0/g, ' ').trim();
    if (!content || sending) return;
    setSending(true);
    try {
      await api(`/api/run/${encodeURIComponent(jobId)}/chat`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      });
      setDraft('');
      if (inputRef.current) inputRef.current.innerText = '';
      await queryClient.invalidateQueries({ queryKey: ['chat', jobId] });
      await queryClient.invalidateQueries({ queryKey: ['run', jobId] });
    } catch (error) {
      setDraft(`发送失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSending(false);
    }
  };

  const body = useMemo(() => {
    const parts: ReactElement[] = [];
    const fileNames = [...new Set(events
      .filter((event) => event.type === 'resume.fetched' || event.type === 'resume.fetch_failed')
      .map((event) => payloadOf(event).filename)
      .filter((name): name is string => typeof name === 'string' && name.length > 0))];

    if (job.seed !== 'workspace-chat') {
      parts.push(
        <Message key="requirements" kind="user" name="HR" time={formatClock(job.created_ts)}>
          <div className="msg-text">{job.requirements ?? ''}</div>
          {fileNames.length > 0 ? (
            <div className="attach-chips">
              {fileNames.map((name) => <span className="chip" key={name}><span className="name">{name}</span></span>)}
            </div>
          ) : null}
        </Message>,
      );
    }

    let toolGroup: RunEvent[] = [];
    const flushTools = (): void => {
      if (toolGroup.length === 0) return;
      parts.push(
        <Message key={`tools-${toolGroup[0].seq ?? parts.length}`} kind="tool" name="执行轨迹" time="">
          <details className="msg-tools" open={run.status === 'running'}>
            <summary>工具调用 · {toolGroup.length} 条</summary>
            {toolGroup.map((event, index) => {
              const line = eventLine(event);
              return (
                <div className="tool-row" key={`${event.seq ?? index}`}>
                  <span className="tool-agent">{line.agent}</span>
                  <span className="tool-title">{line.title}{line.detail ? `：${line.detail}` : ''}</span>
                  <span className="tool-time">{formatClock(event.ts)}</span>
                </div>
              );
            })}
          </details>
        </Message>,
      );
      toolGroup = [];
    };

    for (const event of events) {
      if (event.type.startsWith('workflow.')) continue;
      if (!MILESTONES.has(event.type)) {
        toolGroup.push(event);
        continue;
      }
      flushTools();
      const payload = payloadOf(event);
      const time = formatClock(event.ts);
      if (event.type === 'jd.analyzed') {
        parts.push(
          <Message key={`jd-${event.seq ?? parts.length}`} kind="assistant" name="画像师" time={time}>
            <div className="msg-text">
              岗位已结构化：<strong>{String(payload.title ?? '')}</strong>。{String(payload.dimensions ?? 0)} 个评分维度，已剥离 {String(payload.removedProtected ?? 0)} 项受保护条件。
            </div>
          </Message>,
        );
      } else if (event.type === 'fetch.completed') {
        parts.push(
          <Message key={`fetch-${event.seq ?? parts.length}`} kind="assistant" name="探马" time={time}>
            <div className="msg-text">简历接入完成：成功 {String(payload.pulled ?? 0)} 份，重复 {String(payload.duplicates ?? 0)} 份，失败 {String(payload.failed ?? 0)} 份。</div>
          </Message>,
        );
      } else if (event.type === 'hitl.question') {
        parts.push(
          <Message key={`hitl-${event.seq ?? parts.length}`} kind="assistant" name="伯乐" time={time}>
            <div className="msg-text">{String(payload.question ?? '')}</div>
          </Message>,
        );
      } else if (event.type === 'hitl.answered') {
        parts.push(
          <Message key={`answer-${event.seq ?? parts.length}`} kind="user" name="HR" time={time}>
            <div className="msg-text">{String(payload.answer ?? '')}</div>
          </Message>,
        );
      } else if (event.type === 'escalate.human') {
        parts.push(
          <Message key={`escalate-${event.seq ?? parts.length}`} kind="assistant" name="监军" time={time}>
            <div className="msg-text"><strong>{String(payload.label ?? '')}</strong> 已转人工：{String(payload.reason ?? '')}</div>
          </Message>,
        );
      } else if (event.type === 'run.failed') {
        parts.push(
          <Message key={`failed-${event.seq ?? parts.length}`} kind="assistant" name="伯乐" time={time}>
            <div className="msg-text">运行失败：{String(payload.error ?? '')}</div>
          </Message>,
        );
      } else if (event.type === 'report.exported') {
        const files = Array.isArray(payload.files) ? payload.files.filter((item): item is string => typeof item === 'string') : [];
        const summary = String(payload.summary ?? '').trim();
        const text = summary || (files.length > 0 ? '终稿已生成，已按对话需求导出以下文件。' : '本次没有导出文件。');
        parts.push(
          <Message key={`exported-${event.seq ?? parts.length}`} kind="assistant" name="伯乐" time={time}>
            <div className="msg-text">{text}</div>
            {files.length > 0 ? <FileCards files={files} jobId={jobId} /> : null}
          </Message>,
        );
      } else {
        toolGroup.push(event);
      }
    }
    flushTools();

    for (const message of messages) {
      parts.push(<ChatMessageRow key={`chat-${message.created_ts}-${parts.length}`} message={message} jobId={jobId} />);
    }
    return parts;
  }, [events, job, jobId, messages, run.status]);

  return (
    <section id="chat-view" className={`chat-view${hidden ? ' hidden' : ''}`}>
      <div id="chat-scroll" className="chat-scroll">{body}</div>
      <div id="stream-host" className="stream-host">
        {streamingText ? (
          <div className="stream-card">
            <div className="stream-head">
              <span className="stream-agent">伯乐</span>
              <span className="stream-phase">生成中</span>
            </div>
            <div className="stream-preview">{streamingText}</div>
          </div>
        ) : null}
      </div>
      <HitlHost pending={pendingHitl} busy={sending} onAnswer={(answer) => { void answerHitl(answer); }} />
      <ApprovalHost approvals={approvals} executionMode={executionMode} busy={sending} onDecide={(id, decision) => { void decideApproval(id, decision); }} />
      <div className="composer-wrap dsh-composer">
        <div className="dsh-composer-notice hidden" id="reply-hint" />
        <div className="dsh-composer-card">
          <div id="chat-attachments" className="dsh-composer-attachments" />
          <div className="dsh-composer-scroll">
            <div className="dsh-composer-grow">
              <div
                id="reply-input"
                ref={inputRef}
                onInput={(event) => setDraft(event.currentTarget.innerText)}
                className="dsh-composer-input"
                contentEditable
                role="textbox"
                aria-multiline="true"
                spellCheck
                data-placeholder="回答 HITL 问题，或点击上方选项…"
              />
            </div>
          </div>
          <div className="dsh-composer-row">
            <div className="dsh-composer-tools">
              <button className="dsh-composer-add" id="chat-attach-btn" type="button" title="添加图片、PDF、Word、Markdown 文件" aria-label="添加附件">
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path d="M8 3.25v9.5M3.25 8h9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className="dsh-composer-trailing">
              <span className="dsh-composer-model" id="reply-model" />
              <button className="dsh-composer-primary" id="reply-send" aria-label="发送" disabled={sending || draft.trim().length === 0} onClick={() => { void send(); }}>
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                  <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
