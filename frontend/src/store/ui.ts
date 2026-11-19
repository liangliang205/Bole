import { create } from 'zustand';
import { applyTheme, currentTheme, type Theme } from '../theme.ts';

interface UiState {
  activeJobId: string;
  showArchived: boolean;
  search: string;
  theme: Theme;
  drawerOpen: boolean;
  drawerTab: string;
  mailboxOpen: boolean;
  knowledgeOpen: boolean;
  previewName: string;
  candidateFocus: string;
  helpOpen: boolean;
  settingsOpen: boolean;
  settingsTab: string;
  setActiveJob: (jobId: string) => void;
  toggleArchived: () => void;
  setSearch: (value: string) => void;
  setTheme: (theme: Theme) => void;
  openDrawer: (tab?: string) => void;
  openMailbox: () => void;
  closeMailbox: () => void;
  openHelp: () => void;
  closeHelp: () => void;
  focusCandidate: (resumeId: string) => void;
  clearCandidateFocus: () => void;
  openPreview: (name: string) => void;
  closePreview: () => void;
  openKnowledge: () => void;
  closeKnowledge: () => void;
  openSettings: (tab?: string) => void;
  closeSettings: () => void;
  setSettingsTab: (tab: string) => void;
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
  mailboxOpen: false,
  knowledgeOpen: false,
  previewName: '',
  candidateFocus: '',
  helpOpen: false,
  settingsOpen: false,
  settingsTab: 'models',
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
  openMailbox: () => set({ mailboxOpen: true }),
  closeMailbox: () => set({ mailboxOpen: false }),
  openHelp: () => set({ helpOpen: true }),
  closeHelp: () => set({ helpOpen: false }),
  focusCandidate: (resumeId) => set({ candidateFocus: resumeId, drawerOpen: true, drawerTab: 'candidates' }),
  clearCandidateFocus: () => set({ candidateFocus: '' }),
  openPreview: (name) => set({ previewName: name }),
  closePreview: () => set({ previewName: '' }),
  openKnowledge: () => set({ knowledgeOpen: true }),
  closeKnowledge: () => set({ knowledgeOpen: false }),
  openSettings: (tab) => set({ settingsOpen: true, settingsTab: tab ?? get().settingsTab }),
  closeSettings: () => set({ settingsOpen: false }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
}));
