import { readFile } from 'node:fs/promises';
import { guessTemplateFromPayload } from './comment.js';

/** 从抓包中提取出的一条请求记录。 */
export interface CapturedRequest {
  method: string;
  url: string;
  path: string;
  reqBody: string;
  status: number;
  respBody: string;
  ts: number;
}

const PATH_MARK = '/cgi-bin/mmfinderassistant-bin/';

interface HarEntry {
  startedDateTime?: string;
  request?: {
    method?: string;
    url?: string;
    postData?: { text?: string };
  };
  response?: {
    status?: number;
    content?: { text?: string };
  };
}

/** 解析 HAR，只保留视频号助手后台接口的请求（脱敏前的原始抓包）。 */
export async function loadHar(file: string): Promise<CapturedRequest[]> {
  const raw = await readFile(file, 'utf8');
  let parsed: { log?: { entries?: HarEntry[] } };
  try {
    parsed = JSON.parse(raw) as { log?: { entries?: HarEntry[] } };
  } catch (err) {
    throw new Error(`HAR 文件解析失败：${(err as Error).message}`);
  }
  const entries = parsed.log?.entries ?? [];
  const out: CapturedRequest[] = [];
  for (const e of entries) {
    const url = e.request?.url ?? '';
    if (!url.includes(PATH_MARK)) continue;
    let path = url;
    try {
      const u = new URL(url);
      path = `${u.pathname}${u.search}`;
    } catch {
      /* 保留原样 */
    }
    out.push({
      method: (e.request?.method ?? 'GET').toUpperCase(),
      url,
      path,
      reqBody: e.request?.postData?.text ?? '',
      status: e.response?.status ?? 0,
      respBody: e.response?.content?.text ?? '',
      ts: e.startedDateTime ? Date.parse(e.startedDateTime) : 0,
    });
  }
  return out;
}

/**
 * 从抓包中挑出「疑似发表评论」的请求（排除列表类接口）。
 * `create_comment` 这类明确的发表接口排在最前，避免被其它 comment 请求盖过。
 */
export function findCommentCandidates(captures: CapturedRequest[]): CapturedRequest[] {
  const matched = captures.filter((c) => {
    const p = c.path.split('?')[0] ?? '';
    if (/post_list|post\/list/i.test(p)) return false;
    return /comment/i.test(p) && c.reqBody.trim().length > 0;
  });
  const score = (c: CapturedRequest): number => {
    const p = c.path.split('?')[0] ?? '';
    if (/create_comment/i.test(p)) return 0;
    if (/add_comment/i.test(p)) return 1;
    return 2;
  };
  return matched.sort((a, b) => score(a) - score(b));
}

export interface DerivedTemplate {
  endpoint: string;
  template: string;
}

/** 把一条抓包转成可复用的评论接口配置。 */
export function deriveTemplate(capture: CapturedRequest): DerivedTemplate {
  const url = new URL(capture.url);
  return {
    endpoint: `${url.pathname}${url.search}`,
    template: guessTemplateFromPayload(capture.reqBody),
  };
}
