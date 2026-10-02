import { readChromeCookies, type BrowserName, type ChromeProfileChoice } from './chrome.js';
import { CookieJar, loadCookiesFromFile, parseCookieHeader } from './jar.js';
import type { ResolvedConfig } from '../types.js';

export interface CookieSourceOptions {
  /** 直接内联的 Cookie 串，优先级最高。 */
  cookie?: string;
  /** Cookie 文件路径，优先级次之。 */
  cookieFile?: string;
  browser?: BrowserName;
  profile?: string;
  userDataDir?: string;
  /** 自动选中浏览器 profile 后的回调（仅用于排障输出）。 */
  onProfile?: (choice: ChromeProfileChoice) => void;
}

let cache: { key: string; jar: CookieJar } | null = null;

/**
 * 按「显式参数 > 配置文件」的顺序解析出 CookieJar。
 * 结果按来源做进程内缓存，避免重复触发 Keychain 授权。
 */
export async function resolveCookieJar(
  config: ResolvedConfig,
  options: CookieSourceOptions = {},
): Promise<CookieJar> {
  const source = options.cookie
    ? 'inline'
    : options.cookieFile
      ? 'file'
      : config.cookieSource;

  const key = JSON.stringify({
    source,
    file: options.cookieFile ?? config.cookieFile,
    profile: options.profile ?? config.chromeProfile,
    browser: options.browser,
    inline: options.cookie ? 'set' : 'unset',
  });
  if (cache && cache.key === key) return cache.jar;

  let jar: CookieJar;
  if (source === 'inline') {
    const header = options.cookie ?? config.cookie ?? '';
    if (!header) throw new Error('cookieSource=inline 但未提供 Cookie，请使用 --cookie 或设置 WXCH_COOKIE。');
    jar = new CookieJar(parseCookieHeader(header));
  } else if (source === 'file') {
    const file = options.cookieFile ?? config.cookieFile;
    if (!file) throw new Error('cookieSource=file 但未指定文件，请使用 --cookie-file 或设置 WXCH_COOKIE_FILE。');
    jar = new CookieJar(await loadCookiesFromFile(file));
  } else {
    jar = new CookieJar(
      await readChromeCookies({
        browser: options.browser,
        profile: options.profile ?? config.chromeProfile,
        userDataDir: options.userDataDir,
        onProfile: options.onProfile,
      }),
    );
  }

  cache = { key, jar };
  return jar;
}

/** 测试或长驻进程需要刷新登录态时调用。 */
export function clearCookieCache(): void {
  cache = null;
}
