/** 读取指定 id 的输入控件值（去掉首尾空白）。 */
export function readValue(id: string): string {
  const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  return (el?.value ?? '').trim();
}

/** 读取指定 id 的复选框状态。 */
export function readChecked(id: string): boolean {
  return (document.getElementById(id) as HTMLInputElement | null)?.checked ?? false;
}
