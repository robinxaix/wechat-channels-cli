import { readFile } from 'node:fs/promises';
import { COOKIE_DOMAIN_SUFFIX } from '../constants.js';
import type { Cookie } from '../types.js';

/** Cookie 集合，负责生成请求头与登录态判断。 */
export class CookieJar {
  private readonly cookies: Cookie[];

  constructor(cookies: Cookie[]) {
    this.cookies = cookies.filter((c) => c.name && c.value != null);
  }

  get size(): number {
    return this.cookies.length;
  }

  get(name: string): string | undefined {
    return this.cookies.find((c) => c.name === name)?.value;
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  /** 生成 Cookie 请求头。 */
  toHeader(): string {
    return this.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  /**
   * 粗判登录态：视频号助手会话依赖 sessionid 一类字段。
   * 仅做「是否存在」判断，不校验有效性（有效性由接口返回决定）。
   */
  looksLoggedIn(): boolean {
    return this.has('sessionid') || this.has('sessionid_wx') || this.has('wxuin');
  }

  /** 名称列表（不含值），用于展示与排障。 */
  names(): string[] {
    return this.cookies.map((c) => c.name).sort();
  }
}

/** 解析 Netscape / cookies.txt 格式。 */
export function parseNetscape(text: string): Cookie[] {
  const out: Cookie[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || (trimmed.startsWith('#') && !trimmed.startsWith('#HttpOnly_'))) continue;
    const httpOnly = trimmed.startsWith('#HttpOnly_');
    const body = httpOnly ? trimmed.slice('#HttpOnly_'.length) : trimmed;
    const parts = body.split('\t');
    if (parts.length < 7) continue;
    const [domain = '', , path = '/', secure = 'FALSE', expiry = '0', name = '', value = ''] = parts;
    out.push({
      name,
      value,
      domain,
      path,
      secure: secure.toUpperCase() === 'TRUE',
      expires: Number(expiry) || undefined,
    });
  }
  return out;
}

/** 解析 JSON 格式（支持数组、{cookies:[]}、Playwright/Puppeteer 导出）。 */
export function parseJsonCookies(text: string): Cookie[] {
  const parsed = JSON.parse(text) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : ((parsed as { cookies?: unknown[] })?.cookies ?? []);
  if (!Array.isArray(list)) throw new Error('Cookie JSON 结构无法识别，应为数组或 { cookies: [...] }');
  return list.map((raw) => {
    const c = raw as Record<string, unknown>;
    return {
      name: String(c.name ?? ''),
      value: String(c.value ?? ''),
      domain: String(c.domain ?? c.host_key ?? COOKIE_DOMAIN_SUFFIX),
      path: String(c.path ?? '/'),
      secure: Boolean(c.secure ?? c.is_secure),
      expires: typeof c.expires === 'number' ? c.expires : undefined,
    } satisfies Cookie;
  });
}

/** 解析 `name=value; name2=value2` 形式的原始 Cookie 字符串。 */
export function parseCookieHeader(header: string): Cookie[] {
  return header
    .split(';')
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => {
      const idx = seg.indexOf('=');
      const name = idx >= 0 ? seg.slice(0, idx).trim() : seg.trim();
      const value = idx >= 0 ? seg.slice(idx + 1).trim() : '';
      return { name, value, domain: COOKIE_DOMAIN_SUFFIX, path: '/' } satisfies Cookie;
    })
    .filter((c) => c.name);
}

/** 从文件读取 Cookie，自动识别 Netscape / JSON / 原始串。 */
export async function loadCookiesFromFile(file: string): Promise<Cookie[]> {
  const text = await readFile(file, 'utf8');
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`Cookie 文件为空：${file}`);
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return parseJsonCookies(trimmed);
  if (trimmed.includes('\t')) return parseNetscape(trimmed);
  return parseCookieHeader(trimmed);
}
