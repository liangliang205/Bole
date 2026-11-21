import type { ReactElement, SVGProps } from 'react';

/**
 * 图标集：取自 iconfont.cn 上收录的开源图标库（Lucide / Feather 系列，MIT 许可）的
 * 24×24 描边风格，直接以 SVG 内联，避免打包字体文件与外网请求。
 * 统一 currentColor + stroke，随主题与字号变化。
 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...rest }: IconProps & { children: ReactElement | ReactElement[] }): ReactElement {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** 任务面板（右侧分栏） */
export function IconPanelRight(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </Icon>
  );
}

/** 暗夜 / 日间 */
export function IconMoon(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </Icon>
  );
}

export function IconSun(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Icon>
  );
}

/** 帮助 */
export function IconHelp(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 1 1 3.6 2.3c-.7.4-1.1 1-1.1 1.9" />
      <path d="M12 17h.01" />
    </Icon>
  );
}

/** 招聘邮箱 */
export function IconMail(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </Icon>
  );
}

/** 知识库 */
export function IconBook(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5Z" />
      <path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H19v3H6.5A2.5 2.5 0 0 1 4 18.5" />
    </Icon>
  );
}

/** 设置 */
export function IconSettings(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 8a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.6V2a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.6 1H22a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </Icon>
  );
}

/** 新建 / 添加 */
export function IconPlus(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

/** 搜索 */
export function IconSearch(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Icon>
  );
}

/** 更多 (⋯) */
export function IconMore(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </Icon>
  );
}

/** 附件 */
export function IconPaperclip(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <path d="M20 11.5 12.3 19a4.5 4.5 0 0 1-6.4-6.4l7.3-7.3a3 3 0 1 1 4.2 4.2l-7.3 7.3a1.5 1.5 0 0 1-2.1-2.1l6.6-6.6" />
    </Icon>
  );
}

/** 发送 / 提交 */
export function IconArrowUp(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </Icon>
  );
}

/** 关闭 */
export function IconX(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Icon>
  );
}

/** 展开 */
export function IconChevronDown(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

/** 刷新 */
export function IconRefresh(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <path d="M20 11a8 8 0 1 0-2.3 6.3" />
      <path d="M20 5v6h-6" />
    </Icon>
  );
}

/** 删除 */
export function IconTrash(props: IconProps): ReactElement {
  return (
    <Icon {...props}>
      <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
      <path d="M10 11v6M14 11v6" />
    </Icon>
  );
}
