import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveVendor } from './vendors.ts';
import { ImapSession } from './session.ts';
import { createMailServer } from './server.ts';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    process.stderr.write(`缺少环境变量 ${name}\n`);
    process.exit(1);
  }
  return value;
}

function buildSession(): ImapSession {
  const vendorInput = process.env.BOLE_MAIL_VENDOR?.trim() || 'custom';
  let vendor;
  try {
    vendor = resolveVendor(
      vendorInput,
      process.env.BOLE_MAIL_HOST?.trim() || undefined,
      process.env.BOLE_MAIL_PORT ? Number(process.env.BOLE_MAIL_PORT) : undefined,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  return new ImapSession({
    ...vendor,
    user: required('BOLE_MAIL_USER'),
    pass: required('BOLE_MAIL_PASSWORD'),
    folder: process.env.BOLE_MAIL_FOLDER?.trim() || 'INBOX',
    cacheDir: process.env.BOLE_MAIL_CACHE?.trim() || '.mail-cache',
  });
}

const session = buildSession();
const server = createMailServer(session);

await server.connect(new StdioServerTransport());

const shutdown = (): void => {
  void session.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);