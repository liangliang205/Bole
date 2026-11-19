import type { ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * 聊天正文的 Markdown。
 * 不启用 rehype-raw：旧实现先转义再渲染，这里保持同一个安全边界。
 */
export function Markdown({ source }: { source: string }): ReactElement {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]}>
      {source}
    </ReactMarkdown>
  );
}
