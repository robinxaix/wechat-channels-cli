import { COMMENT_PATHS, DESCRIPTION_PATHS, ID_PATHS, TITLE_PATHS } from './constants.js';
import type { VideoItem } from './types.js';

/** 从任意 JSON 结构中挑出最像「视频数组」的数组。 */
export function pickFirstArray(node: unknown, depth = 0): Record<string, unknown>[] | null {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (Array.isArray(node)) {
    const isObjArray = node.length > 0 && node.every((x) => x && typeof x === 'object' && !Array.isArray(x));
    return isObjArray ? (node as Record<string, unknown>[]) : null;
  }
  const obj = node as Record<string, unknown>;
  for (const k of ['list', 'objectList', 'postList', 'object_list', 'items', 'feeds']) {
    const v = obj[k];
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v as Record<string, unknown>[];
  }
  let best: Record<string, unknown>[] | null = null;
  for (const k of Object.keys(obj)) {
    const r = pickFirstArray(obj[k], depth + 1);
    if (r && (!best || r.length > best.length)) best = r;
  }
  return best;
}

export function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}

export function pickField(obj: unknown, paths: string[]): unknown {
  for (const p of paths) {
    const v = getByPath(obj, p);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** 按字段名正则递归查找，作为字段名不确定时的兜底。 */
export function deepFind(
  node: unknown,
  re: RegExp,
  kind: 'any' | 'number' | 'string' = 'any',
  depth = 0,
): unknown {
  if (!node || typeof node !== 'object' || depth > 6) return undefined;
  const obj = node as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!re.test(k)) continue;
    const v = obj[k];
    if (kind === 'number' && (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)))) return v;
    if (kind === 'string' && typeof v === 'string' && v.trim()) return v;
    if (kind === 'any' && (typeof v === 'number' || typeof v === 'string')) return v;
  }
  for (const k of Object.keys(obj)) {
    const r = deepFind(obj[k], re, kind, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

/** 把 post_list 响应解析为统一的视频条目。 */
export function parsePostList(json: unknown): VideoItem[] {
  const arr = pickFirstArray(json);
  if (!arr) return [];
  const items: VideoItem[] = [];
  for (const it of arr) {
    const id = String(
      pickField(it, ID_PATHS) ?? deepFind(it, /object_?id|post_?id|feed_?id/i) ?? '',
    );
    if (!id) continue;

    const description = normalizeText(
      pickField(it, DESCRIPTION_PATHS) ?? deepFind(it, /description/i, 'string') ?? '',
    );
    const shortTitle = normalizeText(pickField(it, TITLE_PATHS) ?? '');
    // 没有短标题时退回描述首行，保证列表里始终有可读文本。
    const title = (shortTitle || description.split('\n')[0] || '').slice(0, 60);

    const cc = pickField(it, COMMENT_PATHS) ?? deepFind(it, /comment.*(count|num)|(count|num).*comment/i, 'number');
    const n = Number(cc);
    items.push({
      id,
      title,
      description: description.slice(0, 1000),
      commentCount: Number.isFinite(n) ? n : null,
      raw: it,
    });
  }
  return items;
}

/** 折叠空白，便于把多行描述压成可读文本。 */
function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** 精简视频条目，供 CLI / MCP 的 JSON 输出使用，避免把上游原始响应一并抛出。 */
export function compactVideo(
  v: VideoItem,
): { id: string; title: string; description: string; commentCount: number | null } {
  return { id: v.id, title: v.title, description: v.description ?? '', commentCount: v.commentCount };
}

/** 从接口响应里读取业务错误码（不同接口字段名不一致）。 */
export function readErrCode(json: unknown): number | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const o = json as Record<string, unknown>;
  const raw = o.errCode ?? o.ret ?? o.code;
  if (raw === undefined || raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** 读取二级错误码 data.baseResp.errcode（视频号后台接口常见结构）。 */
export function readBaseRespCode(json: unknown): number | undefined {
  const base = pickField(json, ['data.baseResp.errcode', 'baseResp.errcode']);
  if (base === undefined || base === null) return undefined;
  const n = Number(base);
  return Number.isFinite(n) ? n : undefined;
}

/** 读取新建评论的 ID。 */
export function readCommentId(json: unknown): string | undefined {
  const id = pickField(json, ['data.commentId', 'data.comment.commentId', 'commentId']);
  if (id === undefined || id === null || id === '') return undefined;
  return String(id);
}

export function readErrMsg(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const o = json as Record<string, unknown>;
  const direct = o.errMsg ?? o.msg ?? o.errmsg;
  if (direct !== undefined && direct !== '') return String(direct);
  const base = pickField(json, ['data.baseResp.errmsg', 'baseResp.errmsg']);
  return base === undefined || base === null ? '' : String(base);
}
