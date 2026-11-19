import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { api } from '../../api/client.ts';
import { useUiStore } from '../../store/ui.ts';
import { AgentsPanel, MemoryPanel } from './AgentSettings.tsx';

type SettingsTab = 'models' | 'plugins' | 'agents' | 'memory';

const NAV: { key: SettingsTab; label: string }[] = [
  { key: 'models', label: '模型' },
  { key: 'plugins', label: '插件' },
  { key: 'agents', label: 'Agent 团队' },
  { key: 'memory', label: '岗位与评分标准' },
];

interface Provider {
  id: string;
  name?: string;
  baseUrl?: string;
  api?: string;
  flashModel?: string;
  proModel?: string;
  builtin?: boolean;
}

interface McpPlugin {
  id: string;
  name?: string;
  enabled?: boolean;
  transport?: string;
  command?: string;
  args?: string[];
  url?: string;
  allowTools?: string[];
  source?: string;
  hasCredentials?: boolean;
  runtime?: { state?: string; label?: string; tools?: number; error?: string };
}

const readValue = (id: string): string => (document.getElementById(id) as HTMLInputElement | null)?.value?.trim() ?? '';

/** 模型页：提供商列表 + 新增/编辑/测试/删除 + 模型发现。编辑时用独立面板替换列表，避免看不出在改哪一条。 */
function ModelsSection({ open }: { open: boolean }): ReactElement {
  const close = useUiStore((state) => state.closeSettings);
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<{ mode: 'create' | 'edit'; provider?: Provider } | null>(null);
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['providers'],
    queryFn: async () => (await api<{ providers?: Provider[] }>('/api/providers')).providers ?? [],
    staleTime: 5_000,
  });
  const providers = data ?? [];

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['providers'] });
  };

  /** 已保存的提供商：只带 id + 自身地址，密钥由服务端按 id 取；编辑器里则读表单。 */
  const testConnection = async (provider?: Provider): Promise<void> => {
    setBusy(true);
    try {
      const result = await api<{ models?: { id: string }[]; endpoint?: string }>('/api/providers/discover-models', {
        method: 'POST',
        body: JSON.stringify({
          providerId: provider?.id,
          // 编辑中优先用表单里刚填的值，没填才回落到已保存值
          baseUrl: readValue('provider-base') || provider?.baseUrl,
          api: readValue('provider-api') || provider?.api || 'openai-chat',
          apiKey: provider ? undefined : (readValue('provider-key') || undefined),
        }),
      });
      const models = (result.models ?? []).map((item) => item.id);
      setDiscovered(models);
      const who = provider ? (provider.name || provider.id) : '当前填写';
      setStatus(`${who} 连接正常，发现 ${models.length} 个模型${result.endpoint ? `（${result.endpoint}）` : ''}`);
    } catch (error) {
      setDiscovered([]);
      setStatus(`连接失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const pickModel = (target: 'flash' | 'pro', modelId: string): void => {
    const input = document.getElementById(target === 'flash' ? 'provider-flash' : 'provider-pro') as HTMLInputElement | null;
    if (input) input.value = modelId;
    setStatus(`已把 ${modelId} 填为${target === 'flash' ? '快速' : '深入'}模型`);
  };

  const saveProvider = async (): Promise<void> => {
    const name = readValue('provider-name');
    const baseUrl = readValue('provider-base');
    if (!name || !baseUrl) { setStatus('显示名称与 API 地址都要填。'); return; }
    setBusy(true);
    try {
      const payload = {
        name,
        baseUrl,
        api: readValue('provider-api') || 'openai-chat',
        flashModel: readValue('provider-flash'),
        proModel: readValue('provider-pro'),
        apiKey: readValue('provider-key') || undefined,
      };
      if (editor?.mode === 'edit' && editor.provider) {
        await api(`/api/providers/${encodeURIComponent(editor.provider.id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
        setStatus('提供商已更新。');
      } else {
        await api('/api/providers', { method: 'POST', body: JSON.stringify({ ...payload, id: readValue('provider-id') || undefined }) });
        setStatus('提供商已创建。');
      }
      setEditor(null);
      setDiscovered([]);
      await refresh();
    } catch (error) {
      setStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const removeProvider = async (provider: Provider): Promise<void> => {
    if (!window.confirm(`删除提供商「${provider.name || provider.id}」？使用它的会话将无法继续调用模型。`)) return;
    setBusy(true);
    try {
      await api(`/api/providers/${encodeURIComponent(provider.id)}`, { method: 'DELETE' });
      setStatus(`已删除 ${provider.name || provider.id}。`);
      await refresh();
    } catch (error) {
      setStatus(`删除失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`settings-content${open ? '' : ' hidden'}`} id="settings-models">
      <div className="modal-head"><h2>模型</h2><button className="btn ghost" id="settings-close" onClick={close}>✕</button></div>

      {editor ? (
        <div id="provider-editor" className="provider-editor">
          <div className="provider-editor-head">
            <h3>{editor.mode === 'edit' ? `编辑：${editor.provider?.name || editor.provider?.id}` : '新增模型提供商'}</h3>
            <button className="btn ghost" type="button" onClick={() => { setEditor(null); setDiscovered([]); }}>✕</button>
          </div>
          <div className="form-grid">
            {editor.mode === 'create' ? (
              <label>Provider ID<input id="provider-id" className="input" placeholder="acme-gateway" /></label>
            ) : null}
            <label>显示名称<input id="provider-name" className="input" placeholder="例如 acme-gateway" defaultValue={editor.provider?.name ?? ''} /></label>
            <label className="span-2">API 地址<input id="provider-base" className="input" placeholder="https://gateway.example/v1" defaultValue={editor.provider?.baseUrl ?? ''} /></label>
            <label>API 协议
              <select id="provider-api" className="input" defaultValue={editor.provider?.api ?? 'openai-chat'}>
                <option value="openai-chat">OpenAI Chat Completions</option>
                <option value="openai-responses">OpenAI Responses</option>
                <option value="anthropic-messages">Anthropic Messages</option>
              </select>
            </label>
            <label className="span-2">API 密钥<input id="provider-key" className="input" type="password" placeholder={editor.mode === 'edit' ? '留空保留已保存密钥' : '输入 API 密钥'} /></label>
            <label>Flash 模型<input id="provider-flash" className="input" placeholder="deepseek-v4-flash" defaultValue={editor.provider?.flashModel ?? ''} /></label>
            <label>Pro 模型<input id="provider-pro" className="input" placeholder="deepseek-v4-pro" defaultValue={editor.provider?.proModel ?? ''} /></label>
          </div>
          {discovered.length > 0 ? (
            <div id="model-directory" className="model-directory">
              <p className="muted">发现 {discovered.length} 个模型，点击填入：</p>
              <div className="model-list">
                {discovered.map((modelId) => (
                  <span className="model-row" key={modelId}>
                    <code>{modelId}</code>
                    <button className="link-btn" type="button" onClick={() => pickModel('flash', modelId)}>作快速</button>
                    <button className="link-btn" type="button" onClick={() => pickModel('pro', modelId)}>作深入</button>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          <div className="provider-editor-actions">
            <button className="btn ghost" type="button" disabled={busy} onClick={() => { void testConnection(editor.provider); }}>测试连接</button>
            <span className="settings-status" role="status">{status}</span>
            <span className="spacer" />
            <button className="btn ghost" type="button" onClick={() => { setEditor(null); setDiscovered([]); setStatus(''); }}>取消</button>
            <button className="btn primary" type="button" disabled={busy} onClick={() => { void saveProvider(); }}>
              {editor.mode === 'edit' ? '保存修改' : '创建提供商'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="settings-toolbar">
            <span className="muted" id="provider-count">{providers.length > 0 ? `${providers.length} 个提供商` : ''}</span>
            <button className="btn primary" id="provider-add" onClick={() => { setEditor({ mode: 'create' }); setDiscovered([]); setStatus(''); }}>
              ＋ 添加模型提供商
            </button>
          </div>
          <div id="provider-list" className="provider-list">
            {isLoading ? <div className="provider-empty">读取中…</div>
              : providers.length === 0 ? <div className="provider-empty">还没有配置模型提供商。点上方「添加模型提供商」开始。</div>
                : providers.map((provider) => (
                  <div className="provider-card" key={provider.id} data-provider={provider.id}>
                    <div className="provider-main">
                      <span className="provider-name">
                        {provider.name || provider.id}
                        {provider.builtin ? <span className="tag">内置</span> : null}
                      </span>
                      <span className="provider-meta" title={provider.baseUrl ?? ''}>
                        {provider.api || ''}{provider.baseUrl ? ` · ${provider.baseUrl}` : ''}
                      </span>
                    </div>
                    <div className="provider-models">
                      <span>快速</span><b>{provider.flashModel || '—'}</b>
                      <span>深入</span><b>{provider.proModel || '—'}</b>
                    </div>
                    <div className="provider-actions">
                      <button className="btn ghost" type="button" disabled={busy} onClick={() => { void testConnection(provider); }}>测试</button>
                      <button className="btn ghost" type="button" onClick={() => { setEditor({ mode: 'edit', provider }); setDiscovered([]); setStatus(''); }}>编辑</button>
                      {provider.builtin ? null : (
                        <button className="btn ghost danger-text" type="button" disabled={busy} onClick={() => { void removeProvider(provider); }}>删除</button>
                      )}
                    </div>
                  </div>
                ))}
          </div>
          <div className="settings-status" role="status">{status}</div>
        </>
      )}
    </section>
  );
}

/** 插件页：MCP 插件列表 + 刷新 + 通过安装命令添加。 */
function PluginsSection({ open }: { open: boolean }): ReactElement {
  const close = useUiStore((state) => state.closeSettings);
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const { data } = useQuery({
    queryKey: ['mcp-plugins'],
    queryFn: async () => api<{ plugins?: McpPlugin[]; status?: { tools?: number } }>('/api/mcp/plugins'),
    enabled: open,
    staleTime: 5_000,
  });
  const plugins = data?.plugins ?? [];
  const tools = data?.status?.tools ?? 0;
  const enabled = plugins.filter((plugin) => plugin.enabled).length;

  const addPlugin = async (): Promise<void> => {
    const command = window.prompt('粘贴插件安装命令，交给 Agent 识别并安装：', '');
    if (!command || !command.trim()) return;
    setBusy(true);
    try {
      await api('/api/plugins/install', { method: 'POST', body: JSON.stringify({ command: command.trim() }) });
      setStatus('安装命令已提交，Agent 会处理安装。');
      await queryClient.invalidateQueries({ queryKey: ['mcp-plugins'] });
    } catch (error) {
      setStatus(`安装失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['mcp-plugins'] });
    setStatus('已刷新。');
  };

  return (
    <section className={`settings-content${open ? '' : ' hidden'}`} id="settings-plugins">
      <div className="modal-head"><h2>插件</h2><button className="btn ghost" id="plugins-close" onClick={close}>✕</button></div>
      <p className="muted settings-sub">添加工具和技能，扩展伯乐的能力。粘贴安装命令，Agent 会识别并处理安装。</p>
      <div className="settings-toolbar">
        <span className="muted" id="plugin-summary">{`${enabled}/${plugins.length} 启用 · ${tools} 个工具可用`}</span>
        <button className="btn primary" id="plugin-add" disabled={busy} onClick={() => { void addPlugin(); }}>＋ 添加插件</button>
      </div>
      <div className="plugin-section">
        <div className="plugin-section-head">
          <h3>已安装插件 <span id="plugin-count" className="muted">{plugins.length > 0 ? `${plugins.length} 个` : ''}</span></h3>
          <button className="link-btn" id="plugin-refresh" type="button" onClick={() => { void refresh(); }}>刷新</button>
        </div>
        <div id="plugin-list" className="plugin-list">
          {plugins.length === 0
            ? <div className="empty-note">还没有安装插件。点击「＋ 添加插件」，粘贴安装命令交给 Agent 处理。</div>
            : plugins.map((plugin) => {
              const runtime = plugin.runtime ?? {};
              const target = plugin.transport === 'stdio'
                ? `${plugin.command ?? ''} ${(plugin.args ?? []).join(' ')}`.trim()
                : (plugin.url ?? '');
              return (
                <article className={`plugin-row${plugin.enabled ? '' : ' disabled'}`} data-plugin-row={plugin.id} key={plugin.id}>
                  <label className="switch" title={plugin.enabled ? '停用插件' : '启用插件'}>
                    <input type="checkbox" data-plugin-toggle={plugin.id} defaultChecked={plugin.enabled} />
                    <span />
                  </label>
                  <div className="plugin-row-main">
                    <div className="plugin-row-title">
                      <span>{plugin.name ?? plugin.id}</span>
                      <span className="tag">{plugin.id}</span>
                      <span className={`tag ${runtime.state === 'ready' ? 'ok' : runtime.state === 'failed' ? 'danger' : ''}`}>
                        {runtime.label ?? ''}{runtime.state === 'ready' ? ` · ${runtime.tools ?? 0} 工具` : ''}
                      </span>
                      {plugin.source === 'imported' ? <span className="tag">导入</span> : null}
                      {plugin.hasCredentials ? <span className="tag">已存凭据</span> : null}
                    </div>
                    <div className="plugin-row-meta" title={target}>
                      {plugin.transport ?? 'stdio'} · {target || '—'} · 白名单 {(plugin.allowTools ?? []).join(', ') || '*'}
                    </div>
                    {runtime.error ? <div className="plugin-row-error">{runtime.error}</div> : null}
                  </div>
                  <div className="plugin-row-actions">
                    <button className="btn ghost" data-plugin-action="test" data-plugin-id={plugin.id} disabled={!plugin.enabled}>测试</button>
                    <button className="btn ghost" data-plugin-action="edit" data-plugin-id={plugin.id}>编辑</button>
                    <button className="btn ghost danger-text" data-plugin-action="delete" data-plugin-id={plugin.id}>删除</button>
                  </div>
                </article>
              );
            })}
        </div>
        <p id="plugin-status" className="settings-status" role="status">{status}</p>
      </div>
    </section>
  );
}

/** Agent 团队：已发布角色与已保存团队（只读视图，编辑器待接）。 */
function AgentsSection({ open }: { open: boolean }): ReactElement {
  const close = useUiStore((state) => state.closeSettings);
  return (
    <section className={`settings-content settings-embedded${open ? '' : ' hidden'}`} id="agent-dialog" aria-labelledby="agent-title">
      <div className="modal-head">
        <h2 id="agent-title">Agent 团队</h2>
        <button className="btn ghost" id="agent-close" type="button" aria-label="关闭 Agent 团队" onClick={close}>✕</button>
      </div>
      <AgentsPanel />
    </section>
  );
}

/** 岗位与评分标准：岗位族 / 版本历史 / 提案（只读视图，编辑器待接）。 */
function MemorySection({ open }: { open: boolean }): ReactElement {
  const close = useUiStore((state) => state.closeSettings);
  return (
    <section className={`settings-content settings-embedded${open ? '' : ' hidden'}`} id="memory-dialog" aria-labelledby="memory-title">
      <div className="modal-head">
        <h2 id="memory-title">岗位与评分标准</h2>
        <button className="btn ghost" id="memory-close" type="button" aria-label="关闭岗位与评分标准" onClick={close}>✕</button>
      </div>
      <MemoryPanel />
    </section>
  );
}

/** 设置弹窗：四个 tab，Esc / 遮罩 / 各页 ✕ 都能关闭。 */
export function SettingsModal(): ReactElement {
  const open = useUiStore((state) => state.settingsOpen);
  const tab = useUiStore((state) => state.settingsTab);
  const setTab = useUiStore((state) => state.setSettingsTab);
  const close = useUiStore((state) => state.closeSettings);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  return (
    <div
      id="settings-modal"
      className={`modal${open ? '' : ' hidden'}`}
      onClick={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <div className="modal-card settings-card">
        <div className="settings-shell">
          <aside className="settings-nav">
            <div className="settings-nav-title">设置</div>
            {NAV.map((item) => (
              <button
                key={item.key}
                className={`settings-nav-item${item.key === tab ? ' active' : ''}`}
                data-settings-tab={item.key}
                onClick={() => setTab(item.key)}
              >
                {item.label}
              </button>
            ))}
          </aside>

          <ModelsSection open={open && tab === 'models'} />
          <PluginsSection open={open && tab === 'plugins'} />
          <AgentsSection open={open && tab === 'agents'} />
          <MemorySection open={open && tab === 'memory'} />
        </div>
      </div>
    </div>
  );
}
