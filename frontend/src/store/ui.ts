import { create } from 'zustand';
import { applyTheme, currentTheme, type Theme } from '../theme.ts';

interface UiState {
  activeJobId: string;
  showArchived: boolean;
  search: string;
  theme: Theme;
  setActiveJob: (jobId: string) => void;
  toggleArchived: () => void;
  setSearch: (value: string) => void;
  setTheme: (theme: Theme) => void;
}

/**
 * 只放跨屏 UI 状态。服务端数据一律走 TanStack Query，不进这里。
 */
export const useUiStore = create<UiState>((set, get) => ({
  activeJobId: '',
  showArchived: false,
  search: '',
  theme: currentTheme(),
  setActiveJob: (jobId) => set({ activeJobId: jobId }),
  toggleArchived: () => set({ showArchived: !get().showArchived }),
  setSearch: (value) => set({ search: value }),
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
}));
