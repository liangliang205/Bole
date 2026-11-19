import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { api } from '../../api/client.ts';
import { useUiStore } from '../../store/ui.ts';

interface KnowledgeBase {
  id: string;
  name: string;
  enabled?: boolean;
  documents?: number;
  chars?: number;
}

/**
 * 知识库弹窗：结构与 index.html 的 #knowledge-modal 一致。
 * 库列表已接 /api/knowledge/bases；文档列表、上传与设置面板尚未接入。
 */
export function KnowledgeModal(): ReactElement {
  const open = useUiStore((state) => state.knowledgeOpen);
  const close = useUiStore((state) => state.closeKnowledge);
  const { data } = useQuery({
    queryKey: ['knowledge-bases'],
    queryFn: async () => (await api<{ bases?: KnowledgeBase[] }>('/api/knowledge/bases')).bases ?? [],
    enabled: open,
    staleTime: 5_000,
  });
  const bases = data ?? [];

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
                <div className={`knowledge-base-item${base.enabled ? ' active' : ''}`} key={base.id} data-kb={base.id}>
                  <span className="kb-name">{base.name}</span>
                  <span className="kb-meta">{base.documents ?? 0} 个数据源 · {base.chars ?? 0} 字符</span>
                </div>
              ))}
            </div>
          </aside>
          <section className="knowledge-main">
            {bases.length === 0
              ? <div id="knowledge-empty" className="empty-note">还没有知识库。创建一个并启用后，才会参与自动检索。</div>
              : <div id="knowledge-empty" className="empty-note hidden" />}
            <div id="knowledge-detail" className="hidden">
              <div className="knowledge-hero">
                <div className="knowledge-hero-icon">▤</div>
                <div className="knowledge-hero-copy">
                  <h2 id="kb-title">知识库</h2>
                  <div id="kb-tags" className="knowledge-tags" />
                </div>
                <button className="btn primary" id="kb-upload" type="button">＋ 添加数据源</button>
              </div>
              <div id="kb-stats" className="knowledge-stats" />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
