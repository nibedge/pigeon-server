import { MAX_ALERT_MESSAGES, planAlerts, summaryMessage, type AlertMessage } from "../adapters/alertmanager";
import { explainFailures } from "../apns";
import { contentRejection } from "../contentfilter";
import { clearAck } from "../db";
import { allow } from "../ratelimit";
import { cancelRepeat, deliver, deliveryCost, withDefaults } from "../push";
import { fail, ok } from "../respond";
import type { Account, Channel, Env, PushParams } from "../types";

/**
 * 一次请求最多用这么多子请求去推（Workers 一次调用最多 1000 个）。余下的给入口自己：
 * 查通道、限流、违禁词表、推不下的那几条撤提醒
 */
const ALERT_BUDGET = 800;

/** 推不下、只并进汇总的恢复告警：最多替这么多条撤掉之前排下的重复提醒和认领 */
const MAX_OVERFLOW_CLEANUPS = 20;

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
 * 一次推不完的（条数、子请求预算）并成一条「另有 N 条」
 */
export async function deliverAlertGroup(
  env: Env,
  channel: Channel,
  recipients: Account[],
  body: unknown,
): Promise<Response> {
  const plan = await planAlerts(body);
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
    const merged = withDefaults(channel, params);
    const blocked = await contentRejection(env, channel, merged);
    if (blocked) {
      sent.push({ id: params.id, status, delivered: 0, error: blocked });
      return true;
    }
    const report = await deliver(env, channel, recipients, merged);
    devices = Math.max(devices, report.results.length);
    for (const w of report.warnings ?? []) if (!warnings.includes(w)) warnings.push(w);
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
    await releaseOverflow(env, channel, rest);
  }
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
 * 并进汇总的恢复告警没有单独推，它们之前（单独推的时候）排下的重复提醒和认领要替它们了结，
 * 不然会一直响到一小时的截止
 */
async function releaseOverflow(env: Env, channel: Channel, rest: AlertMessage[]): Promise<void> {
  for (const m of rest.filter((r) => r.status === "resolved").slice(0, MAX_OVERFLOW_CLEANUPS)) {
    await cancelRepeat(env, channel.id, m.params.id);
    await clearAck(env, channel.id, m.params.id);
  }
}
