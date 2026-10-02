import { execFile } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const AES_IV = Buffer.alloc(16, ' ');
const KEY_LENGTH = 16; // AES-128

/** 各平台 Chrome 用于派生 Cookie 加密密钥的参数。 */
interface KdfParams {
  password: string;
  iterations: number;
}

/**
 * 取 Chrome Safe Storage 密钥。
 * macOS 走 Keychain；Linux 使用固定口令（Chrome 的既有实现）。
 */
export async function getKeyMaterial(platform = process.platform): Promise<KdfParams> {
  if (platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('/usr/bin/security', [
        'find-generic-password',
        '-w',
        '-s',
        'Chrome Safe Storage',
        '-a',
        'Chrome',
      ]);
      return { password: stdout.trim(), iterations: 1003 };
    } catch (err) {
      throw new Error(
        `无法从 Keychain 读取 Chrome Safe Storage 密钥（${(err as Error).message}）。` +
          '若在弹窗中点了「拒绝」，请到「钥匙串访问」中允许后重试；或改用 --cookie 手动传入。',
      );
    }
  }
  if (platform === 'linux') {
    return { password: 'peanuts', iterations: 1 };
  }
  throw new Error(
    `暂不支持在 ${platform} 上自动解密 Chrome Cookie（v20 应用绑定加密无法在纯 JS 中解开）。` +
      '请改用 --cookie / --cookie-file 手动提供，或在 macOS/Linux 上运行。',
  );
}

/** 由口令派生 AES-128 密钥。 */
export function deriveKey(password: string, iterations: number): Buffer {
  return pbkdf2Sync(password, 'saltysalt', iterations, KEY_LENGTH, 'sha1');
}

/**
 * 解密单条 encrypted_value。
 *
 * 兼容三种形态：
 * - `v10` + AES-128-CBC（IV 为 16 个空格），密钥由 Keychain 派生；
 * - 明文（旧版 / 已关闭加密）；
 * - `v20` 应用绑定加密：纯 JS 无法解开，抛出可读错误。
 */
export function decryptCookieValue(encrypted: Buffer, key: Buffer, hostKey = ''): string {
  if (encrypted.length === 0) return '';

  const prefix = encrypted.subarray(0, 3).toString('ascii');
  if (prefix !== 'v10' && prefix !== 'v11') {
    if (prefix === 'v20') {
      throw new Error('该 Cookie 使用 v20 应用绑定加密，纯 JS 无法解密，请改用 --cookie 手动提供。');
    }
    // 未加密，直接按 UTF-8 读取。
    return encrypted.toString('utf8');
  }

  const payload = encrypted.subarray(3);
  const decipher = createDecipheriv('aes-128-cbc', key, AES_IV);
  decipher.setAutoPadding(true);
  let plain = Buffer.concat([decipher.update(payload), decipher.final()]);

  // Chrome 130+ 在 macOS 上会在明文前拼接 32 字节 SHA-256(host_key) 做域绑定校验。
  // 注意用 >= ：空值 Cookie 的明文恰好只有这 32 字节。
  if (hostKey) {
    const hash = createHash('sha256').update(hostKey).digest();
    if (plain.length >= 32 && plain.subarray(0, 32).equals(hash)) {
      plain = plain.subarray(32);
    }
  }

  return stripTrailingJunk(plain.toString('utf8'));
}

/** 去掉解密结果尾部可能残留的填充 / 控制字符。 */
function stripTrailingJunk(value: string): string {
  let end = value.length;
  while (end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code <= 0x1f || code === 0x7f) end--;
    else break;
  }
  return value.slice(0, end);
}
