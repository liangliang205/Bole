import { create } from 'zustand';
import { applyTheme, currentTheme, type Theme } from '../theme.ts';

interface UiState {
  activeJobId: string;
  showArchived: boolean;
  search: string;
  theme: Theme;
  drawerOpen: boolean;
  drawerTab: string;
  setActiveJob: (jobId: string) => void;
  toggleArchived: () => void;
  setSearch: (value: string) => void;
  setTheme: (theme: Theme) => void;
  openDrawer: (tab?: string) => void;
  closeDrawer: () => void;
  setDrawerTab: (tab: string) => void;
}

/** 与旧实现一致：选中会话写进 URL hash（#job=xxx），启动时优先恢复。 */
function hashJobId(): string {
  const match = /#job=([^&]+)/.exec(window.location.hash);
  return match ? decodeURIComponent(match[1]) : '';
}

function writeHashJob(jobId: string): void {
  const next = jobId ? `#job=${encodeURIComponent(jobId)}` : window.location.pathname;
  try {
    window.history.replaceState(null, '', next);
  } catch {
    // 嵌入式环境可能不允许改历史，忽略
  }
}

/**
 * 只放跨屏 UI 状态。服务端数据一律走 TanStack Query，不进这里。
 */
export const useUiStore = create<UiState>((set, get) => ({
  activeJobId: hashJobId(),
  showArchived: false,
  search: '',
  theme: currentTheme(),
  drawerOpen: false,
  drawerTab: 'candidates',
  setActiveJob: (jobId) => {
    writeHashJob(jobId);
    set({ activeJobId: jobId, drawerOpen: true, drawerTab: 'candidates' });
  },
  toggleArchived: () => set({ showArchived: !get().showArchived }),
  setSearch: (value) => set({ search: value }),
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
  openDrawer: (tab) => set({ drawerOpen: true, drawerTab: tab ?? get().drawerTab }),
  closeDrawer: () => set({ drawerOpen: false }),
  setDrawerTab: (tab) => set({ drawerTab: tab, drawerOpen: true }),
}));
