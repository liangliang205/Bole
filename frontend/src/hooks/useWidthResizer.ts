import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

export interface WidthBounds {
  min: number;
  max: number;
}

export interface ResizerOptions {
  storageKey: string;
  defaultValue: number;
  cssVar: '--sidebar-width' | '--content-width';
  /** 拖拽时的宽度换算：侧栏 1:1，居中正文 1:2。 */
  factor: number;
  /** side='left' 时拖拽方向取反。 */
  side: 'left' | 'right';
  bounds: () => WidthBounds;
  /** 拖拽期间挂在 body 与 #app 上的类名。 */
  activityClass: string;
  /** 键盘单步，旧实现为 24。 */
  step?: number;
}

export interface ResizerHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onLostPointerCapture: () => void;
  onDoubleClick: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  'aria-valuenow': number;
  'aria-valuemin': number;
  'aria-valuemax': number;
}

function readStored(key: string, fallback: number): number {
  try {
    const stored = Number(localStorage.getItem(key));
    if (Number.isFinite(stored) && stored > 0) return stored;
  } catch {
    // 隐私模式读不到
  }
  return fallback;
}

/**
 * 拖拽调整宽度：写 CSS 变量、存 localStorage、支持双击复位与左右键/Home。
 * 行为与旧实现（bindSidebarResize / bindContentResize）逐条对齐。
 */
export function useWidthResizer(options: ResizerOptions): ResizerHandlers {
  const { storageKey, defaultValue, cssVar, factor, side, bounds, activityClass, step = 24 } = options;
  const [width, setWidth] = useState(() => readStored(storageKey, defaultValue));
  const initialWidth = useRef(width);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const clamp = useCallback((value: number): number => {
    const { min, max } = bounds();
    return Math.max(min, Math.min(max, Math.round(value || defaultValue)));
  }, [bounds, defaultValue]);

  const apply = useCallback((value: number, persist = true): void => {
    const next = clamp(value);
    const app = document.getElementById('app');
    app?.style.setProperty(cssVar, `${next}px`);
    setWidth(next);
    if (!persist) return;
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {
      // 隐私模式写不进
    }
  }, [clamp, cssVar, storageKey]);

  useEffect(() => {
    // 首帧：先按本地记忆的宽度落到 CSS 变量；窗口变化时按当前值重新夹紧
    const live = (): number => {
      const raw = document.getElementById('app')?.style.getPropertyValue(cssVar) ?? '';
      const parsed = Number.parseFloat(raw);
      // 首帧 #app 上还没有内联变量，此时用挂载时读到的本地记忆值
      return Number.isFinite(parsed) && parsed > 0 ? parsed : initialWidth.current;
    };
    apply(live(), false);
    const onResize = (): void => apply(live(), false);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = useCallback((): void => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.classList.remove(activityClass);
    document.getElementById('app')?.classList.remove(activityClass);
    apply(width);
  }, [activityClass, apply, width]);

  return {
    onPointerDown: (event) => {
      if (window.innerWidth <= 760) return;
      dragging.current = true;
      startX.current = event.clientX;
      startWidth.current = width;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // 由 window 监听兜底
      }
      document.body.classList.add(activityClass);
      document.getElementById('app')?.classList.add(activityClass);
      event.preventDefault();
    },
    onPointerMove: (event) => {
      if (!dragging.current) return;
      const direction = side === 'left' ? startX.current - event.clientX : event.clientX - startX.current;
      apply(startWidth.current + direction * factor, false);
    },
    onPointerUp: stop,
    onPointerCancel: stop,
    onLostPointerCapture: stop,
    onDoubleClick: () => apply(defaultValue),
    onKeyDown: (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return;
      event.preventDefault();
      if (event.key === 'Home') {
        apply(defaultValue);
        return;
      }
      apply(width + (event.key === 'ArrowRight' ? step : -step));
    },
    'aria-valuenow': width,
    'aria-valuemin': bounds().min,
    'aria-valuemax': bounds().max,
  };
}
