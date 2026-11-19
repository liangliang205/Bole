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

/**
 * 只放跨屏 UI 状态。服务端数据一律走 TanStack Query，不进这里。
 */
export const useUiStore = create<UiState>((set, get) => ({
  activeJobId: '',
  showArchived: false,
  search: '',
  theme: currentTheme(),
  drawerOpen: false,
  drawerTab: 'candidates',
  setActiveJob: (jobId) => set({ activeJobId: jobId, drawerOpen: true, drawerTab: 'candidates' }),
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
