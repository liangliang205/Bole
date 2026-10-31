import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface TempEnv {
  dir: string;
  restore: () => Promise<void>;
}

const KEYS = ['BOLE_DATA_DIR', 'BOLE_DB', 'BOLE_RUNS', 'BOLE_UPLOADS', 'BOLE_OCR_DIR'];

/** 为每个集成测试隔离台账/运行/上传目录；不依赖任何预置黄金集。 */
export async function setupTempEnv(): Promise<TempEnv> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bole-it-'));
  const saved = new Map(KEYS.map((key) => [key, process.env[key]]));
  process.env.BOLE_DATA_DIR = path.join(dir, 'data');
  process.env.BOLE_DB = path.join(dir, 'ledger.db');
  process.env.BOLE_RUNS = path.join(dir, 'runs');
  process.env.BOLE_UPLOADS = path.join(dir, 'uploads');
  process.env.BOLE_OCR_DIR = path.join(dir, 'ocr');
  return {
    dir,
    restore: async () => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}
