import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const KIMI_CODE_HOME_ENV = 'TEA_CODE_HOME';
export const KIMI_CODE_DATA_DIR_NAME = '.tea-code';

export function getDataDir(): string {
  return resolve(process.env[KIMI_CODE_HOME_ENV] || join(homedir(), KIMI_CODE_DATA_DIR_NAME));
}
