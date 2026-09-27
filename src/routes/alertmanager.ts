import {
  groupDigestOf,
  MAX_ALERT_MESSAGES,
  planAlerts,
  summaryId,
  summaryMessage,
  type AlertMessage,
  type AlertPlan,
  type SeenAlerts,
} from "../adapters/alertmanager";
import { explainFailures } from "../apns";
import { contentRejection } from "../contentfilter";
import { clearAck } from "../db";
import { allow } from "../ratelimit";
import { cancelRepeat, deliver, deliveryCost, withDefaults } from "../push";
import { fail, ok } from "../respond";
import { limitToToken, type SendToken } from "../tokens";
import type { Account, Channel, Env, PushParams } from "../types";

/**
 * 一次请求最多用这么多子请求去推（Workers 一次调用最多 1000 个）。余下的给入口自己：
 * 查通道、限流、违禁词表、推不下的那几条撤提醒
 */
const ALERT_BUDGET = 800;

/** 没单独推出去的恢复告警：最多替这么多条撤掉之前排下的重复提醒和认领 */
const MAX_RESOLVED_CLEANUPS = 20;

/**
 * 每组告警里推过哪几条：amseen:{通道 id}:{分组摘要} → {"alerts": {指纹: 触发时刻}}。
 * 只有 Alertmanager 自己算的指纹（按标签算的哈希）和触发时刻，没有告警内容。
 * 靠它分清「组里新来的」和「推过、还在触发的」：Alertmanager 每 group_interval（默认 5 分钟）就可能把整组再发一遍，
 * 只看触发时间猜，头半小时里每次组里有变化，所有还在触发的都要再响一遍
 */
const AM_SEEN = "amseen:";
/** 两天没动静就过期：还在触发的组，Alertmanager 至少每个 repeat_interval（默认 4 小时）会再发一遍、续上 */
const SEEN_TTL_SECONDS = 2 * 24 * 3600;
/** 一组最多记这么多条：记录要一次读写完。几百条的大组记不全，没记上的下次当新的推 —— 多响一次，不漏 */
const MAX_SEEN = 300;

function seenKey(channelId: string, digest: string): string {
  return `${AM_SEEN}${channelId}:${digest}`;
}

async function loadSeen(env: Env, key: string): Promise<SeenAlerts | null> {
  try {
    const record = await env.PIGEON_KV.get<{ alerts?: SeenAlerts }>(key, "json");
    return record?.alerts && typeof record.alerts === "object" ? record.alerts : null;
  } catch {
    // 读不出来（格式坏了、KV 出错）：当没有记录，按触发时间猜
    return null;
  }
}

/**
 * 推完之后的记录：推出去了的（含并进「另有 N 条」的）、这次没重推的记上；恢复了的划掉；
 * 请求里没带上的（已经恢复并报过了）也划掉 —— 除非这次有被 max_alerts 截掉的，那样没出现不代表结束了。
 * 没推出去的（额度用完、推送失败）不记：下次还算新的，照推
 */
async function saveSeen(env: Env, key: string, before: SeenAlerts | null, plan: AlertPlan, pushed: Set<string>): Promise<void> {
  const next: SeenAlerts = plan.truncated > 0 && before ? { ...before } : {};
  for (const q of plan.quiet) next[q.fingerprint] = q.startsAt;
  for (const m of plan.messages) {
    if (m.status === "resolved") delete next[m.fingerprint];
    else if (pushed.has(m.params.id)) next[m.fingerprint] = m.startsAt;
  }
  const entries = Object.entries(next).slice(-MAX_SEEN);
  const same = before !== null && entries.length === Object.keys(before).length && entries.every(([fp, at]) => before[fp] === at);
  try {
    if (entries.length === 0) {
      if (before) await env.PIGEON_KV.delete(key);
    } else if (!same || pushed.size > 0) {
      // 推过东西就重写一遍，顺带续上过期时间
      await env.PIGEON_KV.put(key, JSON.stringify({ alerts: Object.fromEntries(entries) }), { expirationTtl: SEEN_TTL_SECONDS });
    }
  } catch {
    // 同一个键一秒只能写一次（Alertmanager 高可用的几台几乎同时发来同一组时会撞上）：没记上只是下次多响一次
  }
}

interface Sent {
  id: string;
  status: "firing" | "resolved";
  delivered: number;
  error?: string;
  suppressed?: true;
  repeat?: { every: number; until: number; id: string };
}

/**
 * /hook/{key}/alertmanager：一组告警逐条推（见 adapters/alertmanager.ts）。
 * 入口（routes/hook.ts）已经查过 key、停用、限流、只收加密，请求体也解析好了。
 *
 * 每条都是一次正常的投递：按 fingerprint 各有各的 id，各自去重、各自排重复提醒、各自被认领和恢复。
 * 通道每分钟的额度按条算：入口已经扣了一条，从第二条起每条再扣一次，扣不动就停下，剩下的在响应里说明。
 * 一次推不完的（条数、子请求预算）并成一条「另有 N 条」。
 * 用发送令牌推的（见 tokens.ts）：每条都按令牌的级别上限收一收，payload 带上令牌名 from
 */
export async function deliverAlertGroup(
  env: Env,
  channel: Channel,
  recipients: Account[],
  body: unknown,
  token?: SendToken,
): Promise<Response> {
  const key = seenKey(channel.id, await groupDigestOf(body));
  const seen = await loadSeen(env, key);
  const plan = await planAlerts(body, Date.now(), seen);
  // 空的一组（没有 alerts）：不值得推，回 200，免得 Alertmanager 当成失败一直重试
  if (!plan || plan.messages.length === 0) return ok({ adapter: "alertmanager", skipped: true, unchanged: plan?.unchanged ?? 0 });

  const per = deliveryCost(recipients);
  const room = Math.max(1, Math.min(MAX_ALERT_MESSAGES, Math.floor(ALERT_BUDGET / per)));
  // 推不完：前 room - 1 条单独推，剩下的并成一条
  const overflowing = plan.messages.length > room;
  const single = overflowing ? plan.messages.slice(0, room - 1) : plan.messages;
  const rest = overflowing ? plan.messages.slice(room - 1) : [];

  const sent: Sent[] = [];
  const warnings: string[] = [];
  let throttled = 0;
  let devices = 0;
  let failure: { status: number; message: string; reason: string } | undefined;

  const push = async (params: PushParams & { id: string }, status: "firing" | "resolved", index: number): Promise<boolean> => {
    // 第一条的额度入口已经扣过
    if (index > 0 && !(await allow(env.RL_PUSH, `push:${channel.id}`))) return false;
    const limited = limitToToken(withDefaults(channel, params), token);
    const merged = limited.params;
    const blocked = await contentRejection(env, channel, merged);
    if (blocked) {
      sent.push({ id: params.id, status, delivered: 0, error: blocked });
      return true;
    }
    const report = await deliver(env, channel, recipients, merged, { from: token?.name });
    devices = Math.max(devices, report.results.length);
    for (const w of [...limited.warnings, ...(report.warnings ?? [])]) if (!warnings.includes(w)) warnings.push(w);
    const entry: Sent = { id: params.id, status, delivered: report.delivered };
    if (report.rejection) entry.error = report.rejection.message;
    else if (report.suppressed) entry.suppressed = true;
    else if (report.results.length > 0 && report.delivered === 0) {
      failure ??= explainFailures(report.results);
      entry.error = failure.message;
    }
    if (report.repeat) entry.repeat = report.repeat;
    sent.push(entry);
    return true;
  };

  let index = 0;
  for (const message of single) {
    if (!(await push(message.params, message.status, index))) {
      throttled = single.length - index + rest.length;
      break;
    }
    index += 1;
  }
  if (!throttled && rest.length) {
    if (!(await push(summaryMessage(rest, plan), rest.some((m) => m.status === "firing") ? "firing" : "resolved", index))) {
      throttled = rest.length;
    }
  }
  // 没单独推出去的恢复告警（并进了汇总、或者额度用完了）：替它们停掉之前排下的重复提醒和认领
  const pushed = new Set(sent.map((s) => s.id));
  await releaseResolved(env, channel, plan.messages.filter((m) => m.status === "resolved" && !pushed.has(m.params.id)));
  // 记下推过哪几条。送到了（或被去重压掉，说明之前送到过）才算；并进汇总的，汇总送到了就算
  const reached = new Set(sent.filter((s) => s.delivered > 0 || s.suppressed).map((s) => s.id));
  if (overflowing && reached.has(summaryId(plan))) for (const m of rest) reached.add(m.params.id);
  await saveSeen(env, key, seen, plan, reached);
  if (throttled) warnings.push(`推送太频繁：通道每分钟的额度用完了，这一组还有 ${throttled} 条没推`);
  if (overflowing) warnings.push(`这一组有 ${plan.messages.length} 条要推，一次最多单独推 ${room - 1} 条，其余 ${rest.length} 条并成了一条`);

  const delivered = sent.reduce((sum, s) => sum + s.delivered, 0);
  const data = {
    adapter: "alertmanager",
    messages: sent,
    delivered,
    devices,
    unchanged: plan.unchanged,
    warnings,
  };
  // 一条都没送到：按第一条的失败原因回（设备失效 410、服务端或 Apple 的问题 502），Alertmanager 据此决定要不要重试。
  // 送到了一条就算收下 —— 回 5xx 的话整组会被重发，送到了的那几条又响一遍
  const accepted = sent.some((s) => s.delivered > 0 || s.suppressed);
  if (!accepted) {
    if (devices === 0 && sent.some((s) => !s.error)) return fail(410, "这个通道下没有可用设备，请在 App 里重新注册", data);
    if (failure) return fail(failure.status, failure.message, { ...data, reason: failure.reason });
    const first = sent.find((s) => s.error);
    if (first) return fail(400, first.error ?? "推送失败", data);
  }
  return ok(data);
}

/**
 * 恢复了、但这次没单独推出去的告警（并进了汇总，或者通道额度用完了），之前排下的重复提醒和认领要替它们了结，
 * 不然会一直响到一小时的截止 —— 响应是 200，Alertmanager 不会再为它们重发
 */
async function releaseResolved(env: Env, channel: Channel, resolved: AlertMessage[]): Promise<void> {
  for (const m of resolved.slice(0, MAX_RESOLVED_CLEANUPS)) {
    await cancelRepeat(env, channel.id, m.params.id);
    await clearAck(env, channel.id, m.params.id);
  }
}
