/** 业务错误：携带可读信息，便于 CLI/MCP 直接返回。 */
export class WxchError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'WxchError';
  }
}

/** 登录态缺失或失效。 */
export class LoginRequiredError extends WxchError {
  constructor(message = '未检测到视频号助手登录态', hint?: string) {
    super(
      message,
      hint ?? '请先在 Chrome 中登录 https://channels.weixin.qq.com/platform/post/list 后重试。',
    );
    this.name = 'LoginRequiredError';
  }
}
