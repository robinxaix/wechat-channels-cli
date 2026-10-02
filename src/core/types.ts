/** 一条 Cookie（仅保留请求所需字段，避免携带浏览器内部信息）。 */
export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** 过期时间（Unix 秒）；0 或 undefined 表示会话 Cookie。 */
  expires?: number;
  secure?: boolean;
}

/** 已发布视频条目。 */
export interface VideoItem {
  id: string;
  /** 短标题（用于展示）；无法解析时回退为描述首行。 */
  title: string;
  /** 视频正文/描述全文，供外部 AI 生成评论时作为上下文。 */
  description?: string;
  /** 评论数；无法解析时为 null。 */
  commentCount: number | null;
  raw: unknown;
}

export interface ListVideosOptions {
  /** 页码，默认 1。 */
  page?: number;
  /** 每页条数，默认 20，上限 50。 */
  pageSize?: number;
  /** 用于 _log_finder_id 的可选值。 */
  finderId?: string;
  /** 覆盖默认请求体（用于复用真实抓包结构）。 */
  payload?: Record<string, unknown>;
}

export interface ApiResponse {
  status: number;
  text: string;
}

export interface CommentResult {
  ok: boolean;
  status: number;
  code?: number;
  msg?: string;
  /** 发表成功时返回的新评论 ID。 */
  commentId?: string;
  /** 接口原始响应，便于排障。 */
  raw?: unknown;
}

export interface AiOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  /** 采样温度，默认 0.9。 */
  temperature?: number;
  timeoutMs?: number;
}

/** 落盘的配置结构（不含任何凭证以外的个人数据）。 */
export interface AppConfig {
  /** Cookie 来源：chrome=自动读取本机 Chrome；file=从文件读取；inline=直接内联。 */
  cookieSource?: 'chrome' | 'file' | 'inline';
  /** cookieSource=file 时的 Cookie 文件路径（Netscape 或 JSON 格式）。 */
  cookieFile?: string;
  /** cookieSource=inline 时的 Cookie 字符串（谨慎使用，建议改用环境变量）。 */
  cookie?: string;
  /** Chrome 配置目录名，缺省时自动探测最近使用的 profile。 */
  chromeProfile?: string;
  /** 覆盖 post_list 请求体。 */
  postListPayload?: Record<string, unknown>;
  /**
   * 账号的 finder 标识，用于填充请求体里的 {{finderId}}（如 _log_finder_id）。
   * 属于个人标识，默认不填；多数情况下留空也能正常工作。
   */
  finderId?: string;
  /** 评论接口 path（含 query）。缺省时使用内置的 create_comment 路径。 */
  commentEndpoint?: string;
  /** 评论请求体模板，使用 {{content}} / {{objectId}} 占位。缺省时使用内置模板。 */
  commentPayloadTemplate?: string;
  /** 固定评论文案池（与 AI 二选一）。 */
  commentTexts?: string[];
  /** AI 生成评论配置。 */
  ai?: Partial<AiOptions>;
  /** 是否干跑（默认 true，只打印不提交）。 */
  dryRun?: boolean;
  /** 批量评论间隔毫秒。 */
  intervalMs?: number;
}

export interface ResolvedConfig extends AppConfig {
  cookieSource: 'chrome' | 'file' | 'inline';
  dryRun: boolean;
  intervalMs: number;
}
