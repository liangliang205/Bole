import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

interface PdfModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (src: string) => { promise: Promise<PdfDocument> };
}

interface PdfPage {
  getViewport: (options: { scale: number }) => { width: number; height: number };
  render: (options: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<void> };
}

interface PdfDocument {
  numPages: number;
  getPage: (index: number) => Promise<PdfPage>;
}

let pdfjsPromise: Promise<PdfModule> | null = null;

/** pdfjs 从服务端 /vendor/pdfjs 加载，和旧实现同一个资源路径。 */
function loadPdfjs(): Promise<PdfModule> {
  if (!pdfjsPromise) {
    const url = '/vendor/pdfjs/pdf.min.mjs';
    pdfjsPromise = import(/* @vite-ignore */ url).then((module) => {
      const api = module as unknown as PdfModule;
      api.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
      return api;
    });
  }
  return pdfjsPromise;
}

/**
 * 右侧文件预览：PDF 直接分页渲染；DOCX 由服务端转成 PDF 再预览。
 * 结构对应 index.html 的 #preview-pane。
 */
export function PreviewPane({ jobId, name, onClose }: { jobId: string; name: string; onClose: () => void }): ReactElement | null {
  const pagesHost = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const href = `/api/run/${encodeURIComponent(jobId)}/files/${encodeURIComponent(name)}`;
  const isPdf = /\.pdf$/i.test(name);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    pagesHost.current?.replaceChildren();

    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const pdf = await pdfjs.getDocument(`${href}/preview?t=${Date.now()}`).promise;
        if (cancelled || !pagesHost.current) return;
        for (let index = 1; index <= pdf.numPages; index += 1) {
          const page = await pdf.getPage(index);
          const viewport = page.getViewport({ scale: 1.5 });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const context = canvas.getContext('2d');
          if (!context) continue;
          await page.render({ canvasContext: context, viewport }).promise;
          if (cancelled) return;
          pagesHost.current.append(canvas);
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [href]);

  return (
    <aside id="preview-pane" className="preview-pane" aria-label="文件预览">
      <div id="preview-resizer" className="preview-resizer" role="separator" aria-orientation="vertical" title="拖拽调整预览宽度" />
      <div className="preview-pane-head">
        <div className="file-preview-heading">
          <h2 id="file-preview-title">{name}</h2>
          <p id="file-preview-sub" className="muted">
            {isPdf ? 'PDF 预览' : 'DOCX 已转换为 PDF 预览；版式可能与应用软件略有差异'}
          </p>
        </div>
        <div className="file-preview-actions">
          <a className="btn ghost" id="file-preview-download" href={href} download>下载原文件</a>
          <button className="btn ghost" id="file-preview-close" type="button" onClick={onClose}>✕</button>
        </div>
      </div>
      <div className="file-preview-body">
        <div id="file-preview-loading" className={`file-preview-loading${loading ? '' : ' hidden'}`}>正在生成预览…</div>
        {error ? <div className="file-preview-error">预览失败：{error}</div> : null}
        <div id="file-preview-pages" className="file-preview-pages" ref={pagesHost} />
      </div>
    </aside>
  );
}
