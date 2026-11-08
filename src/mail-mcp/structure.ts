export interface BodyNode {
  part?: string;
  type?: string;
  size?: number;
  disposition?: string;
  parameters?: Record<string, string>;
  dispositionParameters?: Record<string, string>;
  childNodes?: BodyNode[];
}

const RESUME_EXTENSIONS = new Set(['pdf', 'docx', 'doc']);
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** 递归取 bodystructure 的叶子节点，只有叶子才带 part 号，才能下载 */
export function leaves(node?: BodyNode): BodyNode[] {
  if (!node) return [];
  if (!node.childNodes?.length) return [node];
  return node.childNodes.flatMap((child) => leaves(child));
}

/** 文件名可能只出现在 Content-Type 的 name= 上，也可能只出现在 Content-Disposition 的 filename= 上 */
export function attachmentName(node: BodyNode): string {
  return node.dispositionParameters?.filename ?? node.parameters?.name ?? '';
}

export function isAttachment(node: BodyNode): boolean {
  return Boolean(node.part) && (node.disposition === 'attachment' || Boolean(attachmentName(node)));
}

export function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLowerCase() : '';
}

/**
 * 第一层过滤：只放行 pdf/docx/doc 且不超过 25MB。
 * 这里不做简历判定，判定在 Bole 侧 triage 里做。
 */
export function isResumeCandidate(node: BodyNode): boolean {
  if (!isAttachment(node)) return false;
  return RESUME_EXTENSIONS.has(extensionOf(attachmentName(node))) && (node.size ?? 0) <= MAX_ATTACHMENT_BYTES;
}

/** uidValidity 是 bigint，必须显式转字符串，JSON.stringify 不能序列化 bigint */
export function encodeId(uidValidity: bigint, uid: number): string {
  return `${uidValidity.toString()}:${uid}`;
}

export function decodeId(id: string): { uidValidity: string; uid: number } {
  const match = /^(\d+):(\d+)$/.exec(id);
  if (!match) throw new Error(`邮件 ID 格式非法：${id}`);
  const uid = Number(match[2]);
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error(`邮件 ID 格式非法：${id}`);
  return { uidValidity: match[1], uid };
}