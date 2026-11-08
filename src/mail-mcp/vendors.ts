export interface Vendor {
  host: string;
  port: number;
  secure: boolean;
  /** 163/126 必须发 IMAP ID 命令，否则服务器返回 Unsafe Login */
  sendId: boolean;
}

export const VENDORS: Record<string, Vendor> = {
  qq: { host: 'imap.qq.com', port: 993, secure: true, sendId: false },
  '163': { host: 'imap.163.com', port: 993, secure: true, sendId: true },
  '126': { host: 'imap.126.com', port: 993, secure: true, sendId: true },
  icloud: { host: 'imap.mail.me.com', port: 993, secure: true, sendId: false },
};

export function resolveVendor(vendor: string, host?: string, port?: number): Vendor {
  if (host) {
    const resolvedPort = port ?? 993;
    return { host, port: resolvedPort, secure: resolvedPort === 993, sendId: false };
  }
  const key = vendor.trim().toLowerCase();
  const found = VENDORS[key];
  if (!found) {
    throw new Error(
      `未支持的邮箱厂商：${vendor}（可选：${Object.keys(VENDORS).join(', ')}；自建邮箱请提供 BOLE_MAIL_HOST）`,
    );
  }
  return found;
}