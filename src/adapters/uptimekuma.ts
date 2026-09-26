import type { PushParams } from "../types";
import { clip, digest24, pick, readableId, str, type Adapter } from "./util";

/**
 * Uptime Kuma 的 webhook。
 * payload 形如 { heartbeat: { status, msg, time }, monitor: { id, name, url }, msg }
 *
 * heartbeat.status: 0 = DOWN, 1 = UP, 2 = PENDING（检查没通过、正在重试，还没判定掉线）, 3 = MAINTENANCE
 * 没有 heartbeat 的是别的通知：设置页里点「测试」发来的、证书快到期的提醒
 */
interface State {
  head: string;
  fallback: string;
  level: string;
  status?: "firing" | "resolved";
}

/**
 * 只有 DOWN 才是掉线。原先除了 UP 一律推「🔴 掉线」、时效性：新建的监控第一次检查恰好在重试中
 * 或者在维护时段，Uptime Kuma 照样发通知，就被报成了掉线。待确认和维护中安静地推，
 * 也不带 firing —— 它们不是一次故障的开始
 */
const STATES = new Map<string, State>([
  ["0", { head: "🔴 掉线", fallback: "服务无响应", status: "firing", level: "timeSensitive" }],
  ["1", { head: "🟢 恢复", fallback: "服务已恢复", status: "resolved", level: "passive" }],
  ["2", { head: "⏳ 待确认", fallback: "检查没通过，正在重试，还没判定为掉线", level: "passive" }],
  ["3", { head: "🔧 维护中", fallback: "处于维护时段", level: "passive" }],
]);

/**
 * 证书、域名快到期的提醒只有一句英文，没有 heartbeat 也没有 monitor：
 *   [官网][https://nfo.im] server certificate nfo.im will be expired in 7 days
 */
const EXPIRY_DAYS = /\b(?:will be expired|will expire|expires?)\s+in\s+(-?\d+)\s+days?\b/i;
const BRACKETS = /^\s*\[([^\]]*)\]\s*\[([^\]]*)\]/;
const SUBJECT = /\b(certificate|domain)\s+(\S+)\s+(?:will|expires?)\b/i;

/** 快到期的提醒推得比掉线轻，只在最后一周用时效性 */
const URGENT_DAYS = 7;

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

async function expiryNotice(msg: string): Promise<PushParams | null> {
  const days = EXPIRY_DAYS.exec(msg)?.[1];
  const [, kind = "", subject = ""] = SUBJECT.exec(msg) ?? [];
  if (days === undefined || !subject) return null;

  const n = Number(days);
  const isDomain = kind.toLowerCase() === "domain";
  const noun = isDomain ? "域名" : "证书";
  const [, monitorName, monitorUrl] = BRACKETS.exec(msg) ?? [];
  const url = /^https?:\/\//i.test(monitorUrl ?? "") ? monitorUrl : undefined;
  const host = hostOf(url) ?? subject;
  const when = n > 0 ? `${n} 天后到期` : n === 0 ? "今天到期" : "已过期";

  return {
    title: `${noun}${n > 0 ? " " : ""}${when} · ${monitorName || host}`,
    body: n >= 0
      ? `${noun} ${subject} 还剩 ${n} 天，记得在到期前续上`
      : `${noun} ${subject} 已经过期 ${-n} 天`,
    url,
    group: monitorName ? `uptimekuma/${monitorName}` : "uptimekuma",
    // 同一个站点的几次提醒（21、14、7 天）折叠成一条，只留最新的
    id: await readableId(isDomain ? "kuma-domain-" : "kuma-cert-", host),
    level: n <= URGENT_DAYS ? "timeSensitive" : "active",
  };
}

export const uptimekuma: Adapter = {
  name: "uptimekuma",
  label: "Uptime Kuma",

  async render(body): Promise<PushParams | null> {
    const name = str(body, "monitor.name") ?? "监控";
    const raw = str(body, "heartbeat.status");
    const msg = str(body, "msg");

    if (raw === undefined) {
      if (!msg) return null;
      const expiry = await expiryNotice(msg);
      if (expiry) return expiry;
      // 设置页里点「测试」发来的是「{通知名} Testing」。原先凡是没有 heartbeat 的都当成测试，
      // 别的通知也显示成「已接通」
      if (/\btesting\b/i.test(msg)) {
        return { title: "Uptime Kuma 已接通", body: clip(msg), group: "uptimekuma", level: "passive" };
      }
      return { title: pick(body, "monitor") ? name : "Uptime Kuma", body: clip(msg), group: "uptimekuma", level: "passive" };
    }

    const state: State = STATES.get(raw) ?? { head: `❔ 状态 ${raw}`, fallback: "状态未知", level: "passive" };
    const monitorId = str(body, "monitor.id");
    return {
      title: `${state.head} · ${name}`,
      body: clip(str(body, "heartbeat.msg") ?? msg) ?? state.fallback,
      url: str(body, "monitor.url"),
      group: `uptimekuma/${name}`,
      // 同一个监控项的掉线/恢复折叠成一条。按监控 id 而不是名字：同名的监控不会互相覆盖，
      // 中文长名也不会让 id 超过 64 字节、没法折叠。没有 id 的老版本退回名字的摘要
      id: monitorId ? `kuma-${monitorId}` : `kuma-${await digest24(name)}`,
      status: state.status,
      level: state.level,
    };
  },
};
