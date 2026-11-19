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
            <section className="settings-content" id="settings-models">
              <div className="modal-head"><h2>模型</h2><button className="btn ghost" id="settings-close">✕</button></div>
            </section>
          )}
          <PlaceholderSection id="settings-plugins" title="插件" closeId="plugins-close" hint="添加工具和技能，扩展伯乐的能力。粘贴安装命令，Agent 会识别并处理安装。" />
          <PlaceholderSection id="settings-agents" title="Agent 团队" closeId="agent-close" hint="Agent 团队配置。" />
          <PlaceholderSection id="settings-memory" title="岗位与评分标准" closeId="memory-close" hint="岗位与评分标准配置。" />
        </div>
      </div>
    </div>
  );
}
