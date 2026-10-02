import { generateCommentText } from './ai.js';
import { ChannelsClient } from './client.js';
import { buildCommentPayload, pickTemplateText, selectZeroCommentTargets } from './comment.js';
import { loadConfig } from './config.js';
import { COMMENT_CREATE_PATH, DEFAULT_COMMENT_PAYLOAD_TEMPLATE } from './constants.js';
import { clearCookieCache, resolveCookieJar, type CookieSourceOptions } from './cookies/source.js';
import { LoginRequiredError } from './errors.js';
import type { ChromeProfileChoice } from './cookies/chrome.js';
import type { CookieJar } from './cookies/jar.js';
import { createLogger, type Logger } from './logger.js';
import type { AiOptions, CommentResult, ResolvedConfig, VideoItem } from './types.js';

const DEFAULT_AI_PROMPT =
  '你是视频号作者的运营助理。请根据视频标题，写一条 20 字以内、自然真诚、不像广告的自评评论，只输出评论正文。';

export interface ServiceOptions extends CookieSourceOptions {
  config?: ResolvedConfig;
  verbose?: boolean;
  silent?: boolean;
  timeoutMs?: number;
}

export interface LoginStatus {
  loggedIn: boolean;
  cookieCount: number;
  cookieNames: string[];
  source: string;
  /** 自动读取浏览器 Cookie 时，实际选中的 profile 与原因。 */
  profile?: string;
  profileReason?: string;
  /** live=true 时由接口返回决定。 */
  verifiedByApi?: boolean;
  warning?: string;
}

export interface CommentOutcome {
  id: string;
  title: string;
  content: string;
  dryRun: boolean;
  ok: boolean;
  status?: number;
  code?: number;
  msg?: string;
  /** 发表成功时返回的新评论 ID。 */
  commentId?: string;
  error?: string;
}

/** 调用级覆盖：临时替换评论接口地址或请求体模板，不写入配置。 */
export interface CommentConfigOverride {
  endpoint?: string;
  template?: string;
}

/**
 * 面向 CLI 与 MCP 的统一门面：把配置、登录态、接口调用、文案生成收敛到一处，
 * 两个入口都只依赖本类，避免逻辑分叉。
 */
export class ChannelsService {
  private constructor(
    readonly config: ResolvedConfig,
    private readonly jar: CookieJar,
    private readonly logger: Logger,
    private readonly client: ChannelsClient,
    private readonly profileChoice?: ChromeProfileChoice,
  ) {}

  static async create(options: ServiceOptions = {}): Promise<ChannelsService> {
    const config = options.config ?? (await loadConfig());
    const logger = createLogger({ verbose: options.verbose, silent: options.silent });
    let profileChoice: ChromeProfileChoice | undefined;
    const jar = await resolveCookieJar(config, {
      cookie: options.cookie,
      cookieFile: options.cookieFile,
      browser: options.browser,
      profile: options.profile,
      userDataDir: options.userDataDir,
      onProfile: (choice) => {
        profileChoice = choice;
        logger.debug(`使用 ${choice.browser}/${choice.profile}（${choice.reason}）`);
      },
    });
    const client = new ChannelsClient({ jar, logger, timeoutMs: options.timeoutMs });
    return new ChannelsService(config, jar, logger, client, profileChoice);
  }

  /** 丢弃缓存的登录态，下次调用重新读取。 */
  static refreshLogin(): void {
    clearCookieCache();
  }

  async checkLogin(live = false): Promise<LoginStatus> {
    const status: LoginStatus = {
      loggedIn: this.jar.looksLoggedIn(),
      cookieCount: this.jar.size,
      cookieNames: this.jar.names(),
      source: this.config.cookieSource,
      profile: this.profileChoice?.profile,
      profileReason: this.profileChoice?.reason,
    };
    if (!status.loggedIn) {
      status.warning = '未在 Cookie 中找到 sessionid/wxuin，请确认已在浏览器登录视频号助手。';
    }
    if (live) {
      try {
        await this.client.listVideos({ pageSize: 1 });
        status.verifiedByApi = true;
        status.loggedIn = true;
      } catch (err) {
        status.verifiedByApi = false;
        // 会话失效（300330/300334）意味着 Cookie 虽然存在但已不可用。
        if (err instanceof LoginRequiredError) status.loggedIn = false;
        status.warning = (err as Error).message;
      }
    }
    return status;
  }

  async listVideos(options: { page?: number; pageSize?: number; finderId?: string } = {}): Promise<VideoItem[]> {
    return this.client.listVideos({
      page: options.page,
      pageSize: options.pageSize,
      finderId: options.finderId ?? this.config.finderId,
      payload: this.config.postListPayload,
    });
  }

  async listZeroCommentVideos(options: { pageSize?: number } = {}): Promise<VideoItem[]> {
    return selectZeroCommentTargets(await this.listVideos(options));
  }

  /** 生成一条评论文案：优先按 useAi 决定走 AI 还是固定文案池。 */
  async generateText(video: VideoItem, useAi = false): Promise<string> {
    if (useAi) return generateCommentText(video.title, this.aiOptions());
    return pickTemplateText(this.config.commentTexts);
  }

  /** 为单条视频发表评论；dryRun 时只返回将要提交的内容。 */
  async addComment(
    video: VideoItem,
    content: string,
    dryRun = true,
    override: CommentConfigOverride = {},
  ): Promise<CommentOutcome> {
    if (dryRun) {
      return { id: video.id, title: video.title, content, dryRun: true, ok: true };
    }
    const { endpoint, template } = this.commentConfig(override);
    const payload = buildCommentPayload(template, video.id, content, { finderId: this.config.finderId });
    const result: CommentResult = await this.client.postComment(endpoint, payload);
    return {
      id: video.id,
      title: video.title,
      content,
      dryRun: false,
      ok: result.ok,
      status: result.status,
      code: result.code,
      msg: result.msg,
      commentId: result.commentId,
    };
  }

  /** 构造将要提交的请求体，供干跑预览与排障使用（不发起请求）。 */
  previewPayload(
    video: VideoItem,
    content: string,
    override: CommentConfigOverride = {},
  ): { endpoint: string; payload: Record<string, unknown> } {
    const { endpoint, template } = this.commentConfig(override);
    return {
      endpoint,
      payload: buildCommentPayload(template, video.id, content, { finderId: this.config.finderId }),
    };
  }

  /** 合并调用级覆盖与配置/内置默认值。 */
  private commentConfig(override: CommentConfigOverride): { endpoint: string; template: string } {
    const base = this.resolveCommentConfig();
    return {
      endpoint: override.endpoint ?? base.endpoint,
      template: override.template ?? base.template,
    };
  }

  /** 批量为 0 评论视频添加评论。 */
  async batchComment(
    options: { dryRun?: boolean; useAi?: boolean; limit?: number; pageSize?: number; intervalMs?: number } = {},
  ): Promise<CommentOutcome[]> {
    const dryRun = options.dryRun ?? this.config.dryRun;
    const intervalMs = Math.max(0, options.intervalMs ?? this.config.intervalMs);
    let targets = await this.listZeroCommentVideos({ pageSize: options.pageSize });
    if (options.limit && options.limit > 0) targets = targets.slice(0, options.limit);

    // 非干跑时提前提示：若仍在用内置模板，字段可能与真实接口有出入。
    if (!dryRun && this.resolveCommentConfig().usingDefaults) {
      this.logger.warn(
        '当前使用内置评论请求体模板，若接口报参数错误，请用 `wxch comment template import <har>` 从真实抓包校准。',
      );
    }

    const outcomes: CommentOutcome[] = [];
    for (const video of targets) {
      try {
        const content = await this.generateText(video, options.useAi);
        const outcome = await this.addComment(video, content, dryRun);
        outcomes.push(outcome);
        this.logger.info(
          `${dryRun ? '[干跑] ' : outcome.ok ? '✓ ' : '✗ '}${video.title || video.id} → ${content}` +
            (!dryRun && !outcome.ok ? `（${outcome.code ?? outcome.status} ${outcome.msg ?? ''}）` : ''),
        );
      } catch (err) {
        outcomes.push({
          id: video.id,
          title: video.title,
          content: '',
          dryRun,
          ok: false,
          error: (err as Error).message,
        });
        this.logger.warn(`处理失败 ${video.title || video.id}：${(err as Error).message}`);
      }
      if (intervalMs > 0) await sleep(intervalMs);
    }
    return outcomes;
  }

  /**
   * 取评论接口配置。
   * 未配置时回退到内置的 create_comment 接口与内置模板，
   * 并通过 usingDefaults 告知调用方（便于提示用户核对字段）。
   */
  resolveCommentConfig(): { endpoint: string; template: string; usingDefaults: boolean } {
    const endpoint = this.config.commentEndpoint || COMMENT_CREATE_PATH;
    const template = this.config.commentPayloadTemplate || DEFAULT_COMMENT_PAYLOAD_TEMPLATE;
    return {
      endpoint,
      template,
      usingDefaults: !this.config.commentEndpoint || !this.config.commentPayloadTemplate,
    };
  }

  aiOptions(): AiOptions {
    const ai = this.config.ai ?? {};
    return {
      baseUrl: ai.baseUrl ?? 'https://api.openai.com/v1',
      apiKey: ai.apiKey ?? '',
      model: ai.model ?? 'gpt-4o-mini',
      prompt: ai.prompt ?? DEFAULT_AI_PROMPT,
      temperature: ai.temperature ?? 0.9,
      timeoutMs: ai.timeoutMs ?? 30_000,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
