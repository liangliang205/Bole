import type { ReactElement } from 'react';
import { Sidebar } from './features/sessions/Sidebar.tsx';
import { EmptyView } from './features/new/EmptyView.tsx';
import { ChatView } from './features/chat/ChatView.tsx';
import { Drawer } from './features/drawer/Drawer.tsx';
import { SettingsModal } from './features/settings/SettingsModal.tsx';
import { MailboxModal } from './features/mailbox/MailboxModal.tsx';
import { KnowledgeModal } from './features/knowledge/KnowledgeModal.tsx';
import { PreviewPane } from './features/preview/PreviewPane.tsx';
import { HelpDialog } from './features/help/HelpDialog.tsx';
import { useUiStore } from './store/ui.ts';
import { useWidthResizer } from './hooks/useWidthResizer.ts';

const CONTENT_WIDTH_KEY = 'bole.contentWidth';
const CONTENT_DEFAULT = 900;

function contentBounds(): { min: number; max: number } {
  const mainWidth = document.querySelector('.main')?.clientWidth ?? window.innerWidth;
  return { min: 620, max: Math.max(620, Math.min(1400, mainWidth - 48)) };
}

export function App(): ReactElement {
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);
  const activeJobId = useUiStore((state) => state.activeJobId);
  const drawerOpen = useUiStore((state) => state.drawerOpen);
  const openDrawer = useUiStore((state) => state.openDrawer);
  const closeDrawer = useUiStore((state) => state.closeDrawer);
  const previewName = useUiStore((state) => state.previewName);
  const closePreview = useUiStore((state) => state.closePreview);
  const openHelp = useUiStore((state) => state.openHelp);
  const isDark = theme === 'dark';

  const right = useWidthResizer({
    storageKey: CONTENT_WIDTH_KEY,
    defaultValue: CONTENT_DEFAULT,
    cssVar: '--content-width',
    factor: 2,
    side: 'right',
    bounds: contentBounds,
    activityClass: 'is-resizing-content',
  });
  const left = useWidthResizer({
    storageKey: CONTENT_WIDTH_KEY,
    defaultValue: CONTENT_DEFAULT,
    cssVar: '--content-width',
    factor: 2,
    side: 'left',
    bounds: contentBounds,
    activityClass: 'is-resizing-content',
  });

  return (
    <div
      className={`app${drawerOpen && activeJobId ? ' drawer-open' : ''}${previewName ? ' preview-open' : ''}`}
      id="app"
    >
      <Sidebar />

      <main className={`main${activeJobId ? ' chat-active' : ''}`}>
        <header className="topbar">
          <div className="topbar-actions">
            <button
              className="btn ghost"
              id="panel-btn"
              type="button"
              title={drawerOpen && activeJobId ? '收起任务面板' : '打开任务面板'}
              aria-controls="drawer"
              aria-expanded={Boolean(drawerOpen && activeJobId)}
              onClick={() => {
                if (drawerOpen && activeJobId) closeDrawer();
                else openDrawer();
              }}
            >
              ▤ 任务面板
            </button>
            <button
              className="btn ghost"
              id="theme-toggle"
              type="button"
              title={isDark ? '切换日间模式' : '切换暗夜模式'}
              aria-pressed={isDark}
              onClick={() => setTheme(isDark ? 'light' : 'dark')}
            >
              {isDark ? '☀ 日间' : '☾ 暗夜'}
            </button>
            <button className="btn ghost" id="help-open" type="button" aria-haspopup="dialog" onClick={openHelp}>ⓘ 帮助</button>
          </div>
        </header>
        <div
          className="content-resizer content-resizer-left"
          id="content-resizer-left"
          role="separator"
          aria-orientation="vertical"
          tabIndex={0}
          title="拖拽调整正文宽度"
          {...left}
        />
        <div
          className="content-resizer content-resizer-right"
          id="content-resizer"
          role="separator"
          aria-orientation="vertical"
          tabIndex={0}
          title="拖拽调整正文宽度"
          {...right}
        />

        <EmptyView hidden={Boolean(activeJobId)} />
        {activeJobId
          ? <ChatView jobId={activeJobId} hidden={false} />
          : <section id="chat-view" className="chat-view hidden" />}
      </main>

      <SettingsModal />
      <MailboxModal />
      <KnowledgeModal />
      <HelpDialog />
      {previewName && activeJobId ? <PreviewPane jobId={activeJobId} name={previewName} onClose={closePreview} /> : null}

      {drawerOpen && activeJobId ? <Drawer jobId={activeJobId} /> : (
        <aside id="drawer" className="drawer hidden">
          <div className="drawer-head">
            <div className="drawer-tabs" id="drawer-tabs" />
            <button className="btn ghost" id="drawer-close" type="button" onClick={closeDrawer}>✕</button>
          </div>
          <div id="drawer-body" className="drawer-body" />
        </aside>
      )}
    </div>
  );
}
