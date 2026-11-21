import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, ReactElement } from 'react';
import { api } from '../../api/client.ts';
import { useUiStore } from '../../store/ui.ts';
import { IconX } from '../../components/icons.tsx';

interface KnowledgeBase {
  id: string;
  name: string;
  description?: string;
  enabled?: boolean;
  agentRoles?: string[];
  documentCount?: number;
  chunkCount?: number;
}

interface KnowledgeSettings {
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingBaseUrl?: string;
  rerankModel?: string;
  rerankBaseUrl?: string;
  topK?: number;
  chunkSize?: number;
  chunkOverlap?: number;
  autoRecall?: boolean;
  maxContextChars?: number;
  smartChunk?: boolean;
  hasEmbeddingKey?: boolean;
  hasRerankKey?: boolean;
}

interface KnowledgeDocument {
  id: string;
  title?: string;
  filename?: string;
  format?: string;
  chars?: number;
  status?: string;
  warning?: string;
  createdAt?: string;
}

interface KnowledgeStats {
  sources?: number;
  documents?: number;
  parsedDocuments?: number;
  chunks?: number;
  chars?: number;
  tokens?: number;
  embeddedChunks?: number;
  embeddingDimensions?: number;
}

const AGENT_ROLES = [
  { id: 'coordinator', label: '伯乐' },
  { id: 'profiler', label: '画像师' },
  { id: 'fetcher', label: '探马' },
  { id: 'parser', label: '录事' },
  { id: 'assessor', label: '相马官' },
  { id: 'auditor', label: '监军' },
  { id: 'advisor', label: '谋士' },
];

const DOC_STATUS_LABEL: Record<string, string> = {
  active: '已索引', parsing: '解析中', failed: '失败', pending: '待处理',
};

function formatRelative(iso: string | undefined): string {
  if (!iso) return '';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '';
  const diff = Date.now() - time;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const date = new Date(time);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatChars(value: number | undefined): string {
  const chars = value ?? 0;
  if (chars >= 1000) return `${(chars / 1000).toFixed(1)}K`;
  return String(chars);
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

/** 统计卡：字段与旧实现的 renderKnowledgeStats 一致。 */
function StatsCards({ stats }: { stats: KnowledgeStats | undefined }): ReactElement {
  const value = stats ?? {};
  const cards: [string | number, string][] = [
    [value.sources ?? 0, '来源项'],
    [value.parsedDocuments ?? 0, '已解析文档'],
    [value.chunks ?? 0, '分块'],
    [Number(value.tokens ?? 0).toLocaleString(), '≈ Token'],
    [formatChars(value.chars), '字符'],
    [value.embeddedChunks ? '✓' : '0', '已向量化'],
    [value.embeddingDimensions ? `${value.embeddingDimensions}d` : '—', '向量维度'],
  ];
  return (
    <>
      {cards.map(([number, label]) => (
        <div className="knowledge-stat" key={label}><b>{number}</b><span>{label}</span></div>
      ))}
    </>
  );
}

/**
 * 知识库弹窗：库列表 / 详情 / 文档表 / 统计 / 嵌入设置。
 * 读取链路已全接；新建、保存、删除与上传在下一步接。
 */
export function KnowledgeModal(): ReactElement {
  const open = useUiStore((state) => state.knowledgeOpen);
  // 与设置弹窗一致：Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') useUiStore.getState().closeKnowledge();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);
  const close = useUiStore((state) => state.closeKnowledge);
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  const readValue = (id: string): string => (document.getElementById(id) as HTMLInputElement | null)?.value?.trim() ?? '';
  const readChecked = (id: string): boolean => (document.getElementById(id) as HTMLInputElement | null)?.checked ?? false;

  const { data } = useQuery({
    queryKey: ['knowledge'],
    queryFn: async () => api<{ bases?: KnowledgeBase[]; settings?: KnowledgeSettings }>('/api/knowledge'),
    enabled: open,
    staleTime: 5_000,
  });
  const bases = data?.bases ?? [];
  const settings = data?.settings ?? {};
  const current = bases.find((base) => base.id === selectedId) ?? bases[0];

  const docsQuery = useQuery({
    queryKey: ['knowledge-docs', current?.id ?? ''],
    queryFn: async () => api<{ documents?: KnowledgeDocument[]; stats?: KnowledgeStats }>(
      `/api/knowledge/bases/${encodeURIComponent(current?.id ?? '')}/documents`,
    ),
    enabled: open && Boolean(current?.id),
    staleTime: 5_000,
  });
  const documents = docsQuery.data?.documents ?? [];
  const stats = docsQuery.data?.stats;

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['knowledge'] });
    await queryClient.invalidateQueries({ queryKey: ['knowledge-docs'] });
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = event.target.files;
    if (!files || !current) return;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        await api(`/api/knowledge/bases/${encodeURIComponent(current.id)}/documents`, {
          method: 'POST',
          body: JSON.stringify({ filename: file.name, contentBase64: await fileToBase64(file) }),
        });
      }
      setStatus('上传完成，已开始解析与索引。');
      await refresh();
    } catch (error) {
      setStatus(`上传失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  };

  const removeDocument = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      await api(`/api/knowledge/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setStatus('已删除数据源。');
      await refresh();
    } catch (error) {
      setStatus(`删除失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  /** 收集 #kb-agent-roles 里被勾选的角色。 */
  const selectedRoles = (): string[] => Array.from(
    document.querySelectorAll<HTMLInputElement>('#kb-agent-roles input[type="checkbox"]:checked'),
  ).map((input) => input.value);

  const saveBase = async (): Promise<void> => {
    if (!current) return;
    setBusy(true);
    try {
      await api(`/api/knowledge/bases/${encodeURIComponent(current.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: readValue('kb-name'),
          description: readValue('kb-description'),
          enabled: readChecked('kb-enabled'),
          agentRoles: selectedRoles(),
        }),
      });
      setStatus('知识库已保存。');
      await refresh();
    } catch (error) {
      setStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const deleteBase = async (): Promise<void> => {
    if (!current) return;
    if (!window.confirm(`确定删除知识库「${current.name}」及其全部文档？该操作不可恢复。`)) return;
    setBusy(true);
    try {
      await api(`/api/knowledge/bases/${encodeURIComponent(current.id)}`, { method: 'DELETE' });
      setSelectedId('');
      setStatus('知识库已删除。');
      await refresh();
    } catch (error) {
      setStatus(`删除失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const createBase = async (): Promise<void> => {
    const name = readValue('kb-new-name');
    if (!name) {
      setStatus('请先填写知识库名称。');
      return;
    }
    setBusy(true);
    try {
      const created = await api<{ base: KnowledgeBase }>('/api/knowledge/bases', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      setStatus('知识库已创建。');
      await refresh();
      if (created.base?.id) setSelectedId(created.base.id);
    } catch (error) {
      setStatus(`创建失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  /** 拉取嵌入服务的模型列表，填进 datalist 供选择。 */
  const refreshEmbeddingModels = async (): Promise<void> => {
    setBusy(true);
    try {
      const data = await api<{ models?: string[] }>('/api/knowledge/embedding-models');
      const models = data.models ?? [];
      const list = document.getElementById('kb-embedding-models') as HTMLDataListElement | null;
      if (list) {
        list.innerHTML = '';
        for (const id of models) {
          const option = document.createElement('option');
          option.value = id;
          list.append(option);
        }
      }
      setStatus(models.length > 0 ? `发现 ${models.length} 个嵌入模型` : '服务没有返回模型列表');
    } catch (error) {
      setStatus(`获取模型列表失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  /** 用已保存的设置做一次真实嵌入调用。 */
  const testEmbedding = async (): Promise<void> => {
    setBusy(true);
    try {
      const data = await api<{ result?: { ok?: boolean; dimensions?: number; error?: string } }>('/api/knowledge/test-embedding', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const result = data.result ?? {};
      setStatus(result.ok
        ? `嵌入连接正常${result.dimensions ? `，向量维度 ${result.dimensions}` : ''}`
        : `嵌入连接失败：${result.error ?? '未知原因'}`);
    } catch (error) {
      setStatus(`测试失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = async (): Promise<void> => {
    setBusy(true);
    try {
      await api('/api/knowledge/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          embeddingProvider: readValue('kb-embedding-provider'),
          embeddingModel: readValue('kb-embedding-model'),
          embeddingBaseUrl: readValue('kb-embedding-url'),
          rerankModel: readValue('kb-rerank-model'),
          rerankBaseUrl: readValue('kb-rerank-url'),
          topK: Number(readValue('kb-top-k')) || undefined,
          chunkSize: Number(readValue('kb-chunk-size')) || undefined,
          chunkOverlap: Number(readValue('kb-chunk-overlap')) || undefined,
          maxContextChars: Number(readValue('kb-max-context')) || undefined,
          autoRecall: readChecked('kb-auto-recall'),
          smartChunk: readChecked('kb-smart-chunk'),
          // 密钥留空表示保留已保存值，与原实现一致
          ...(readValue('kb-embedding-key') ? { embeddingApiKey: readValue('kb-embedding-key') } : {}),
          ...(readValue('kb-rerank-key') ? { rerankApiKey: readValue('kb-rerank-key') } : {}),
        }),
      });
      setStatus('检索与嵌入设置已保存。');
      await refresh();
    } catch (error) {
      setStatus(`保存设置失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      id="knowledge-modal"
      className={`modal${open ? '' : ' hidden'}`}
      onClick={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <div className="modal-card knowledge-card">
        <div className="modal-head">
          <div>
            <h2>知识库</h2>
            <p className="muted knowledge-sub">默认不启用。启用后只在评估阶段参与自动检索（画像与完成后对话不查知识库）。</p>
            <p className={`knowledge-notice${settings.embeddingProvider && settings.embeddingProvider !== 'none' ? ' hidden' : ''}`} id="knowledge-embedding-notice">
              未配置嵌入模型：知识库仍可创建和使用，当前仅关键词检索。
            </p>
          </div>
          <button className="btn ghost" id="knowledge-close" onClick={close}><IconX size={14} /></button>
        </div>
        <div className="knowledge-layout">
          <aside className="knowledge-bases">
            <button className="btn primary block" id="knowledge-new" type="button" onClick={() => setShowCreate((value) => !value)}>＋ 新建知识库</button>
            <div id="knowledge-create-form" className={`knowledge-create${showCreate ? '' : ' hidden'}`}>
              <input id="kb-new-name" className="input" placeholder="知识库名称" maxLength={100} />
              <div className="knowledge-create-actions">
                <button className="btn" id="kb-new-create" type="button" disabled={busy} onClick={() => { void createBase(); }}>创建</button>
                <button className="btn ghost" id="kb-new-cancel" type="button" onClick={() => setShowCreate(false)}>取消</button>
              </div>
            </div>
            <div id="knowledge-base-list" className="knowledge-base-list">
              {bases.map((base) => (
                <div
                  className={`knowledge-base-item${base.id === current?.id ? ' active' : ''}`}
                  key={base.id}
                  data-kb={base.id}
                  onClick={() => setSelectedId(base.id)}
                >
                  <span className="kb-name">
                    <span className={`dot${base.enabled ? ' enabled' : ''}`} />{base.name}
                  </span>
                  <span className="kb-meta">{base.documentCount ?? 0} 个数据源 · {base.chunkCount ?? 0} 分块</span>
                </div>
              ))}
            </div>
          </aside>
          <section className="knowledge-main">
            <div id="knowledge-empty" className={`empty-note${current ? ' hidden' : ''}`}>
              还没有知识库。创建一个并启用后，才会参与自动检索。
            </div>
            <div id="knowledge-detail" className={current ? '' : 'hidden'}>
              <div className="knowledge-hero">
                <div className="knowledge-hero-icon">▤</div>
                <div className="knowledge-hero-copy">
                  <h2 id="kb-title">{current?.name ?? '知识库'}</h2>
                  <div id="kb-tags" className="knowledge-tags">
                    <span className="knowledge-tag">{current?.enabled ? '自动检索已启用' : '未启用自动检索'}</span>
                    {(current?.agentRoles ?? []).map((role) => <span className="knowledge-tag" key={role}>{role}</span>)}
                  </div>
                </div>
                <button className="btn primary" id="kb-upload" type="button" disabled={busy || !current} onClick={() => fileInput.current?.click()}>
                  ＋ 添加数据源
                </button>
                <input
                  ref={fileInput}
                  id="knowledge-file"
                  type="file"
                  multiple
                  hidden
                  accept=".pdf,.docx,.txt,.md,.markdown,.html,.htm,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff"
                  onChange={(event) => { void upload(event); }}
                />
              </div>
              <div id="kb-stats" className="knowledge-stats"><StatsCards stats={stats} /></div>
              <div className="knowledge-panel">
                <div className="knowledge-panel-head">
                  <div>
                    <h3>文档</h3>
                    <span id="kb-updated" className="knowledge-panel-sub">
                      {documents.length > 0 ? `最近更新 ${formatRelative(documents[0]?.createdAt)}` : '上传后会立即解析并索引'}
                    </span>
                  </div>
                </div>
                <div className="knowledge-table-wrap">
                  <table className="knowledge-table">
                    <thead>
                      <tr><th>名称</th><th>类型</th><th>状态</th><th>更新时间</th><th /></tr>
                    </thead>
                    <tbody id="kb-documents">
                      {documents.map((doc) => (
                        <tr key={doc.id}>
                          <td>
                            <span className="knowledge-doc-name">{doc.title ?? doc.filename ?? ''}</span>
                            <span className="knowledge-doc-sub">{doc.filename ?? ''}</span>
                          </td>
                          <td><span className="tag">{doc.format ?? ''}</span></td>
                          <td>
                            <span className={`tag ${doc.status === 'active' ? 'ok' : doc.status === 'failed' ? 'danger' : ''}`}>
                              {DOC_STATUS_LABEL[doc.status ?? ''] ?? doc.status ?? ''}
                            </span>
                          </td>
                          <td>{formatRelative(doc.createdAt)}</td>
                          <td>
                            <button
                              className="btn ghost danger-text knowledge-row-action"
                              type="button"
                              disabled={busy}
                              onClick={() => { void removeDocument(doc.id); }}
                            >
                              删除
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div id="kb-doc-status" className="settings-status">{documents.length === 0 ? '还没有数据源。' : ''}</div>
              </div>
              <details className="knowledge-settings knowledge-config">
                <summary>知识库设置</summary>
                <div className="form-grid">
                  <label>知识库名称<input id="kb-name" className="input" maxLength={100} defaultValue={current?.name ?? ''} /></label>
                  <label className="knowledge-switch-line"><span>启用自动检索</span><input id="kb-enabled" type="checkbox" defaultChecked={current?.enabled} /></label>
                  <label className="span-2">描述<input id="kb-description" className="input" placeholder="这个知识库放什么内容，便于检索路由" maxLength={2000} defaultValue={current?.description ?? ''} /></label>
                  <fieldset className="span-2 kb-agent-roles">
                    <legend>适用 Agent</legend>
                    <div id="kb-agent-roles">
                      {AGENT_ROLES.map((role) => (
                        <label key={role.id}>
                          <input
                            type="checkbox"
                            value={role.id}
                            defaultChecked={(current?.agentRoles ?? []).includes(role.id)}
                          />
                          {role.label}
                        </label>
                      ))}
                    </div>
                    <p className="muted">可多选，仅勾选的角色会自动检索。未选角色时不参与自动检索。</p>
                  </fieldset>
                </div>
                <div className="knowledge-actions">
                  <button className="btn" id="kb-save" type="button" disabled={busy} onClick={() => { void saveBase(); }}>保存知识库</button>
                  <button className="btn ghost danger-text" id="kb-delete" type="button" disabled={busy} onClick={() => { void deleteBase(); }}>删除知识库</button>
                  <span id="kb-status" className="settings-status">{status}</span>
                </div>
              </details>
            </div>
          </section>
        </div>
        <details className="knowledge-settings">
          <summary>检索与嵌入设置</summary>
          <div className="form-grid">
            <label>嵌入服务
              <select id="kb-embedding-provider" className="input" defaultValue={settings.embeddingProvider ?? 'none'}>
                <option value="none">关闭（仅关键词检索）</option>
                <option value="ollama">Ollama（本地）</option>
                <option value="openai">OpenAI 兼容</option>
              </select>
            </label>
            <label>嵌入模型<input id="kb-embedding-model" className="input" list="kb-embedding-models" placeholder="qwen3-embedding:8b" defaultValue={settings.embeddingModel ?? ''} /></label>
            <datalist id="kb-embedding-models" />
            <label className="span-2">接口地址<input id="kb-embedding-url" className="input" placeholder="http://127.0.0.1:11434" defaultValue={settings.embeddingBaseUrl ?? ''} /></label>
            <label className="span-2">API Key（可选，留空保留已保存值）<input id="kb-embedding-key" className="input" type="password" placeholder={settings.hasEmbeddingKey ? '已保存凭据' : '留空使用已保存凭据'} /></label>
            <label>重排模型<input id="kb-rerank-model" className="input" placeholder="可选" defaultValue={settings.rerankModel ?? ''} /></label>
            <label>重排地址<input id="kb-rerank-url" className="input" placeholder="https://api.jina.ai/v1" defaultValue={settings.rerankBaseUrl ?? ''} /></label>
            <label className="span-2">重排 API Key（可选，留空保留）<input id="kb-rerank-key" className="input" type="password" placeholder={settings.hasRerankKey ? '已保存凭据' : '留空使用已保存凭据'} /></label>
            <label>Top K<input id="kb-top-k" className="input" type="number" min={1} max={50} defaultValue={settings.topK ?? 4} /></label>
            <label>分块大小（字符）<input id="kb-chunk-size" className="input" type="number" min={120} max={8000} defaultValue={settings.chunkSize ?? 800} /></label>
            <label>分块重叠（字符）<input id="kb-chunk-overlap" className="input" type="number" min={0} max={4000} defaultValue={settings.chunkOverlap ?? 100} /></label>
            <label>上下文最大字符<input id="kb-max-context" className="input" type="number" min={500} max={20000} defaultValue={settings.maxContextChars ?? 4000} /></label>
            <label className="knowledge-check"><input id="kb-auto-recall" type="checkbox" defaultChecked={settings.autoRecall} /> 自动检索（画像/评估/建议）</label>
            <label className="knowledge-check"><input id="kb-smart-chunk" type="checkbox" defaultChecked={settings.smartChunk} /> 按 Markdown 标题智能分块</label>
          </div>
          <div className="knowledge-settings-actions">
            <button className="btn" id="kb-settings-save" type="button" disabled={busy} onClick={() => { void saveSettings(); }}>保存设置</button>
            <button className="btn ghost" id="kb-model-refresh" type="button" disabled={busy} onClick={() => { void refreshEmbeddingModels(); }}>获取模型列表</button>
            <button className="btn ghost" id="kb-test-embedding" type="button" disabled={busy} onClick={() => { void testEmbedding(); }}>测试嵌入连接</button>
            <span id="kb-settings-status" className="settings-status">{busy ? '处理中…' : ''}</span>
          </div>
        </details>
      </div>
    </div>
  );
}
