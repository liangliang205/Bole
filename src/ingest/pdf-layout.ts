export interface PdfFragment {
  str?: string; hasEOL?: boolean; transform?: number[]; width?: number; height?: number;
}
/** Recover visual row order for ordinary, unrotated text PDFs; retain content-order fallback. */
export function pdfPageText(items: PdfFragment[]): string {
  const fragments = items.filter((i) => i.str?.trim());
  if (!fragments.length) return '';
  if (fragments.some((i) => !i.transform || i.transform.length < 6 || Math.abs(i.transform[1]) > 0.01 || Math.abs(i.transform[2]) > 0.01)) {
    return items.map((i) => `${i.str ?? ''}${i.hasEOL ? '\n' : ' '}`).join('');
  }
  const rows: { y: number; height: number; items: PdfFragment[] }[] = [];
  for (const item of [...fragments].sort((a, b) => b.transform![5] - a.transform![5])) {
    const y = item.transform![5]; const height = Math.max(1, Math.abs(item.height ?? item.transform![3]));
    const row = rows.find((r) => Math.abs(r.y - y) <= Math.min(r.height, height) * 0.25);
    if (row) row.items.push(item); else rows.push({ y, height, items: [item] });
  }
  return rows.map((row) => {
    let end: number | undefined;
    return row.items.sort((a, b) => a.transform![4] - b.transform![4]).map((i) => {
      const x = i.transform![4];
      const space = end !== undefined && x - end > row.height * 0.16 ? ' ' : '';
      end = x + (i.width ?? 0);
      return space + i.str!.trim();
    }).join('');
  }).join('\n');
}
