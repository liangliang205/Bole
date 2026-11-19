export type Theme = 'light' | 'dark';

const THEME_KEY = 'bole.theme';

/** 读取已存主题；与旧实现一致，缺省为 light。 */
export function storedTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** 把主题写到 <html data-theme>，样式表按这个属性切变量。 */
export function applyTheme(theme: Theme, persist = true): void {
  document.documentElement.dataset.theme = theme;
  if (!persist) return;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // 隐私模式下写不了，忽略
  }
}

/** 当前主题（以 DOM 上的属性为准，避免和 React 状态打架）。 */
export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}
