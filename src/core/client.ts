import { randomUUID, randomBytes } from 'node:crypto';
import { COMMENT_PAGE_URL, DEFAULT_USER_AGENT, LOGIN_ERROR_CODES, ORIGIN, POST_LIST_PATH } from './constants.js';
import { LoginRequiredError, WxchError } from './errors.js';
import type { Logger } from './logger.js';
import { parsePostList, readBaseRespCode, readCommentId, readErrCode, readErrMsg } from './parser.js';
import type { ApiResponse, CommentResult, ListVideosOptions, VideoItem } from './types.js';
import type { CookieJar } from './cookies/jar.js';

const DEFAULT_PAYLOAD = {
  currentPage: 1,
  pageSize: 20,
  reqScene: 7,
  scene: 7,
  userpageType: 11,
};

/** 生成形如 6abf7ac1-4ef9dbda 的 _rid。 */
export function newRid(): string {
  return `${randomBytes(4).toString('hex')}-${randomBytes(4).toString('hex')}`;
}

export interface ChannelsClientOptions {
  jar: CookieJar;
  origin?: string;
  timeoutMs?: number;
  logger?: Logger;
}

export class ChannelsClient {
  private readonly jar: CookieJar;
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly logger?: Logger;

  constructor(options: ChannelsClientOptions) {
    this.jar = options.jar;
    this.origin = options.origin ?? ORIGIN;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.logger = options.logger;
  }

  get cookieJar(): CookieJar {
    return this.jar;
  }

  /** 发起一次 JSON 请求，返回原始状态码与文本。 */
  async request(pathWithQuery: string, body: unknown): Promise<ApiResponse> {
    const url = /^https?:/i.test(pathWithQuery) ? pathWithQuery : `${this.origin}${pathWithQuery}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
          cookie: this.jar.toHeader(),
          origin: this.origin,
          referer: `${this.origin}/micro/interaction/comment`,
          'user-agent': DEFAULT_USER_AGENT,
        },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
      const text = await res.text();
      return { status: res.status, text };
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new WxchError(`请求超时（${this.timeoutMs}ms）：${url}`);
      }
      throw new WxchError(`请求失败：${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 拉取已发布视频列表。 */
  async listVideos(options: ListVideosOptions = {}): Promise<VideoItem[]> {
    const pageSize = Math.max(1, Math.min(50, Number(options.pageSize) || 20));
    const page = Math.max(1, Number(options.page) || 1);

    const payload: Record<string, unknown> = {
      ...DEFAULT_PAYLOAD,
      ...(options.payload ?? {}),
      currentPage: page,
      pageSize,
      timestamp: String(Date.now()),
    };
    if (options.finderId && !payload._log_finder_id) payload._log_finder_id = options.finderId;

    const query = new URLSearchParams({
      _aid: randomUUID(),
      _rid: newRid(),
      _pageUrl: COMMENT_PAGE_URL,
    });

    const res = await this.request(`${POST_LIST_PATH}?${query.toString()}`, payload);
    const json = safeJson(res.text);
    if (json === undefined) {
      throw this.htmlOrLoginError(res, '视频列表接口返回的不是 JSON');
    }
    const code = readErrCode(json);
    if (code !== undefined && code !== 0) {
      throw this.apiError(code, json, '视频列表接口');
    }
    const videos = parsePostList(json);
    this.logger?.debug(`解析到 ${videos.length} 条视频。`);
    return videos;
  }

  /**
   * 提交一条评论。
   *
   * 成功判定同时看两处：顶层 `errCode === 0`，以及 `data.baseResp.errcode === 0`。
   * 成功后从 `data.commentId` 取出新建评论的 ID。
   */
  async postComment(endpoint: string, payload: Record<string, unknown>): Promise<CommentResult> {
    const res = await this.request(prepareEndpointUrl(endpoint, this.origin), payload);
    const json = safeJson(res.text);
    if (json === undefined) {
      return { ok: false, status: res.status, msg: res.text.slice(0, 200) };
    }
    const code = readErrCode(json);
    const baseCode = readBaseRespCode(json);
    const ok = (code === undefined || code === 0) && (baseCode === undefined || baseCode === 0) && res.status < 400;
    return {
      ok,
      status: res.status,
      code: code ?? baseCode,
      msg: readErrMsg(json) || (ok ? 'request successful' : ''),
      commentId: ok ? readCommentId(json) : undefined,
      raw: json,
    };
  }

  /** 把业务错误码转成明确错误；登录态相关的错误码单独归类。 */
  private apiError(code: number, json: unknown, prefix: string): WxchError {
    const detail = `${prefix}返回 errCode=${code}${readErrMsg(json) ? ` ${readErrMsg(json)}` : ''}`;
    if (LOGIN_ERROR_CODES.has(code)) {
      return new LoginRequiredError(
        `${detail}（登录态已失效）`,
        '会话过期后无法自动恢复：请在 Chrome 里重新登录视频号助手，然后重试。',
      );
    }
    return new WxchError(detail);
  }

  /** 把疑似登录页 / 未登录响应转成明确错误。 */
  private htmlOrLoginError(res: ApiResponse, prefix: string): WxchError {
    const head = res.text.slice(0, 200);
    if (res.status === 401 || res.status === 403 || /<!doctype html|<html/i.test(head)) {
      return new LoginRequiredError(`${prefix}（HTTP ${res.status}，疑似登录态失效）`);
    }
    return new WxchError(`${prefix}：${head}`);
  }
}

/**
 * 规范化接口地址：刷新 `_rid`，并补齐缺失的 `_aid` / `_pageUrl`。
 * 这样即便只配置了 path，请求也满足站点的查询参数要求。
 */
export function prepareEndpointUrl(endpoint: string, origin = ORIGIN): string {
  const url = new URL(/^https?:/i.test(endpoint) ? endpoint : `${origin}${endpoint}`);
  url.searchParams.set('_rid', newRid());
  if (!url.searchParams.get('_aid')) url.searchParams.set('_aid', randomUUID());
  if (!url.searchParams.get('_pageUrl')) url.searchParams.set('_pageUrl', COMMENT_PAGE_URL);
  return `${url.pathname}${url.search}`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
