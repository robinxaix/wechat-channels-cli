import { homedir } from 'node:os';
import { join } from 'node:path';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { AppConfig, ResolvedConfig } from './types.js';

/** 配置目录：遵循 XDG，缺省 ~/.config/wxch。 */
export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'wxch');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

export function defaultConfig(): ResolvedConfig {
  return {
    cookieSource: 'chrome',
    dryRun: true,
    intervalMs: 3000,
    commentTexts: ['这条内容信息量很足，先收藏了，感谢分享。'],
  };
}

export async function loadConfig(): Promise<ResolvedConfig> {
  let fileCfg: AppConfig = {};
  try {
    const raw = await readFile(configPath(), 'utf8');
    fileCfg = JSON.parse(raw) as AppConfig;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new Error(`配置文件解析失败（${configPath()}）：${(err as Error).message}`);
    }
  }

  const merged: ResolvedConfig = { ...defaultConfig(), ...fileCfg };

  // 环境变量优先，便于 CI / MCP 客户端注入，无需落盘敏感信息。
  if (process.env.WXCH_COOKIE_SOURCE) {
    merged.cookieSource = process.env.WXCH_COOKIE_SOURCE as ResolvedConfig['cookieSource'];
  }
  if (process.env.WXCH_COOKIE_FILE) {
    merged.cookieSource = 'file';
    merged.cookieFile = process.env.WXCH_COOKIE_FILE;
  }
  if (process.env.WXCH_COOKIE) {
    merged.cookieSource = 'inline';
    merged.cookie = process.env.WXCH_COOKIE;
  }
  if (process.env.WXCH_CHROME_PROFILE) merged.chromeProfile = process.env.WXCH_CHROME_PROFILE;
  if (process.env.WXCH_COMMENT_ENDPOINT) merged.commentEndpoint = process.env.WXCH_COMMENT_ENDPOINT;

  const aiEnv: Partial<NonNullable<AppConfig['ai']>> = {};
  if (process.env.WXCH_AI_BASE_URL) aiEnv.baseUrl = process.env.WXCH_AI_BASE_URL;
  if (process.env.WXCH_AI_API_KEY) aiEnv.apiKey = process.env.WXCH_AI_API_KEY;
  if (process.env.WXCH_AI_MODEL) aiEnv.model = process.env.WXCH_AI_MODEL;
  if (process.env.WXCH_AI_PROMPT) aiEnv.prompt = process.env.WXCH_AI_PROMPT;
  if (Object.keys(aiEnv).length > 0) merged.ai = { ...(merged.ai ?? {}), ...aiEnv };

  if (merged.dryRun === undefined) merged.dryRun = true;
  if (!Number.isFinite(merged.intervalMs)) merged.intervalMs = 3000;

  return merged;
}

export async function saveConfig(cfg: AppConfig): Promise<string> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  const path = configPath();
  // 配置文件可能包含 Cookie / API Key，权限收紧为仅本人可读写。
  await writeFile(path, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
  return path;
}

/** 合并写入，保留未提及字段。 */
export async function updateConfig(patch: Partial<AppConfig>): Promise<string> {
  let current: AppConfig = {};
  try {
    current = JSON.parse(await readFile(configPath(), 'utf8')) as AppConfig;
  } catch {
    current = {};
  }
  return saveConfig({ ...current, ...patch });
}
