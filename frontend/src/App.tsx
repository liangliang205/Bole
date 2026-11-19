import type { ReactElement } from 'react';
import { Sidebar } from './features/sessions/Sidebar.tsx';
import { EmptyView } from './features/new/EmptyView.tsx';
import { ChatView } from './features/chat/ChatView.tsx';
import { Drawer } from './features/drawer/Drawer.tsx';
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
    <div className="app" id="app">
      <Sidebar />

      <main className="main">
        <header className="topbar">
          <div className="topbar-actions">
            <button className="btn ghost" id="panel-btn" title="任务面板">▤ 任务面板</button>
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
            <button className="btn ghost" id="help-open" type="button" aria-haspopup="dialog">ⓘ 帮助</button>
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

      {drawerOpen && activeJobId ? <Drawer jobId={activeJobId} /> : (
        <aside id="drawer" className="drawer hidden">
          <div className="drawer-head">
            <div className="drawer-tabs" id="drawer-tabs" />
            <button className="btn ghost" id="drawer-close">✕</button>
          </div>
          <div id="drawer-body" className="drawer-body" />
        </aside>
      )}
    </div>
  );
}
