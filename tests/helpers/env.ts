import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { projectRoot } from '../../src/util/fsx.ts';

export interface TempEnv {
  dir: string;
  inboxDir: string;
  restore: () => Promise<void>;
}

const KEYS = ['BOLE_DATA_DIR', 'BOLE_DB', 'BOLE_RUNS', 'BOLE_INBOX', 'BOLE_LLM'];

/** 为每个集成测试隔离台账/运行目录，但复用项目内的黄金邮箱与配置。 */
export async function setupTempEnv(): Promise<TempEnv> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bole-it-'));
  const saved = new Map(KEYS.map((key) => [key, process.env[key]]));
  const inboxDir = path.join(projectRoot(), 'data', 'inbox');
  process.env.BOLE_DATA_DIR = path.join(dir, 'data');
  process.env.BOLE_DB = path.join(dir, 'ledger.db');
  process.env.BOLE_RUNS = path.join(dir, 'runs');
  process.env.BOLE_INBOX = inboxDir;
  process.env.BOLE_LLM = 'mock';
  return {
    dir,
    inboxDir,
    restore: async () => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}
