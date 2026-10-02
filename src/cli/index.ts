#!/usr/bin/env node
import { Command } from 'commander';
import { configPath, loadConfig, updateConfig } from '../core/config.js';
import type { BrowserName } from '../core/cookies/chrome.js';
import { WxchError } from '../core/errors.js';
import { deriveTemplate, findCommentCandidates, loadHar } from '../core/har.js';
import { maskValue, redact } from '../core/logger.js';
import { compactVideo } from '../core/parser.js';
import { ChannelsService, type ServiceOptions } from '../core/service.js';
import type { AppConfig, VideoItem } from '../core/types.js';
import { VERSION } from '../version.js';
import { printJson, renderTable, truncate } from './format.js';

interface GlobalOpts {
  cookie?: string;
  cookieFile?: string;
  browser?: BrowserName;
  profile?: string;
  userDataDir?: string;
  json?: boolean;
  verbose?: boolean;
}

const program = new Command();

program
  .name('wxch')
  .description('微信视频号助手工具箱：读取已发布视频与评论数，为 0 评论视频生成并提交评论。')
  .version(VERSION)
  .option('--cookie <header>', '直接传入 Cookie 字符串（优先级最高，不落盘）')
  .option('--cookie-file <path>', '从文件读取 Cookie（Netscape 或 JSON 格式）')
  .option('--browser <name>', '指定浏览器：chrome | edge | brave | chromium')
  .option('--profile <name>', '指定浏览器 profile，缺省自动取最近使用的')
  .option('--user-data-dir <path>', '直接指定浏览器用户数据目录')
  .option('--json', '以 JSON 输出，便于程序与 AI 解析')
  .option('-v, --verbose', '输出调试日志')
  .showHelpAfterError();

function globalOpts(): GlobalOpts {
  return program.opts<GlobalOpts>();
}

function serviceOptions(): ServiceOptions {
  const o = globalOpts();
  return {
    cookie: o.cookie,
    cookieFile: o.cookieFile,
    browser: o.browser,
    profile: o.profile,
    userDataDir: o.userDataDir,
    verbose: o.verbose,
  };
}

async function withService<T>(fn: (service: ChannelsService) => Promise<T>): Promise<T> {
  const service = await ChannelsService.create(serviceOptions());
  return fn(service);
}

/** 统一错误出口：把可读信息与修复建议打到 stderr。 */
function fail(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`✗ ${message}\n`);
  if (err instanceof WxchError && err.hint) process.stderr.write(`  提示：${err.hint}\n`);
  process.exit(1);
}

function run(task: () => Promise<void>): void {
  task().catch(fail);
}

function isJson(): boolean {
  return Boolean(globalOpts().json);
}

/** 解析干跑开关：显式 --yes 才真正提交，否则一律干跑。 */
function resolveDryRun(opts: { yes?: boolean; dryRun?: boolean }, configDefault: boolean): boolean {
  if (opts.yes) return false;
  if (opts.dryRun) return true;
  return configDefault;
}

function videoRows(videos: VideoItem[]): string[][] {
  return videos.map((v, i) => [
    String(i + 1),
    v.commentCount === null ? '未知' : String(v.commentCount),
    truncate(v.title || '(无标题)', 40),
    v.id,
  ]);
}

const VIDEO_HEADERS = ['#', '评论数', '标题', '对象 ID'];

// ------------------------------------------------------------------ login
program
  .command('login')
  .description('检查视频号助手登录态')
  .option('--live', '调用接口实际验证，而不仅看 Cookie 是否存在')
  .action((opts: { live?: boolean }) =>
    run(async () => {
      const status = await withService((s) => s.checkLogin(Boolean(opts.live)));
      if (isJson()) {
        printJson(status);
        if (!status.loggedIn) process.exit(1);
        return;
      }
      process.stdout.write(`登录态：${status.loggedIn ? '已登录' : '未登录'}\n`);
      process.stdout.write(`Cookie 来源：${status.source}，共 ${status.cookieCount} 条\n`);
      if (status.profile) process.stdout.write(`浏览器 profile：${status.profile}（${status.profileReason}）\n`);
      if (opts.live) process.stdout.write(`接口验证：${status.verifiedByApi ? '通过' : '未通过'}\n`);
      if (status.warning) process.stdout.write(`注意：${status.warning}\n`);
      if (!status.loggedIn) process.exit(1);
    }),
  );

// ---------------------------------------------------------------- videos
const videos = program.command('videos').description('已发布视频相关操作');

videos
  .command('list')
  .description('拉取已发布视频列表')
  .option('--page-size <n>', '每页条数（1-50）', '20')
  .option('--page <n>', '页码', '1')
  .option('--zero', '只显示评论数为 0 的视频')
  .action((opts: { pageSize?: string; page?: string; zero?: boolean }) =>
    run(async () => {
      const pageSize = Number(opts.pageSize) || 20;
      const page = Number(opts.page) || 1;
      const list = await withService((s) => s.listVideos({ page, pageSize }));
      const filtered = opts.zero ? list.filter((v) => v.commentCount === 0) : list;
      if (isJson()) {
        printJson({ total: list.length, count: filtered.length, videos: filtered.map(compactVideo) });
        return;
      }
      process.stdout.write(`${renderTable(VIDEO_HEADERS, videoRows(filtered))}\n`);
      process.stdout.write(`\n共 ${filtered.length} 条（拉取 ${list.length} 条）。\n`);
    }),
  );

// --------------------------------------------------------------- comment
const comment = program.command('comment').description('评论相关操作');

comment
  .command('add <videoId>')
  .description('为指定视频发表评论（默认干跑，加 --yes 才真正提交）')
  .option('--text <content>', '直接指定评论正文')
  .option('--ai', '使用 AI 生成评论正文（需先配置 AI）')
  .option('--payload <json>', '临时替换请求体模板（可含 {{content}} / {{objectId}} 占位符）')
  .option('--endpoint <path>', '临时替换评论接口地址')
  .option('--show-payload', '只打印将要发送的接口地址与请求体，不发起请求')
  .option('--yes', '确认真正提交（关闭干跑）')
  .option('--dry-run', '强制干跑，只打印不提交')
  .action(
    (videoId: string, opts: {
      text?: string;
      ai?: boolean;
      payload?: string;
      endpoint?: string;
      showPayload?: boolean;
      yes?: boolean;
      dryRun?: boolean;
    }) =>
      run(async () => {
        const config = await loadConfig();
        const dryRun = resolveDryRun(opts, config.dryRun);
        const override = { template: opts.payload, endpoint: opts.endpoint };

        const result = await withService(async (s) => {
          const list = await s.listVideos({ pageSize: 50 }).catch(() => [] as VideoItem[]);
          const video: VideoItem =
            list.find((v) => v.id === videoId) ?? { id: videoId, title: '', commentCount: null, raw: null };
          const content = opts.text ?? (await s.generateText(video, Boolean(opts.ai)));

          if (opts.showPayload) {
            const preview = s.previewPayload(video, content, override);
            return { kind: 'preview' as const, video, content, preview };
          }
          return { kind: 'submit' as const, video, outcome: await s.addComment(video, content, dryRun, override) };
        });

        if (isJson()) {
          printJson(result.kind === 'preview' ? result.preview : result.outcome);
          if (result.kind === 'submit' && !result.outcome.ok) process.exit(1);
          return;
        }

        if (result.kind === 'preview') {
          process.stdout.write(`接口地址：${result.preview.endpoint}\n`);
          process.stdout.write(`评论正文：${result.content}\n`);
          process.stdout.write(`请求体：\n${JSON.stringify(result.preview.payload, null, 2)}\n`);
          return;
        }

        const { outcome } = result;
        process.stdout.write(
          `${outcome.dryRun ? '[干跑] ' : outcome.ok ? '✓ ' : '✗ '}${outcome.title || outcome.id}\n`,
        );
        process.stdout.write(`  评论：${outcome.content}\n`);
        if (outcome.commentId) process.stdout.write(`  评论 ID：${outcome.commentId}\n`);
        if (!outcome.dryRun && !outcome.ok) {
          process.stdout.write(`  结果：HTTP ${outcome.status} code=${outcome.code} ${outcome.msg ?? ''}\n`);
        }
        if (!outcome.ok) process.exit(1);
      }),
  );

comment
  .command('batch')
  .description('批量为评论数为 0 的视频添加评论（默认干跑）')
  .option('--limit <n>', '最多处理多少条')
  .option('--page-size <n>', '拉取视频的每页条数', '20')
  .option('--ai', '使用 AI 生成评论文案')
  .option('--yes', '确认真正提交（关闭干跑）')
  .option('--dry-run', '强制干跑，只打印不提交')
  .option('--interval <ms>', '每条之间的间隔毫秒')
  .action(
    (opts: {
      limit?: string;
      pageSize?: string;
      ai?: boolean;
      yes?: boolean;
      dryRun?: boolean;
      interval?: string;
    }) =>
      run(async () => {
        const config = await loadConfig();
        const dryRun = resolveDryRun(opts, config.dryRun);
        const outcomes = await withService((s) =>
          s.batchComment({
            dryRun,
            useAi: Boolean(opts.ai),
            limit: opts.limit ? Number(opts.limit) : undefined,
            pageSize: opts.pageSize ? Number(opts.pageSize) : undefined,
            intervalMs: opts.interval ? Number(opts.interval) : undefined,
          }),
        );
        if (isJson()) {
          printJson({ dryRun, count: outcomes.length, outcomes });
        } else if (outcomes.length === 0) {
          process.stdout.write('没有评论数为 0 的视频，无需处理。\n');
        } else {
          const rows = outcomes.map((o) => [
            o.dryRun ? '干跑' : o.ok ? '成功' : '失败',
            truncate(o.title || o.id, 30),
            truncate(o.content, 30),
          ]);
          process.stdout.write(`${renderTable(['结果', '视频', '评论'], rows)}\n`);
        }
        if (outcomes.some((o) => !o.ok)) process.exit(1);
      }),
  );

const template = comment.command('template').description('评论接口模板（学习式复用）');

template
  .command('import <harFile>')
  .description('从浏览器导出的 HAR 抓包中提取评论接口地址与请求体模板')
  .option('--index <n>', '候选请求的下标（配合 --list 查看）', '0')
  .option('--list', '只列出候选请求，不写入配置')
  .action((harFile: string, opts: { index?: string; list?: boolean }) =>
    run(async () => {
      const candidates = findCommentCandidates(await loadHar(harFile));
      if (candidates.length === 0) {
        throw new WxchError(
          'HAR 中没有找到疑似发表评论的请求',
          '请在视频号助手里手动发一条评论，同时用 DevTools Network 面板导出 HAR 后重试。',
        );
      }
      if (opts.list) {
        const rows = candidates.map((c, i) => [String(i), c.method, truncate(c.path.split('?')[0] ?? c.path, 50), String(c.status)]);
        if (isJson()) printJson(candidates.map((c, i) => ({ index: i, ...c })));
        else process.stdout.write(`${renderTable(['#', '方法', '路径', '状态'], rows)}\n`);
        return;
      }
      const index = Number(opts.index) || 0;
      const picked = candidates[index];
      if (!picked) throw new WxchError(`候选下标越界：${index}（共 ${candidates.length} 条）`);
      const derived = deriveTemplate(picked);
      const path = await updateConfig({
        commentEndpoint: derived.endpoint,
        commentPayloadTemplate: derived.template,
      });
      if (isJson()) printJson({ configPath: path, ...derived });
      else {
        process.stdout.write(`已写入 ${path}\n\n接口地址：${derived.endpoint}\n\n请求体模板：\n${derived.template}\n`);
        process.stdout.write('\n请核对 {{content}} 与 {{objectId}} 的替换位置是否正确。\n');
      }
    }),
  );

// ---------------------------------------------------------------- config
const config = program.command('config').description('查看与修改配置');

config
  .command('path')
  .description('输出配置文件路径')
  .action(() => {
    process.stdout.write(`${configPath()}\n`);
  });

config
  .command('show')
  .description('查看当前配置（默认脱敏）')
  .option('--show-secrets', '显示 Cookie / API Key 明文')
  .action((opts: { showSecrets?: boolean }) =>
    run(async () => {
      const cfg = await loadConfig();
      const view = opts.showSecrets ? cfg : (redact(cfg) as AppConfig);
      if (isJson()) printJson(view);
      else process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
      if (!opts.showSecrets) {
        process.stdout.write('\n（敏感字段已脱敏，如需明文请加 --show-secrets）\n');
      }
    }),
  );

config
  .command('set <key> <value>')
  .description('设置配置项，支持点号路径（如 ai.model）与 commentTexts（逗号分隔）')
  .action((key: string, value: string) =>
    run(async () => {
      const patch = buildConfigPatch(key, value);
      const path = await updateConfig(patch);
      const shown = key.toLowerCase().includes('key') || key.toLowerCase().includes('cookie') ? maskValue(value) : value;
      process.stdout.write(`已更新 ${key} = ${shown}\n配置文件：${path}\n`);
    }),
  );

function buildConfigPatch(key: string, raw: string): Partial<AppConfig> {
  const value = coerce(key, raw);
  const parts = key.split('.');
  if (parts.length === 1) return { [key]: value } as Partial<AppConfig>;
  const [head, ...rest] = parts;
  const nested: Record<string, unknown> = {};
  let cursor = nested;
  for (let i = 0; i < rest.length - 1; i++) {
    const k = rest[i] as string;
    cursor[k] = {};
    cursor = cursor[k] as Record<string, unknown>;
  }
  cursor[rest[rest.length - 1] as string] = value;
  return { [head as string]: nested } as Partial<AppConfig>;
}

function coerce(key: string, raw: string): unknown {
  if (key === 'commentTexts') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (key === 'dryRun') return raw === 'true' || raw === '1';
  if (key === 'intervalMs' || key === 'ai.temperature' || key === 'ai.timeoutMs') return Number(raw);
  if (key === 'postListPayload' || key === 'commentPayloadTemplate') {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }
  return raw;
}

// ------------------------------------------------------------------- mcp
program
  .command('mcp')
  .description('以 MCP server 方式运行（stdio），供 AI 客户端调用')
  .action(() =>
    run(async () => {
      const { startMcpServer } = await import('../mcp/server.js');
      await startMcpServer();
    }),
  );

program.parseAsync(process.argv).catch(fail);
