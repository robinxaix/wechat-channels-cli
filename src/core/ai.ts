import { WxchError } from './errors.js';
import type { AiOptions } from './types.js';

/**
 * 调用任意 OpenAI 兼容的 /chat/completions 接口生成评论。
 * 只把「视频标题」发给该接口，不发送 Cookie 或任何账号信息。
 */
export async function generateCommentText(videoTitle: string, ai: AiOptions): Promise<string> {
  if (!ai.apiKey) throw new WxchError('未配置 AI API Key（config.ai.apiKey 或 WXCH_AI_API_KEY）');
  const base = String(ai.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new WxchError('未配置 AI 接口地址（config.ai.baseUrl）');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ai.timeoutMs ?? 30_000);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ai.apiKey}`,
      },
      body: JSON.stringify({
        model: ai.model,
        temperature: ai.temperature ?? 0.9,
        messages: [
          { role: 'system', content: ai.prompt },
          { role: 'user', content: `视频标题：${videoTitle || '(无标题)'}` },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new WxchError(`AI 接口返回 ${res.status}：${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new WxchError('AI 未返回有效内容');
    return text;
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new WxchError('AI 接口请求超时');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
