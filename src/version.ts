import { readFileSync } from 'node:fs';

/**
 * 从 package.json 读取版本号。
 * src/version.ts 与 dist/version.js 都位于包根下一层，因此 `../package.json` 对两者都成立。
 */
export function readVersion(): string {
  try {
    const url = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readVersion();
