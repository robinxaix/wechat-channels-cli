/**
 * 视频号助手内部接口的固定常量。
 *
 * 这些路径来自网页端真实请求，属于站点自身的公开路由，
 * 不包含任何账号/个人标识。
 */

/** 互动管理站点下的接口前缀。 */
export const API_PREFIX = '/micro/interaction/cgi-bin/mmfinderassistant-bin';

/** 已发布视频列表接口路径。 */
export const POST_LIST_PATH = `${API_PREFIX}/post/post_list`;

/** 发表评论接口路径（作者对自己的视频发评论）。 */
export const COMMENT_CREATE_PATH = `${API_PREFIX}/comment/create_comment`;

/**
 * 发表评论的默认请求体模板。
 *
 * 字段结构来自网页端真实请求。注意：
 * - 视频 ID 放在 `exportId`，值形如 `export/UzFf...`，与列表接口解析出的 id 一致；
 * - `clientId` / `timestamp` 每次请求自动重新生成；
 * - `_log_finder_id` 是账号个人标识，这里用 {{finderId}} 占位，
 *   默认留空、由配置注入，绝不硬编码在代码里。
 */
export const DEFAULT_COMMENT_PAYLOAD_TEMPLATE = `{
  "replyCommentId": "",
  "content": "{{content}}",
  "clientId": "{{clientId}}",
  "rootCommentId": "",
  "comment": {},
  "exportId": "{{objectId}}",
  "timestamp": "{{timestamp}}",
  "_log_finder_uin": "",
  "_log_finder_id": "{{finderId}}",
  "rawKeyBuff": "",
  "pluginSessionId": null,
  "scene": 7,
  "reqScene": 7
}`;

/** 视频列表请求默认使用的页面地址（用于 _pageUrl 查询参数）。 */
export const COMMENT_PAGE_URL = 'https://channels.weixin.qq.com/micro/interaction/comment';

export const ORIGIN = 'https://channels.weixin.qq.com';

/** 读取本机 Cookie 时只关心的域名后缀。 */
export const COOKIE_DOMAIN_SUFFIX = 'weixin.qq.com';

/**
 * 登录态相关错误码（实测）：
 * - 300330：请求里没有有效会话（如缺 sessionid）；
 * - 300334：会话存在但已失效/过期，需重新登录。
 * 二者都属鉴权问题，不是请求参数错误。
 */
export const LOGIN_ERROR_CODES = new Set([300330, 300334]);

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 评论请求体模板中的占位符（用户可见写法 → 内部哨兵值）。 */
export const TOKEN_CONTENT = '__WXCH_CONTENT__';
export const TOKEN_ID = '__WXCH_ID__';
export const TOKEN_CLIENT_ID = '__WXCH_CLIENT_ID__';
export const TOKEN_TIMESTAMP = '__WXCH_TIMESTAMP__';
export const TOKEN_FINDER_ID = '__WXCH_FINDER_ID__';

/** 模板里可用的占位符名称，统一在此登记，避免各处硬编码字符串。 */
export const TEMPLATE_PLACEHOLDERS = {
  content: TOKEN_CONTENT,
  objectId: TOKEN_ID,
  exportId: TOKEN_ID,
  clientId: TOKEN_CLIENT_ID,
  timestamp: TOKEN_TIMESTAMP,
  finderId: TOKEN_FINDER_ID,
} as const;

/** 视频短标题的候选路径（列表展示用），按优先级排列。 */
export const TITLE_PATHS = [
  'desc.shortTitle.0.shortTitle',
  'desc.title',
  'title',
  'objectDesc.title',
];

/** 视频正文/描述（完整文本，供外部 AI 生成评论时作为上下文）。 */
export const DESCRIPTION_PATHS = ['desc.description', 'objectDesc.description', 'description'];

export const ID_PATHS = ['objectId', 'object_id', 'exportId', 'finderObjectId', 'postId', 'post_id', 'id'];

export const COMMENT_PATHS = [
  'commentCount',
  'comment_count',
  'commentNum',
  'comment_num',
  'commentCountV2',
  'objectCommentCount',
  'desc.commentCount',
];
