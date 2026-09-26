import type { PushParams } from "../types";
import { clip, digest24, pick, str, type Adapter } from "./util";

/**
 * Grafana 统一告警的 webhook contact point。
 * payload 形如 { status, groupKey, alerts: [{ status, labels, annotations, fingerprint, … }], title, message, externalURL }
 * 旧版告警（Grafana 11 已移除）形如 { state: "alerting" | "ok", ruleName, ruleUrl, message }，一并认
 */
function statusOf(body: unknown): string {
  const status = str(body, "status");
  if (status !== undefined) return status.toLowerCase();
  const state = (str(body, "state") ?? "").toLowerCase();
  return state === "alerting" ? "firing" : state === "ok" ? "resolved" : state;
}

export const grafana: Adapter = {
  name: "grafana",
  label: "Grafana",

  async render(body): Promise<PushParams | null> {
    const status = statusOf(body);
    // 只认 firing 和 resolved。原先认不出的一律当「恢复」推出去：格式不对的 payload 会把一件
    // 还在进行的事标成已恢复、停掉它的重复提醒。宁可多响一次，按触发处理并写明状态未知
    const resolved = status === "resolved";
    const unknown = !resolved && status !== "firing";

    const alerts = pick(body, "alerts");
    const list = Array.isArray(alerts) ? alerts : [];
    const first = list[0];

    const name =
      str(first, "labels.alertname") ??
      str(body, "commonLabels.alertname") ??
      str(body, "title") ??
      str(body, "ruleName") ??
      "Grafana 告警";

    const summary =
      str(first, "annotations.summary") ??
      str(first, "annotations.description") ??
      str(body, "message");

    const severity =
      str(body, "commonLabels.severity") ?? str(first, "labels.severity");
    // 一组里有一条还在触发的 critical 就算要紧，不只看第一条
    const critical =
      !resolved &&
      (severity === "critical" ||
        list.some((a) => str(a, "labels.severity") === "critical" && str(a, "status") !== "resolved"));

    // 一次带多条告警时按各条自己的状态数，不拿第一条的实例名去配整组的状态
    const firingCount = list.filter((a) => str(a, "status") === "firing").length;
    const resolvedCount = list.filter((a) => str(a, "status") === "resolved").length;
    const counts =
      list.length > 1
        ? [firingCount ? `${firingCount} 条触发` : null, resolvedCount ? `${resolvedCount} 条恢复` : null]
            .filter(Boolean)
            .join(" · ") || `${list.length} 条告警`
        : null;
    const detail = [
      unknown ? `状态：${status || "没给"}` : null,
      counts ?? str(first, "labels.instance"),
      severity,
    ]
      .filter(Boolean)
      .join(" · ");

    // 同一组告警的触发和恢复合并成一条。原先按告警名：规则按实例分组时，几台主机共用一个 id，
    // 一台恢复就把整件事标成恢复、撤掉别的主机还在响的提醒；中文长名还会超过 64 字节、没法折叠。
    // groupKey 每组一个、触发和恢复相同；没有时用第一条告警的 fingerprint
    const identity = str(body, "groupKey") ?? str(first, "fingerprint") ?? name;

    return {
      title: `${unknown ? "🔴 状态未知" : resolved ? "🟢 恢复" : "🔴 触发"} · ${name}`,
      subtitle: detail || undefined,
      body: clip(summary) ?? (resolved ? "告警已恢复" : unknown ? "状态认不出，先按触发处理" : "告警触发"),
      url:
        str(first, "generatorURL") ??
        str(body, "externalURL") ??
        str(body, "ruleUrl") ??
        undefined,
      group: `grafana/${name}`,
      id: `grafana-${await digest24(identity)}`,
      // App 靠它把「触发 → 恢复」算成一次事件，显示持续了多久
      status: resolved ? "resolved" : "firing",
      level: critical ? "timeSensitive" : resolved ? "passive" : "active",
    };
  },

  // 上一版按告警名：grafana-{名字}，名字的取法比这一版少了 ruleName 那一级
  legacyIds(body): string[] {
    const alerts = pick(body, "alerts");
    const first: unknown = Array.isArray(alerts) ? alerts[0] : undefined;
    const name =
      str(first, "labels.alertname") ?? str(body, "commonLabels.alertname") ?? str(body, "title") ?? "Grafana 告警";
    return [`grafana-${name}`];
  },
};
