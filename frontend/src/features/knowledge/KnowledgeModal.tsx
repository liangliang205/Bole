import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactElement } from 'react';
import { api } from '../../api/client.ts';
import { useUiStore } from '../../store/ui.ts';

interface KnowledgeBase {
  id: string;
  name: string;
  enabled?: boolean;
  description?: string;
  documents?: number;
  chars?: number;
  updatedAt?: number;
  stats?: {
    sources?: number;
    parsedDocuments?: number;
    chunks?: number;
    tokens?: number;
    chars?: number;
    embeddedChunks?: number;
    embeddingDimensions?: number;
  };
}

function formatSize(chars: number): string {
  if (!chars) return '0';
  if (chars >= 1000) return `${(chars / 1000).toFixed(1)}K`;
  return String(chars);
}

function StatsCards({ stats }: { stats: KnowledgeBase['stats'] }): ReactElement {
  const value = stats ?? {};
  const cards: [string | number, string][] = [
    [value.sources ?? 0, '来源项'],
    [value.parsedDocuments ?? 0, '已解析文档'],
    [value.chunks ?? 0, '分块'],
    [Number(value.tokens ?? 0).toLocaleString(), '≈ Token'],
    [formatSize(value.chars ?? 0), '字符'],
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
 * 知识库弹窗：结构与 index.html 的 #knowledge-modal 一致（库列表 / 详情 / 文档表 / 设置 / 嵌入设置）。
 * 已接：库列表。待接：文档列表、上传、保存与嵌入设置。
 */
export function KnowledgeModal(): ReactElement {
  const open = useUiStore((state) => state.knowledgeOpen);
  const close = useUiStore((state) => state.closeKnowledge);
  const [selectedId, setSelectedId] = useState('');
  const { data } = useQuery({
    queryKey: ['knowledge-bases'],
    queryFn: async () => (await api<{ bases?: KnowledgeBase[] }>('/api/knowledge/bases')).bases ?? [],
    enabled: open,
    staleTime: 5_000,
  });
  const bases = data ?? [];
  const current = bases.find((base) => base.id === selectedId) ?? bases[0];

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
            <p className="knowledge-notice hidden" id="knowledge-embedding-notice">未配置嵌入模型：知识库仍可创建和使用，当前仅关键词检索。</p>
          </div>
          <button className="btn ghost" id="knowledge-close" onClick={close}>✕</button>
        </div>
        <div className="knowledge-layout">
          <aside className="knowledge-bases">
            <button className="btn primary block" id="knowledge-new" type="button">＋ 新建知识库</button>
            <div id="knowledge-create-form" className="knowledge-create hidden">
              <input id="kb-new-name" className="input" placeholder="知识库名称" maxLength={100} />
              <div className="knowledge-create-actions">
                <button className="btn" id="kb-new-create" type="button">创建</button>
                <button className="btn ghost" id="kb-new-cancel" type="button">取消</button>
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
                  <span className="kb-name">{base.name}</span>
                  <span className="kb-meta">{base.documents ?? 0} 个数据源 · {base.chars ?? 0} 字符</span>
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
                    {current?.enabled ? <span className="knowledge-tag">自动检索已启用</span> : <span className="knowledge-tag">未启用</span>}
                  </div>
                </div>
                <button className="btn primary" id="kb-upload" type="button">＋ 添加数据源</button>
              </div>
              <div id="kb-stats" className="knowledge-stats"><StatsCards stats={current?.stats} /></div>
              <div className="knowledge-panel">
                <div className="knowledge-panel-head">
                  <div>
                    <h3>文档</h3>
                    <span id="kb-updated" className="knowledge-panel-sub">上传后会立即解析并索引</span>
                  </div>
                </div>
                <div className="knowledge-table-wrap">
                  <table className="knowledge-table">
                    <thead>
                      <tr><th>名称</th><th>类型</th><th>状态</th><th>更新时间</th><th /></tr>
                    </thead>
                    <tbody id="kb-documents" />
                  </table>
                </div>
                <div id="kb-doc-status" className="settings-status" />
              </div>
              <details className="knowledge-settings knowledge-config">
                <summary>知识库设置</summary>
                <div className="form-grid">
                  <label>知识库名称<input id="kb-name" className="input" maxLength={100} defaultValue={current?.name ?? ''} /></label>
                  <label className="knowledge-switch-line"><span>启用自动检索</span><input id="kb-enabled" type="checkbox" defaultChecked={current?.enabled} /></label>
                  <label className="span-2">描述<input id="kb-description" className="input" placeholder="这个知识库放什么内容，便于检索路由" maxLength={2000} /></label>
                  <fieldset className="span-2 kb-agent-roles">
                    <legend>适用 Agent</legend>
                    <div id="kb-agent-roles" />
                    <p className="muted">可多选，仅勾选的角色会自动检索。未选角色时不参与自动检索。</p>
                  </fieldset>
                </div>
                <div className="knowledge-actions">
                  <button className="btn" id="kb-save" type="button">保存知识库</button>
                  <button className="btn ghost danger-text" id="kb-delete" type="button">删除知识库</button>
                  <span id="kb-status" className="settings-status" />
                </div>
              </details>
            </div>
          </section>
        </div>
        <details className="knowledge-settings">
          <summary>检索与嵌入设置</summary>
          <div className="form-grid">
            <label>嵌入服务
              <select id="kb-embedding-provider" className="input" defaultValue="none">
                <option value="none">关闭（仅关键词检索）</option>
                <option value="ollama">Ollama（本地）</option>
                <option value="openai">OpenAI 兼容</option>
              </select>
            </label>
            <label>嵌入模型<input id="kb-embedding-model" className="input" list="kb-embedding-models" placeholder="qwen3-embedding:8b" /></label>
            <datalist id="kb-embedding-models" />
            <label className="span-2">接口地址<input id="kb-embedding-url" className="input" placeholder="http://127.0.0.1:11434" /></label>
            <label className="span-2">API Key（可选，留空保留已保存值）<input id="kb-embedding-key" className="input" type="password" placeholder="留空使用已保存凭据" /></label>
            <label>重排模型<input id="kb-rerank-model" className="input" placeholder="可选" /></label>
            <label>重排地址<input id="kb-rerank-url" className="input" placeholder="https://api.jina.ai/v1" /></label>
            <label className="span-2">重排 API Key（可选，留空保留）<input id="kb-rerank-key" className="input" type="password" placeholder="留空使用已保存凭据" /></label>
            <label>Top K<input id="kb-top-k" className="input" type="number" min={1} max={50} /></label>
            <label>分块大小（字符）<input id="kb-chunk-size" className="input" type="number" min={120} max={8000} /></label>
            <label>分块重叠（字符）<input id="kb-chunk-overlap" className="input" type="number" min={0} max={4000} /></label>
            <label>上下文最大字符<input id="kb-max-context" className="input" type="number" min={500} max={20000} /></label>
            <label className="knowledge-check"><input id="kb-auto-recall" type="checkbox" /> 自动检索（画像/评估/建议）</label>
            <label className="knowledge-check"><input id="kb-smart-chunk" type="checkbox" /> 按 Markdown 标题智能分块</label>
          </div>
          <div className="knowledge-settings-actions">
            <button className="btn" id="kb-settings-save" type="button">保存设置</button>
            <button className="btn ghost" id="kb-model-refresh" type="button">获取模型列表</button>
            <button className="btn ghost" id="kb-test-embedding" type="button">测试嵌入连接</button>
            <span id="kb-settings-status" className="settings-status" />
          </div>
        </details>
      </div>
    </div>
  );
}
