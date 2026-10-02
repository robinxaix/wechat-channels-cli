import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ChannelsService } from '../core/service.js';
import { compactVideo } from '../core/parser.js';
import type { VideoItem } from '../core/types.js';
import { VERSION } from '../version.js';

/** MCP 返回统一为 JSON 文本，方便模型直接读取字段。 */
function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const hint = err instanceof Error && 'hint' in err ? (err as { hint?: string }).hint : undefined;
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message, hint }, null, 2) }],
  };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'wechat-channels-kit',
    version: VERSION,
  });

  server.tool(
    'check_login',
    '检查本机浏览器中的视频号助手登录态。live=true 时还会真实调用一次接口验证。',
    { live: z.boolean().optional().describe('是否调用接口实际验证，默认 false') },
    async ({ live }) => {
      try {
        const service = await ChannelsService.create();
        return ok(await service.checkLogin(Boolean(live)));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    'list_videos',
    '拉取已发布视频列表，返回每条视频的对象 ID、短标题、正文描述与评论数。onlyZeroComment=true 时只返回评论数为 0 的视频。外部 AI 可依据 description 自行生成评论，再调用 add_comment 提交。',
    {
      pageSize: z.number().int().min(1).max(50).optional().describe('每页条数，默认 20'),
      page: z.number().int().min(1).optional().describe('页码，默认 1'),
      onlyZeroComment: z.boolean().optional().describe('只返回评论数为 0 的视频'),
    },
    async ({ pageSize, page, onlyZeroComment }) => {
      try {
        const service = await ChannelsService.create();
        const list = await service.listVideos({ pageSize, page });
        const videos = onlyZeroComment ? list.filter((v) => v.commentCount === 0) : list;
        return ok({ total: list.length, count: videos.length, videos: videos.map(compactVideo) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    'generate_comment',
    '为某条视频生成一条评论文案，但不提交。useAi=true 走已配置的 AI 接口，否则从固定文案池随机取。',
    {
      videoId: z.string().optional().describe('视频对象 ID，用于匹配标题'),
      title: z.string().optional().describe('直接提供视频标题（与 videoId 二选一）'),
      useAi: z.boolean().optional().describe('是否使用 AI 生成'),
    },
    async ({ videoId, title, useAi }) => {
      try {
        const service = await ChannelsService.create();
        let videoTitle = title ?? '';
        if (!videoTitle && videoId) {
          const list = await service.listVideos({ pageSize: 50 }).catch(() => [] as VideoItem[]);
          videoTitle = list.find((v) => v.id === videoId)?.title ?? '';
        }
        const video: VideoItem = { id: videoId ?? '', title: videoTitle, commentCount: null, raw: null };
        return ok({ title: videoTitle, content: await service.generateText(video, Boolean(useAi)) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    'add_comment',
    '为指定视频发表一条评论。content 由调用方（外部 AI）依据 list_videos 返回的 description 生成后传入。默认 dryRun=true 只预览；必须显式传 dryRun=false 才会真正发表。',
    {
      videoId: z.string().describe('目标视频的对象 ID（取自 list_videos 的 id）'),
      content: z.string().optional().describe('评论正文；由外部 AI 生成。不传则按 useAi 用本机配置的 AI 生成'),
      useAi: z.boolean().optional().describe('content 缺省时，是否用本机配置的 AI 生成正文'),
      dryRun: z.boolean().optional().describe('默认 true（只预览）。真正发表需显式传 false'),
    },
    async ({ videoId, content, useAi, dryRun }) => {
      try {
        const service = await ChannelsService.create();
        const list = await service.listVideos({ pageSize: 50 }).catch(() => [] as VideoItem[]);
        const video: VideoItem =
          list.find((v) => v.id === videoId) ?? { id: videoId, title: '', commentCount: null, raw: null };
        const text = content ?? (await service.generateText(video, Boolean(useAi)));
        return ok(await service.addComment(video, text, dryRun ?? true));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    'batch_comment_zero',
    '找出评论数为 0 的视频并批量添加评论。默认 dryRun=true 只预览；真正提交需显式传 dryRun=false。',
    {
      limit: z.number().int().min(1).optional().describe('最多处理多少条'),
      pageSize: z.number().int().min(1).max(50).optional().describe('拉取视频的每页条数'),
      useAi: z.boolean().optional().describe('是否用 AI 生成评论文案'),
      intervalMs: z.number().int().min(0).optional().describe('每条之间的间隔毫秒'),
      dryRun: z.boolean().optional().describe('默认 true（只预览）。真正提交需显式传 false'),
    },
    async ({ limit, pageSize, useAi, intervalMs, dryRun }) => {
      try {
        const service = await ChannelsService.create();
        const outcomes = await service.batchComment({
          dryRun: dryRun ?? true,
          useAi,
          limit,
          pageSize,
          intervalMs,
        });
        return ok({ dryRun: dryRun ?? true, count: outcomes.length, outcomes });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    'comment_config_status',
    '查看评论接口配置状态。内置 create_comment 接口与请求体模板默认可用；若 usingDefaults=true，建议从真实抓包校准字段。',
    {},
    async () => {
      try {
        const service = await ChannelsService.create();
        const { endpoint, usingDefaults } = service.resolveCommentConfig();
        return ok({
          ready: true,
          commentEndpoint: service.config.commentEndpoint ?? null,
          usingDefaults,
          effectiveEndpoint: endpoint,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 注意：stdout 是 MCP 协议通道，日志一律走 stderr。
  process.stderr.write(`wechat-channels-kit MCP server v${VERSION} 已就绪（stdio）\n`);
}
