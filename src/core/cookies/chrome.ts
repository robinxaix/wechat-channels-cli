import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { COOKIE_DOMAIN_SUFFIX } from '../constants.js';
import type { Cookie } from '../types.js';
import { decryptCookieValue, deriveKey, getKeyMaterial } from './decrypt.js';

export type BrowserName = 'chrome' | 'edge' | 'brave' | 'chromium';

/** 各浏览器在三大平台上的用户数据目录候选。 */
function userDataDirs(browser: BrowserName, platform = process.platform): string[] {
  const home = homedir();
  const table: Record<BrowserName, Record<string, string[]>> = {
    chrome: {
      darwin: [join(home, 'Library/Application Support/Google/Chrome')],
      linux: [join(home, '.config/google-chrome'), join(home, '.config/google-chrome-stable')],
      win32: [join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/User Data')],
    },
    edge: {
      darwin: [join(home, 'Library/Application Support/Microsoft Edge')],
      linux: [join(home, '.config/microsoft-edge')],
      win32: [join(process.env.LOCALAPPDATA ?? '', 'Microsoft/Edge/User Data')],
    },
    brave: {
      darwin: [join(home, 'Library/Application Support/BraveSoftware/Brave-Browser')],
      linux: [join(home, '.config/BraveSoftware/Brave-Browser')],
      win32: [join(process.env.LOCALAPPDATA ?? '', 'BraveSoftware/Brave-Browser/User Data')],
    },
    chromium: {
      darwin: [join(home, 'Library/Application Support/Chromium')],
      linux: [join(home, '.config/chromium')],
      win32: [join(process.env.LOCALAPPDATA ?? '', 'Chromium/User Data')],
    },
  };
  return (table[browser][platform] ?? []).filter(Boolean);
}

/** 自动挑选第一个存在的浏览器用户数据目录。 */
export function resolveUserDataDir(browser?: BrowserName): { dir: string; browser: BrowserName } {
  const order: BrowserName[] = browser ? [browser] : ['chrome', 'edge', 'brave', 'chromium'];
  for (const name of order) {
    for (const dir of userDataDirs(name)) {
      if (dir && existsSync(dir)) return { dir, browser: name };
    }
  }
  throw new Error(
    `未找到可用的 Chromium 系浏览器数据目录（已尝试 ${order.join(' / ')}）。` +
      '可用 --browser 指定，或改用 --cookie 手动提供。',
  );
}

interface LocalState {
  lastUsed?: string;
  profiles: string[];
}

/** 读取 Local State，取最近使用的 profile 与全部 profile 列表。 */
async function readLocalState(userDataDir: string): Promise<LocalState> {
  try {
    const raw = await readFile(join(userDataDir, 'Local State'), 'utf8');
    const parsed = JSON.parse(raw) as {
      profile?: { last_used?: string; info_cache?: Record<string, unknown> };
    };
    const profiles = Object.keys(parsed.profile?.info_cache ?? {});
    return { lastUsed: parsed.profile?.last_used, profiles };
  } catch {
    return { profiles: [] };
  }
}

/** 定位 Cookie 数据库文件（新版 Chrome 放在 Network 子目录）。 */
function cookieDbCandidates(userDataDir: string, profile: string): string[] {
  return [join(userDataDir, profile, 'Network', 'Cookies'), join(userDataDir, profile, 'Cookies')];
}

function findCookieDb(userDataDir: string, profile: string): string | null {
  for (const p of cookieDbCandidates(userDataDir, profile)) if (existsSync(p)) return p;
  return null;
}

interface RawRow {
  host_key: string;
  name: string;
  value: string;
  /** 密文的 hex 文本（SQL 里用 hex() 取出，两条读取路径都能拿到原始字节）。 */
  encrypted_value_hex: string | null;
  path: string;
  /** SQL 里 CAST 成 TEXT，避免超过 Number.MAX_SAFE_INTEGER 时抛错。 */
  expires_utc: string | null;
  is_secure: number | null;
}

interface Query {
  sql: string;
  params: (string | number)[];
}

/** 用 node:sqlite（Node 22.5+）查询，失败则回退 sqlite3 命令行。 */
async function runQuery(dbPath: string, query: Query): Promise<Record<string, unknown>[]> {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const stmt = db.prepare(query.sql);
      return (query.params.length ? stmt.all(...query.params) : stmt.all()) as Record<string, unknown>[];
    } finally {
      db.close();
    }
  } catch {
    return runQueryViaCli(dbPath, query);
  }
}

async function runQueryViaCli(dbPath: string, query: Query): Promise<Record<string, unknown>[]> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  let sql = query.sql;
  for (const param of query.params) {
    const literal = typeof param === 'number' ? String(param) : `'${param.replace(/'/g, "''")}'`;
    sql = sql.replace('?', literal);
  }
  try {
    const { stdout } = await run('sqlite3', ['-json', dbPath, `${sql};`], { maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>[]) : [];
  } catch (err) {
    throw new Error(
      `读取 Cookie 数据库失败：${(err as Error).message}。` +
        '可安装 sqlite3 命令行工具，或升级到 Node 22.5+ 后重试。',
    );
  }
}

/** 把数据库复制到临时目录后查询，绝不修改浏览器原始数据（Chrome 运行时库会被锁）。 */
async function withCookieDbCopy<T>(dbPath: string, fn: (copy: string) => Promise<T>): Promise<T> {
  const tmp = await mkdtemp(join(tmpdir(), 'wxch-'));
  try {
    const target = join(tmp, 'Cookies');
    await copyFile(dbPath, target);
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(dbPath + ext)) await copyFile(dbPath + ext, target + ext).catch(() => undefined);
    }
    return await fn(target);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 这条 SQL 里有两处必须保留的写法（2026-10-02 实测踩坑，改动前请先看注释）：
 *
 * 1. `CAST(expires_utc AS TEXT)`：Chrome 的 expires_utc 是 1601 年起的微秒数，
 *    会话级 Cookie 的值会超过 `Number.MAX_SAFE_INTEGER`。Node 的 `node:sqlite` 遇到这种
 *    INTEGER 会直接抛 `RangeError: Value is too large to be represented as a
 *    JavaScript number`（code=ERR_OUT_OF_RANGE），整条查询随之跌进 `sqlite3` 命令行兜底分支。
 * 2. `hex(encrypted_value)`：兜底分支用 `sqlite3 -json` 输出，BLOB 会变成字符串，
 *    再用 latin1 还原会损坏密文 → 解密抛错被吞掉 → Cookie 被静默丢弃
 *    （症状：38 条 Cookie 只剩 2 条、接口报 300330「登录态失效」，看着像登录过期，其实不是）。
 *    取 hex 文本后，无论走 node:sqlite 还是 sqlite3 CLI，字节都无损。
 */
const SELECT_SQL =
  'SELECT host_key, name, value, hex(encrypted_value) AS encrypted_value_hex, path, ' +
  'CAST(expires_utc AS TEXT) AS expires_utc, is_secure ' +
  'FROM cookies WHERE host_key LIKE ? ORDER BY host_key';

/** 统计某 profile 下匹配域名的 Cookie 数量，用于挑选真正有登录态的 profile。 */
async function countDomainCookies(userDataDir: string, profile: string, like: string): Promise<number> {
  const db = findCookieDb(userDataDir, profile);
  if (!db) return 0;
  try {
    return await withCookieDbCopy(db, async (copy) => {
      const rows = await runQuery(copy, {
        sql: 'SELECT COUNT(*) AS n FROM cookies WHERE host_key LIKE ?',
        params: [like],
      });
      return Number(rows[0]?.n ?? 0);
    });
  } catch {
    return 0;
  }
}

export interface ChromeProfileChoice {
  userDataDir: string;
  browser: BrowserName;
  profile: string;
  /** 选择该 profile 的原因，便于排障。 */
  reason: string;
}

/**
 * 挑选 profile：优先选真正含有目标站点 Cookie 的那个，
 * 而不是简单取「最近使用」——多 profile 场景下后者常常没有登录态。
 */
export async function resolveChromeProfile(options: {
  browser?: BrowserName;
  profile?: string;
  userDataDir?: string;
  domainSuffix?: string;
}): Promise<ChromeProfileChoice> {
  const suffix = options.domainSuffix ?? COOKIE_DOMAIN_SUFFIX;
  const resolved = options.userDataDir
    ? { dir: options.userDataDir, browser: options.browser ?? ('chrome' as BrowserName) }
    : resolveUserDataDir(options.browser);

  if (options.profile) {
    return { userDataDir: resolved.dir, browser: resolved.browser, profile: options.profile, reason: '显式指定' };
  }

  const { lastUsed, profiles } = await readLocalState(resolved.dir);
  const candidates = Array.from(new Set([...profiles, 'Default']));

  const marker = `%channels.${suffix}`;
  let best: { profile: string; count: number } | null = null;
  for (const profile of candidates) {
    const count = await countDomainCookies(resolved.dir, profile, marker);
    if (count > 0 && (!best || count > best.count)) best = { profile, count };
  }
  if (best) {
    return {
      userDataDir: resolved.dir,
      browser: resolved.browser,
      profile: best.profile,
      reason: `含 channels.${suffix} Cookie（${best.count} 条）`,
    };
  }
  if (lastUsed) {
    return { userDataDir: resolved.dir, browser: resolved.browser, profile: lastUsed, reason: '最近使用' };
  }
  return { userDataDir: resolved.dir, browser: resolved.browser, profile: 'Default', reason: '默认 profile' };
}

/** Chrome 的 expires_utc 为 1601 起的微秒数，转换为 Unix 秒。 */
/** Chrome 的 expires_utc 为 1601 起的微秒数，转换为 Unix 秒。入参是 SQL 取出的 TEXT。 */
function toUnixSeconds(expiresUtc: string | null): number | undefined {
  if (!expiresUtc) return undefined;
  const micros = Number(expiresUtc);
  if (!Number.isFinite(micros) || micros <= 0) return undefined;
  return Math.round(micros / 1_000_000 - 11_644_473_600);
}

/**
 * Cookie 值必须是可安全放进 HTTP 头的 ASCII 字节。
 * 解密异常时会产生替换字符（U+FFFD），这类条目直接丢弃，避免污染整个请求头。
 */
function isUsableCookieValue(value: string): boolean {
  return value.length > 0 && /^[\x20-\x7e]+$/.test(value);
}

export interface ReadChromeCookiesOptions {
  browser?: BrowserName;
  profile?: string;
  /** 只保留该域名后缀的 Cookie，默认 weixin.qq.com。 */
  domainSuffix?: string;
  userDataDir?: string;
  /** 选定 profile 后的回调，用于输出排障信息（不含任何 Cookie 值）。 */
  onProfile?: (choice: ChromeProfileChoice) => void;
}

/**
 * 从本机 Chromium 系浏览器读取并解密指定域名的 Cookie。
 *
 * 只读：先复制数据库再查询，不修改浏览器原始数据，也不会把 Cookie 写到任何地方。
 */
export async function readChromeCookies(options: ReadChromeCookiesOptions = {}): Promise<Cookie[]> {
  const suffix = options.domainSuffix ?? COOKIE_DOMAIN_SUFFIX;
  const choice = await resolveChromeProfile({
    browser: options.browser,
    profile: options.profile,
    userDataDir: options.userDataDir,
    domainSuffix: suffix,
  });
  options.onProfile?.(choice);

  const dbPath = findCookieDb(choice.userDataDir, choice.profile);
  if (!dbPath) {
    throw new Error(
      `在 ${choice.browser}/${choice.profile} 下未找到 Cookies 数据库。` +
        '可用 --profile 指定其它 profile，或改用 --cookie 手动提供。',
    );
  }

  const rows = await withCookieDbCopy(dbPath, (copy) =>
    runQuery(copy, { sql: SELECT_SQL, params: [`%${suffix}`] }),
  );

  const { password, iterations } = await getKeyMaterial();
  const key = deriveKey(password, iterations);

  const cookies: Cookie[] = [];
  for (const raw of rows) {
    const row = raw as unknown as RawRow;
    let value = row.value;
    const hexCipher = row.encrypted_value_hex;
    if (!value && hexCipher) {
      try {
        // hex 文本 → 原始字节，避免 sqlite3 CLI 兜底路径下的字符串损坏。
        value = decryptCookieValue(Buffer.from(hexCipher, 'hex'), key, row.host_key);
      } catch {
        // 单条解密失败（多为 v20 应用绑定加密）不应中断整体流程。
        continue;
      }
    }
    if (!value || !isUsableCookieValue(value)) continue;
    cookies.push({
      name: row.name,
      value,
      domain: row.host_key,
      path: row.path || '/',
      expires: toUnixSeconds(row.expires_utc),
      secure: row.is_secure === 1,
    });
  }

  if (cookies.length === 0) {
    throw new Error(
      `在 ${choice.browser}/${choice.profile} 中未找到 ${suffix} 的 Cookie。` +
        '请确认已在该浏览器登录视频号助手，或改用 --cookie 手动提供。',
    );
  }
  return cookies;
}
