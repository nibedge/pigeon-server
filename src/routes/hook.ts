import { getAdapter } from "../adapters";
import { resolveChannel } from "../db";
import { suspensionRejection } from "../policy";
import { deliver } from "../push";
import { fail, ok } from "../respond";
import type { Env } from "../types";

/**
 * POST /hook/{key}/{adapter}
 *
 * 用独立的 /hook 前缀而不是 /{key}/{adapter}，是为了避免和路径式推送的
 * /{key}/{body} 撞车 —— `/abc/github` 到底是「推一条内容为 github 的消息」
 * 还是「走 github 适配器」，靠猜是不行的。告警系统里静默走错路由是最坏的
 * 失败方式，所以这里选择显式。
 */
export async function handleHook(
  request: Request,
  env: Env,
  key: string,
  adapterName: string,
): Promise<Response> {
  if (request.method !== "POST") return fail(405, "webhook 入口只接受 POST");

  const adapter = getAdapter(adapterName);
  if (!adapter) return fail(404, `没有名为 ${adapterName} 的适配器`);

  const resolved = await resolveChannel(env, key);
  if (!resolved) return fail(404, "这个 key 不存在");
  const { channel, recipients } = resolved;
  const suspended = suspensionRejection(channel);
  if (suspended) return fail(403, suspended);
  // 第三方服务不会替你加密，发到这里的必然是明文
  if (channel.policy?.e2eOnly) {
    return fail(400, "这个通道只接受端到端加密的消息，而第三方 webhook 无法加密。请换一个通道，或经加密中继转发");
  }

  let body: unknown;
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("form-urlencoded")) {
      // GitHub 可以配成 form 编码，payload 塞在一个字段里
      const form = await request.formData();
      const raw = form.get("payload");
      body = typeof raw === "string" ? JSON.parse(raw) : Object.fromEntries(form.entries());
    } else {
      body = await request.json();
    }
  } catch {
    return fail(400, "请求体不是合法的 JSON");
  }

  let rendered;
  try {
    rendered = adapter.render(body, request.headers);
  } catch (err) {
    return fail(
      500,
      `${adapter.label} 适配器渲染失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 适配器判定这个事件不值得推（GitHub 的 ping、成功的构建……），
  // 仍然回 200，否则对方会当成投递失败一直重试。
  if (!rendered) return ok({ skipped: true, adapter: adapter.name });

  // 通道默认值垫底，适配器的判断优先 —— 适配器比通道更清楚这条事件的轻重
  const params = { ...(channel.defaults ?? {}), ...rendered };
  const report = await deliver(env, channel, recipients, params);
  const { results, delivered } = report;

  if (report.suppressed) return ok({ adapter: adapter.name, suppressed: "duplicate" });
  if (results.length === 0) return fail(410, "这个通道下没有可用设备，请在 App 里重新注册");
  if (delivered === 0) {
    const first = results[0];
    return fail(first?.status ?? 500, `推送失败: ${first?.reason ?? "未知原因"}`, {
      devices: results.length,
    });
  }
  return ok({
    adapter: adapter.name,
    delivered,
    devices: results.length,
    ...(report.quieted ? { quieted: true } : {}),
        // 因接收者开了免打扰而静默送达的设备数 —— 发送方排查「为什么没响」看这个
        ...(report.muted ? { muted: report.muted } : {}),
  });
}
