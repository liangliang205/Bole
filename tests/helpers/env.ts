import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface TempEnv {
  dir: string;
  restore: () => Promise<void>;
}

const KEYS = ['BOLE_DATA_DIR', 'BOLE_DB', 'BOLE_RUNS', 'BOLE_UPLOADS', 'BOLE_OCR_DIR', 'BOLE_OCR_MODE', 'BOLE_OCR_FALLBACK'];

/** 为每个集成测试隔离台账/运行/上传目录；不依赖任何预置黄金集。 */
export async function setupTempEnv(): Promise<TempEnv> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bole-it-'));
  const saved = new Map(KEYS.map((key) => [key, process.env[key]]));
  process.env.BOLE_DATA_DIR = path.join(dir, 'data');
  process.env.BOLE_DB = path.join(dir, 'ledger.db');
  process.env.BOLE_RUNS = path.join(dir, 'runs');
  process.env.BOLE_UPLOADS = path.join(dir, 'uploads');
  process.env.BOLE_OCR_DIR = path.join(dir, 'ocr');
  process.env.BOLE_OCR_MODE = 'deepseek';
  process.env.BOLE_OCR_FALLBACK = 'false';
  return {
    dir,
    restore: async () => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      // Windows 上 SQLite 关闭后 WAL 文件仍可能被短暂占用（杀软/索引器），
      // 直接 rm 会 EBUSY 让测试假失败。重试几次再放弃。
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        try {
          await rm(dir, { recursive: true, force: true });
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'EBUSY' && code !== 'EPERM') throw error;
          if (attempt === 5) throw error;
          await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
        }
      }
    },
  };
}
