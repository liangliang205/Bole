import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { api } from '../../api/client.ts';
import { useUiStore } from '../../store/ui.ts';

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

function ModelsSection(): ReactElement {
  const { data, isLoading } = useQuery({
    queryKey: ['providers'],
    queryFn: async () => (await api<{ providers?: Provider[] }>('/api/providers')).providers ?? [],
    staleTime: 5_000,
  });
  const providers = data ?? [];
  return (
    <section className="settings-content" id="settings-models">
      <div className="modal-head"><h2>模型</h2><button className="btn ghost" id="settings-close">✕</button></div>
      <div className="settings-toolbar">
        <span className="muted" id="provider-count">{providers.length > 0 ? `${providers.length} 个提供商` : ''}</span>
        <button className="btn primary" id="provider-add">＋ 添加模型提供商</button>
      </div>
      <div id="provider-list" className="provider-list">
        {isLoading ? <div className="provider-empty">读取中…</div>
          : providers.length === 0 ? <div className="provider-empty">还没有配置模型提供商</div>
            : providers.map((provider) => (
              <div className={`provider-card${provider.builtin ? ' active' : ''}`} key={provider.id} data-provider={provider.id}>
                <div className="provider-main">
                  <span className="provider-name">{provider.name || provider.id}</span>
                  <span className="provider-meta">{provider.api || ''}{provider.builtin ? ' · 内置' : ''}</span>
                </div>
                <div className="provider-models">
                  <span>{provider.flashModel || '—'}</span>
                  <span>{provider.proModel || '—'}</span>
                </div>
              </div>
            ))}
      </div>
    </section>
  );
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
  revision?: number;
  description?: string;
  runtime?: { state?: string; label?: string; tools?: number; error?: string };
}

function PluginsSection({ open }: { open: boolean }): ReactElement {
  const { data } = useQuery({
    queryKey: ['mcp-plugins'],
    queryFn: async () => api<{ plugins?: McpPlugin[]; status?: { tools?: number } }>('/api/mcp/plugins'),
    enabled: open,
    staleTime: 5_000,
  });
  const plugins = data?.plugins ?? [];
  const tools = data?.status?.tools ?? 0;
  const enabled = plugins.filter((plugin) => plugin.enabled).length;

  return (
    <section className="settings-content" id="settings-plugins">
      <div className="modal-head"><h2>插件</h2><button className="btn ghost" id="plugins-close">✕</button></div>
      <p className="muted settings-sub">添加工具和技能，扩展伯乐的能力。粘贴安装命令，Agent 会识别并处理安装。</p>
      <div className="settings-toolbar">
        <span className="muted" id="plugin-summary">{`${enabled}/${plugins.length} 启用 · ${tools} 个工具可用`}</span>
        <button className="btn primary" id="plugin-add">＋ 添加插件</button>
      </div>
      <div className="plugin-section">
        <div className="plugin-section-head">
          <h3>已安装插件 <span id="plugin-count" className="muted">{plugins.length > 0 ? `${plugins.length} 个` : ''}</span></h3>
          <button className="link-btn" id="plugin-refresh" type="button">刷新</button>
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
      </div>
    </section>
  );
}

function PlaceholderSection({ id, title, closeId, hint }: { id: string; title: string; closeId: string; hint: string }): ReactElement {
  return (
    <section className="settings-content hidden" id={id}>
      <div className="modal-head"><h2>{title}</h2><button className="btn ghost" id={closeId}>✕</button></div>
      <p className="muted settings-sub">{hint}</p>
    </section>
  );
}

/**
 * 设置弹窗：外壳、导航与关闭按钮与 index.html 的 #settings-modal 一致。
 * 目前只有「模型」页接了 /api/providers；插件/Agent/记忆三页是占位，后续补齐。
 */
export function SettingsModal(): ReactElement {
  const open = useUiStore((state) => state.settingsOpen);
  const tab = useUiStore((state) => state.settingsTab);
  const setTab = useUiStore((state) => state.setSettingsTab);
  const close = useUiStore((state) => state.closeSettings);

  return (
    <div id="settings-modal" className={`modal${open ? '' : ' hidden'}`} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
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

          {open && tab === 'models' ? <ModelsSection /> : (
            <section className="settings-content hidden" id="settings-models">
              <div className="modal-head"><h2>模型</h2><button className="btn ghost" id="settings-close">✕</button></div>
            </section>
          )}
          {open && tab === 'plugins' ? <PluginsSection open /> : (
            <section className="settings-content hidden" id="settings-plugins">
              <div className="modal-head"><h2>插件</h2><button className="btn ghost" id="plugins-close">✕</button></div>
            </section>
          )}
          <PlaceholderSection id="settings-agents" title="Agent 团队" closeId="agent-close" hint="Agent 团队配置。" />
          <PlaceholderSection id="settings-memory" title="岗位与评分标准" closeId="memory-close" hint="岗位与评分标准配置。" />
        </div>
      </div>
    </div>
  );
}
