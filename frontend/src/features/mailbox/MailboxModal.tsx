import { useMutation, useQuery } from '@tanstack/react-query';
import { IconX } from '../../components/icons.tsx';
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { api } from '../../api/client.ts';
import { useUiStore } from '../../store/ui.ts';

interface MailAdapter {
  id: string;
  name?: string;
  builtin?: boolean;
  skillId?: string;
}

interface MailStatus {
  ok: boolean;
  error?: string;
  email?: string;
  aliases?: { email?: string }[];
  [key: string]: unknown;
}

/**
 * 招聘邮箱弹窗：结构与 index.html 的 #mailbox-modal 一致。
 * 已接：适配器列表、连接状态检查、邮箱选择。
 * 未接：授权轮询、适配器编辑器、收取范围偏好（这些依赖 CLI 交互或额外接口）。
 */
export function MailboxModal(): ReactElement {
  const open = useUiStore((state) => state.mailboxOpen);
  // 与设置弹窗一致：Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') useUiStore.getState().closeMailbox();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);
  const close = useUiStore((state) => state.closeMailbox);
  const [providerId, setProviderId] = useState('agently-mail');
  const [statusText, setStatusText] = useState('尚未检查连接');
  const [statusTone, setStatusTone] = useState('');
  const [busy, setBusy] = useState(false);

  const adapterTemplate = (): string => JSON.stringify({
    id: 'my-mail',
    name: '我的邮箱',
    command: 'node',
    baseArgs: ['mail-cli.js'],
    operations: {
      identity: { args: ['identity'], resultPath: 'data' },
      search: { args: ['search'], resultPath: 'data' },
      read: { args: ['read'], resultPath: 'data' },
      download: { args: ['download'], resultPath: 'data' },
      send: { args: ['send'], resultPath: 'data' },
    },
    fields: {
      email: 'email', items: 'items', messageId: 'message_id', sender: 'from.email',
      attachments: 'attachments', attachmentId: 'attachment_id', filename: 'filename', savedPath: 'saved_to',
    },
  }, null, 2);

  const fillTemplate = (): void => {
    const textarea = document.getElementById('mail-adapter-config') as HTMLTextAreaElement | null;
    if (textarea) textarea.value = adapterTemplate();
    setStatusText('已填入通用示例，按实际 CLI 修改后保存。');
    setStatusTone('');
  };

  const saveAdapter = async (): Promise<void> => {
    const raw = (document.getElementById('mail-adapter-config') as HTMLTextAreaElement | null)?.value ?? '';
    if (!raw.trim()) {
      setStatusText('请先填写适配器 JSON 配置。');
      setStatusTone('');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      setStatusText(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
      setStatusTone('');
      return;
    }
    setBusy(true);
    try {
      await api('/api/mail/adapters', { method: 'POST', body: JSON.stringify(parsed) });
      setStatusText('适配器已保存。');
      setStatusTone('mailbox-connected');
      await adapters.refetch();
    } catch (error) {
      setStatusText(`保存失败：${error instanceof Error ? error.message : String(error)}`);
      setStatusTone('');
    } finally {
      setBusy(false);
    }
  };

  const adapters = useQuery({
    queryKey: ['mail-adapters'],
    queryFn: async () => (await api<{ adapters?: MailAdapter[] }>('/api/mail/adapters')).adapters ?? [],
    enabled: open,
    staleTime: 30_000,
  });

  const check = useMutation({
    mutationFn: async (id: string) => {
      try {
        const data = await api<MailStatus>(`/api/mail/status?providerId=${encodeURIComponent(id)}`);
        return data;
      } catch (error) {
        // 未授权时服务端返回 ok:false，api() 会抛错，这里把它当作可展示的状态
        return { ok: false, error: error instanceof Error ? error.message : String(error) } as MailStatus;
      }
    },
    onSuccess: (data) => {
      if (data.ok) {
        const email = data.email ?? data.aliases?.[0]?.email ?? '';
        setStatusText(email ? `已连接：${email}` : '连接正常');
        setStatusTone('mailbox-connected');
      } else {
        setStatusText(data.error ?? '未连接');
        setStatusTone('');
      }
    },
  });

  // 打开弹窗时检查一次连接状态；切换 provider 由下拉单独触发
  useEffect(() => {
    if (!open) return;
    void check.mutateAsync(providerId).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
          <button className="btn ghost" id="mailbox-close" type="button" aria-label="关闭招聘邮箱" onClick={close}><IconX size={14} /></button>
        </div>
        <div className="mailbox-account">
          <div className="mailbox-account-icon" aria-hidden="true">✉</div>
          <div>
            <span className="muted">当前邮箱</span>
            <div id="mail-status" role="status" aria-live="polite" className={statusTone || undefined}>
              {check.isPending ? '正在检查…' : statusText}
            </div>
          </div>
          <div className="mailbox-account-actions">
            <button
              type="button"
              className="btn"
              id="mail-auth"
              onClick={() => {
                setStatusText('邮箱授权需要在主页与伯乐对话完成：说明邮箱与授权方式，伯乐会引导你执行 agently-cli 登录。');
                setStatusTone('');
              }}
            >
              认证邮箱
            </button>
            <button
              type="button"
              className="btn ghost"
              id="mail-test"
              disabled={check.isPending}
              onClick={() => { void check.mutateAsync(providerId).catch(() => undefined); }}
            >
              检查邮箱连接
            </button>
          </div>
        </div>
        <div id="mail-auth-panel" className="mail-auth-panel hidden" role="status" aria-live="polite">
          <p id="mail-auth-message" />
          <div id="mail-auth-links" />
        </div>
        <label className="mailbox-provider-label">
          已接入的邮箱
          <select
            id="mail-provider"
            className="input"
            value={providerId}
            onChange={(event) => { setProviderId(event.target.value); void check.mutateAsync(event.target.value).catch(() => undefined); }}
          >
            {(adapters.data ?? []).length === 0 ? <option value="">请选择邮箱连接</option> : null}
            {(adapters.data ?? []).map((adapter) => (
              <option key={adapter.id} value={adapter.id}>
                {adapter.name ?? adapter.id}{adapter.builtin ? '（内置）' : ''}
              </option>
            ))}
          </select>
        </label>
        <p className="muted" id="mail-selection-note" role="status">选择后自动保存。接入邮箱和收取简历，请直接在主页与伯乐对话。</p>
        <button id="mail-plugin-add" type="button" className="btn ghost hidden">添加邮箱插件</button>
        <details className="mailbox-adapter-editor">
          <summary>高级连接配置</summary>
          <p className="muted">由伯乐根据已安装插件的接口说明维护。</p>
          <label>关联 Skill<select id="mail-adapter-skill" className="input"><option value="">独立 CLI（不关联 Skill）</option></select></label>
          <label>适配器配置<textarea id="mail-adapter-config" className="input" rows={12} spellCheck={false} aria-label="邮箱适配器 JSON 配置" defaultValue={(adapters.data?.[0] as unknown as Record<string, unknown> | undefined) ? JSON.stringify(adapters.data?.[0] ?? {}, null, 2) : ''} /></label>
          <button id="mail-adapter-template" type="button" className="btn ghost" onClick={fillTemplate}>填入通用示例</button>
          <button id="mail-adapter-save" type="button" className="btn" disabled={busy} onClick={() => { void saveAdapter(); }}>保存适配器</button>
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
