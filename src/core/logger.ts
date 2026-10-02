/**
 * 极简日志器。
 *
 * 隐私约束：任何日志都经过脱敏，绝不输出完整 Cookie / Token / API Key。
 * 输出走 stderr，避免污染 MCP 的 stdout 协议通道。
 */

/**
 * 判断字段是否敏感。
 * 先排除 cookieSource / cookieFile / endpoint 这类「只是配置项、不含凭证」的键，
 * 再匹配真正的凭证字段名。
 */
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (/(source|file|path|url|endpoint|template|model|prompt|texts?)$/.test(lower)) return false;
  return /cookie|authorization|api[-_]?key|token|secret|password|passwd|sessionid/.test(lower);
}

/** 把形如 abcdef...wxyz 的长串折叠为 abcdef…wxyz。 */
export function maskValue(value: string, keep = 4): string {
  const s = String(value ?? '');
  if (s.length <= keep * 2) return '*'.repeat(s.length || 1);
  return `${s.slice(0, keep)}…${s.slice(-keep)}`;
}

/** 递归脱敏对象中的敏感字段，用于日志与错误输出。 */
export function redact(input: unknown, depth = 0): unknown {
  if (depth > 6 || input == null) return input;
  if (Array.isArray(input)) return input.map((v) => redact(v, depth + 1));
  if (typeof input !== 'object') return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? maskValue(String(v)) : redact(v, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function createLogger(opts: { verbose?: boolean; silent?: boolean } = {}): Logger {
  const write = (prefix: string, msg: string) => {
    if (opts.silent) return;
    process.stderr.write(`${prefix}${msg}\n`);
  };
  return {
    debug: (m) => opts.verbose && write('· ', m),
    info: (m) => write('', m),
    warn: (m) => write('! ', m),
    error: (m) => write('✗ ', m),
  };
}
