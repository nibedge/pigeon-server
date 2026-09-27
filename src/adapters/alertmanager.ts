import { levelFromSeverity } from "../compat/generic";
import type { PushParams } from "../types";
import { clip, digest24, pick, str, type Adapter } from "./util";

/**
 * Prometheus Alertmanager 的 webhook_configs（version 4）。
 * payload 形如 { status, groupKey, groupLabels, commonLabels, externalURL, truncatedAlerts,
 *               alerts: [{ status, labels, annotations, startsAt, endsAt, generatorURL, fingerprint }] }
 *
 * 和 Grafana 适配器不同，这里每条告警单独成一条消息：id 取 fingerprint，所以几台机器上同名的告警
 * 各算各的 —— 一台恢复只了结它自己，别的主机还在响的提醒不受影响；持续时长也各算各的。
 * 一组有好几条时，每条的副标题写着「本组 3 条触发」，通知中心里按组叠在一起。
 *
 * Alertmanager 在组里有变化（新告警加入、某条恢复）时会把整组再发一遍。已经推过、还在触发的那几条
 * 不再重推（原地替换也会再响一次）：只推这次新触发和刚恢复的，旧的在新消息的正文里点个名，
 * 副标题里的「本组 N 条触发」也一直算着它们。
 * 哪几条推过，由入口记在 KV 里（routes/alertmanager.ts 的 amseen:，只有告警指纹和触发时刻）：
 * 同一条告警、同一次触发（startsAt 没变）推过就算旧的。没有记录时（第一次见到这一组、记录过期了）
 * 退回按 startsAt 猜：30 分钟内触发的算新的。
 * 一组里既没有新触发、也没有恢复（repeat_interval 到了的重发），就整组照推 —— 那是 Alertmanager 在提醒「还没好」。
 * 宁可多响一次，不漏一条。
 */

interface Alert {
  status?: unknown;
  labels?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  startsAt?: unknown;
  endsAt?: unknown;
  generatorURL?: unknown;
  fingerprint?: unknown;
}

/**
 * 没有「推过哪几条」的记录时，触发时间在这之内的算「新」。Alertmanager 默认 group_wait 30 秒、
 * group_interval 5 分钟：新告警最晚也在触发后约 5 分半钟到这里。放宽到 30 分钟 ——
 * 看走眼成「新」只是多响一次，看走眼成「旧」才会漏
 */
export const FRESH_MS = 30 * 60_000;

/** 推过的告警：指纹 → 那一次触发的 startsAt（毫秒，没有就是 0）。同一条告警恢复后再触发，startsAt 不同，算新的 */
export type SeenAlerts = Record<string, number>;

/** 每次请求最多推这么多条单独的消息，其余并成一条「另有 N 条」 */
export const MAX_ALERT_MESSAGES = 10;

export interface AlertMessage {
  params: PushParams & { id: string };
  status: "firing" | "resolved";
  /** 告警指纹和触发时刻：入口据此记下「这条推过了」 */
  fingerprint: string;
  startsAt: number;
}

export interface AlertPlan {
  /** 要推的，按先后：新触发的（严重的在前）、刚恢复的 */
  messages: AlertMessage[];
  /** 仍在触发、之前推过、这次不再重推的条数 */
  unchanged: number;
  /** 分组 id 的摘要：当通知的 thread-id，「另有 N 条」那一条也用它作 id */
  groupDigest: string;
  /** 本组告警一共几条（含 truncatedAlerts） */
  total: number;
  /** 仍在触发、这次没重推的：入口照样记着它们 */
  quiet: { fingerprint: string; startsAt: number }[];
  /** 请求里没带上的告警条数（max_alerts 截掉的）：有截掉的，就不能把没出现的当成已经结束 */
  truncated: number;
}

function labelsOf(alert: Alert): Record<string, unknown> {
  return alert.labels && typeof alert.labels === "object" ? alert.labels : {};
}

function nameOf(alert: Alert, body: unknown): string {
  return str(alert, "labels.alertname") ?? str(body, "commonLabels.alertname") ?? str(body, "groupLabels.alertname") ?? "告警";
}

/** 哪台机器、哪个服务：instance 最常见，其次 pod、host、service、job */
function targetOf(alert: Alert): string | undefined {
  for (const key of ["instance", "pod", "host", "hostname", "node", "service", "job"]) {
    const value = str(alert, `labels.${key}`);
    if (value) return value;
  }
  return undefined;
}

function severityOf(alert: Alert, body: unknown): string | undefined {
  return str(alert, "labels.severity") ?? str(body, "commonLabels.severity") ?? str(alert, "labels.priority");
}

/** 严重的排前面：推不完时留下的是要紧的 */
function rank(alert: Alert, body: unknown): number {
  const level = levelFromSeverity(severityOf(alert, body));
  return level === "timeSensitive" ? 0 : level === "passive" ? 2 : 1;
}

function millis(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const ms = Date.parse(raw);
  // 还没结束的告警 endsAt 是 0001-01-01
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** 没有 fingerprint（很老的版本）时按标签算一个：同一组标签就是同一条告警 */
async function fingerprintOf(alert: Alert): Promise<string> {
  const fp = typeof alert.fingerprint === "string" ? alert.fingerprint.trim() : "";
  if (/^[0-9a-f]{8,32}$/i.test(fp)) return fp.toLowerCase();
  const labels = labelsOf(alert);
  const canonical = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${String(labels[k])}`)
    .join(",");
  return digest24(canonical || JSON.stringify(alert));
}

function countsLine(firing: number, resolved: number): string | undefined {
  if (firing + resolved <= 1) return undefined;
  return [firing ? `本组 ${firing} 条触发` : null, resolved ? `${resolved} 条恢复` : null].filter(Boolean).join(" · ");
}

/** 一组告警的摘要：当通知的 thread-id、「另有 N 条」的 id，也是 KV 里「推过哪几条」那条记录的名字 */
export async function groupDigestOf(body: unknown): Promise<string> {
  const groupKey = str(body, "groupKey") ?? JSON.stringify(pick(body, "groupLabels") ?? {});
  return (await digest24(groupKey)).slice(0, 12);
}

/**
 * 把一组告警排成要推的消息。seen 是之前推过的（见 SeenAlerts）；没有记录传 null，按 startsAt 猜
 */
export async function planAlerts(body: unknown, now = Date.now(), seen: SeenAlerts | null = null): Promise<AlertPlan | null> {
  const list = pick(body, "alerts");
  const alerts = (Array.isArray(list) ? list : []).filter((a): a is Alert => Boolean(a) && typeof a === "object");
  if (alerts.length === 0) return null;

  const groupDigest = await groupDigestOf(body);
  const truncated = Number(pick(body, "truncatedAlerts")) || 0;
  const fingerprints = new Map<Alert, string>();
  for (const a of alerts) fingerprints.set(a, await fingerprintOf(a));
  const fp = (a: Alert) => fingerprints.get(a) ?? "";
  const startOf = (a: Alert) => millis(a.startsAt) ?? 0;

  const resolvedOf = (a: Alert) => String(a.status ?? "").toLowerCase() === "resolved";
  const firing = alerts.filter((a) => !resolvedOf(a));
  const resolved = alerts.filter(resolvedOf);
  const fresh = firing.filter((a) => {
    // 记着推过哪几条：同一条、同一次触发推过的就是旧的
    if (seen) return seen[fp(a)] !== startOf(a);
    const started = millis(a.startsAt);
    // 没有 startsAt 的按新的算
    return started === undefined || now - started <= FRESH_MS;
  });
  // 组里有变化（新触发、刚恢复）：只推变了的，还在触发的老告警不再响一遍，在新消息里点名；
  // 一点变化都没有（repeat_interval 到了的重发、第一次见到的老告警）：整组照推
  const changed = fresh.length > 0 || resolved.length > 0;
  const loud = changed ? fresh : firing;
  const quietOld = changed ? firing.filter((a) => !fresh.includes(a)) : [];
  const counts = countsLine(firing.length, resolved.length);
  const oldNames = quietOld.map((a) => targetOf(a) ?? nameOf(a, body));

  const ordered = [...loud.sort((a, b) => rank(a, body) - rank(b, body)), ...resolved];
  const messages: AlertMessage[] = [];
  for (const alert of ordered) {
    const isResolved = resolvedOf(alert);
    const name = nameOf(alert, body);
    const target = targetOf(alert);
    const severity = severityOf(alert, body);
    const summary = str(alert, "annotations.summary") ?? str(alert, "annotations.message");
    const description = str(alert, "annotations.description");
    const started = millis(alert.startsAt);
    const ended = millis(alert.endsAt);
    const lasted = isResolved && started && ended && ended > started ? durationText(ended - started) : undefined;
    const bodyText = [
      clip(summary),
      description && description !== summary ? clip(description) : undefined,
      lasted ? `持续 ${lasted}` : undefined,
      !isResolved && oldNames.length ? `同组仍在触发：${oldNames.slice(0, 5).join("、")}${oldNames.length > 5 ? ` 等 ${oldNames.length} 条` : ""}` : undefined,
      !isResolved && truncated > 0 ? `另有 ${truncated} 条告警没带上（max_alerts 截掉了）` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    const url =
      str(alert, "annotations.runbook_url") ??
      str(alert, "annotations.runbook") ??
      str(alert, "generatorURL") ??
      str(body, "externalURL");
    messages.push({
      status: isResolved ? "resolved" : "firing",
      fingerprint: fp(alert),
      startsAt: startOf(alert),
      params: {
        title: `${isResolved ? "🟢 恢复" : "🔴 触发"} · ${name}`,
        subtitle: [target, severity, counts].filter(Boolean).join(" · ") || undefined,
        body: bodyText || (isResolved ? "告警已恢复" : "告警触发"),
        url: url && /^https?:\/\//i.test(url) ? url : undefined,
        group: `alertmanager-${groupDigest}`,
        id: `am-${fp(alert)}`,
        // App 靠它把同一个 id 的「触发 → 恢复」算成一次事件，显示持续了多久
        status: isResolved ? "resolved" : "firing",
        level: isResolved ? "passive" : (levelFromSeverity(severity) ?? "active"),
      },
    });
  }
  return {
    messages,
    unchanged: quietOld.length,
    groupDigest,
    total: alerts.length + truncated,
    quiet: quietOld.map((a) => ({ fingerprint: fp(a), startsAt: startOf(a) })),
    truncated,
  };
}

/** 毫秒 → 「18 分钟」「2 小时 5 分钟」「3 天 4 小时」 */
export function durationText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分钟` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} 天 ${hours % 24} 小时` : `${days} 天`;
}

/** 「另有 N 条」那一条的 id：一组一个，下一次的汇总原地替换上一次的 */
export function summaryId(plan: Pick<AlertPlan, "groupDigest">): string {
  return `am-more-${plan.groupDigest}`;
}

/**
 * 几条并成一条：「🔴 另有 3 条触发 · 🟢 1 条恢复」，正文列出是哪几条（告警名 · 机器）。
 * 推不下的那几条用它（lead = "另有 "），它没有单条告警的 id，恢复时各条照常单独推
 */
export function summaryMessage(list: AlertMessage[], plan: AlertPlan, lead = "另有 "): PushParams & { id: string } {
  const firing = list.filter((m) => m.status === "firing");
  const resolved = list.length - firing.length;
  const names = list.map((m) => [m.params.title?.replace(/^[^·]*·\s*/, ""), m.params.subtitle?.split(" · ")[0]].filter(Boolean).join(" · "));
  const shown = names.slice(0, 8);
  const loudest = firing.some((m) => m.params.level === "timeSensitive") ? "timeSensitive" : firing.length ? "active" : "passive";
  return {
    title: [firing.length ? `🔴 ${lead}${firing.length} 条触发` : null, resolved ? `🟢 ${firing.length ? "" : lead}${resolved} 条恢复` : null]
      .filter(Boolean)
      .join(" · "),
    body: [...shown, ...(names.length > shown.length ? [`…共 ${names.length} 条`] : [])].join("\n"),
    group: `alertmanager-${plan.groupDigest}`,
    id: summaryId(plan),
    level: loudest,
    // 并起来的这条不重复提醒：它没有单条告警的 id，里面的告警恢复时停不下它，只会响满一小时
    repeat: "0",
  };
}

/**
 * 登记在适配器表里（落地页、/info 的列表靠它）。入口不调 render：/hook/{key}/alertmanager 走
 * routes/alertmanager.ts 逐条推送。render 留一个整组汇成一条的版本，给只能推一条的场合
 */
export const alertmanager: Adapter = {
  name: "alertmanager",
  label: "Alertmanager",
  async render(body): Promise<PushParams | null> {
    const plan = await planAlerts(body);
    if (!plan || plan.messages.length === 0) return null;
    const [first] = plan.messages;
    if (plan.messages.length === 1 && first) return first.params;
    return { ...summaryMessage(plan.messages, plan, ""), id: `am-group-${plan.groupDigest}` };
  },
};
