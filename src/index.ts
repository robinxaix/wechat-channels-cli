/**
 * wechat-channels-kit 库入口。
 *
 * 同时提供 CLI（bin: wxch）与 MCP server（`wxch mcp`），
 * 这里导出核心能力，便于在其他 Node 程序中直接复用。
 */

export { ChannelsClient, newRid, prepareEndpointUrl } from './core/client.js';
export { buildCommentPayload, guessTemplateFromPayload, pickTemplateText, selectZeroCommentTargets } from './core/comment.js';
export { configDir, configPath, defaultConfig, loadConfig, saveConfig, updateConfig } from './core/config.js';
export { readChromeCookies, resolveUserDataDir, type BrowserName } from './core/cookies/chrome.js';
export { decryptCookieValue, deriveKey, getKeyMaterial } from './core/cookies/decrypt.js';
export {
  CookieJar,
  loadCookiesFromFile,
  parseCookieHeader,
  parseJsonCookies,
  parseNetscape,
} from './core/cookies/jar.js';
export { clearCookieCache, resolveCookieJar, type CookieSourceOptions } from './core/cookies/source.js';
export { generateCommentText } from './core/ai.js';
export { LoginRequiredError, WxchError } from './core/errors.js';
export { deriveTemplate, findCommentCandidates, loadHar, type CapturedRequest } from './core/har.js';
export { createLogger, maskValue, redact, type Logger } from './core/logger.js';
export { deepFind, parsePostList, pickFirstArray } from './core/parser.js';
export {
  ChannelsService,
  type CommentOutcome,
  type LoginStatus,
  type ServiceOptions,
} from './core/service.js';
export type {
  AiOptions,
  ApiResponse,
  AppConfig,
  CommentResult,
  Cookie,
  ListVideosOptions,
  ResolvedConfig,
  VideoItem,
} from './core/types.js';
export { createMcpServer, startMcpServer } from './mcp/server.js';
export { VERSION } from './version.js';
