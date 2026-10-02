import { randomUUID } from 'node:crypto';
import { TEMPLATE_PLACEHOLDERS, TOKEN_CLIENT_ID, TOKEN_CONTENT, TOKEN_FINDER_ID, TOKEN_ID, TOKEN_TIMESTAMP } from './constants.js';
import type { VideoItem } from './types.js';

/** 从文案池里随机取一条。 */
export function pickTemplateText(texts: string[] | undefined): string {
  const list = (texts ?? []).map((t) => t.trim()).filter(Boolean);
  if (list.length === 0) throw new Error('未配置任何评论文案（commentTexts 为空）');
  return list[Math.floor(Math.random() * list.length)] as string;
}

/** 只保留评论数为 0 的视频。 */
export function selectZeroCommentTargets(videos: VideoItem[]): VideoItem[] {
  return videos.filter((v) => v.commentCount === 0);
}

export interface BuildPayloadOptions {
  /** 账号的 finder 标识，用于填充 {{finderId}}；不传则留空。 */
  finderId?: string;
}

/**
 * 用模板构造评论请求体。
 *
 * 模板是 JSON 文本，可用占位符：
 * - `{{content}}`    评论正文
 * - `{{objectId}}` / `{{exportId}}`  目标视频 ID（两者等价）
 * - `{{clientId}}`   每次请求重新生成的 UUID
 * - `{{timestamp}}`  当前毫秒时间戳（字符串）
 * - `{{finderId}}`   账号 finder 标识，缺省留空
 *
 * 另外，键名为 `clientId` / `timestamp` 的字段即使写的是字面量也会被刷新，
 * 这样从 HAR 学来的模板不会复用过期的时间戳与客户端 ID。
 */
export function buildCommentPayload(
  template: string,
  objectId: string,
  content: string,
  options: BuildPayloadOptions = {},
): Record<string, unknown> {
  if (!template.trim()) throw new Error('尚未配置评论请求体模板（commentPayloadTemplate）');

  const prepared = substitutePlaceholders(template);

  let parsed: unknown;
  try {
    parsed = JSON.parse(prepared);
  } catch (err) {
    throw new Error(`评论请求体模板不是合法 JSON：${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('评论请求体模板必须是 JSON 对象');

  const idValue = /^\d+$/.test(objectId) ? Number(objectId) : objectId;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v === TOKEN_CONTENT) obj[k] = content;
      else if (v === TOKEN_ID) obj[k] = idValue;
      else if (v === TOKEN_CLIENT_ID) obj[k] = randomUUID();
      else if (v === TOKEN_TIMESTAMP) obj[k] = String(Date.now());
      else if (v === TOKEN_FINDER_ID) obj[k] = options.finderId ?? '';
      // 从 HAR 学来的模板里这些字段是字面量，按字段名刷新，避免复用旧值。
      else if (k === 'timestamp' && typeof v === 'string') obj[k] = String(Date.now());
      else if (k === 'clientId' && typeof v === 'string') obj[k] = randomUUID();
      else walk(v);
    }
  };
  walk(parsed);
  return parsed as Record<string, unknown>;
}

/** 把用户可见的 {{name}} 占位符替换成内部哨兵值。 */
export function substitutePlaceholders(template: string): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (whole, name: string) => {
    const token = (TEMPLATE_PLACEHOLDERS as Record<string, string>)[name];
    return token ?? whole;
  });
}

/**
 * 从真实请求体反推模板，用于把一次抓包转成可复用配置。
 * 规则：语义字段替换为占位符，个人标识与易变字段也一并 token 化。
 */
export function guessTemplateFromPayload(payload: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return payload;
  }
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      const lower = k.toLowerCase();
      if (typeof v === 'string' && v && /content|text|comment|word|desc/i.test(k) && !/id/i.test(k)) {
        obj[k] = '{{content}}';
      } else if (
        (typeof v === 'string' || typeof v === 'number') &&
        /object_?id|post_?id|feed_?id|export_?id/i.test(k)
      ) {
        obj[k] = '{{objectId}}';
      } else if (lower === 'clientid') {
        obj[k] = '{{clientId}}';
      } else if (lower === 'timestamp') {
        obj[k] = '{{timestamp}}';
      } else if (lower === '_log_finder_id' || lower === 'finderid') {
        // 账号个人标识，token 化后不随配置外流。
        obj[k] = '{{finderId}}';
      } else {
        walk(v);
      }
    }
  };
  walk(parsed);
  return JSON.stringify(parsed, null, 2);
}
