import type { PushParams } from "../types";
import { clip, pick, str, type Adapter } from "./util";

/**
 * Grafana 统一告警的 webhook contact point。
 * payload 形如 { status, alerts: [...], title, message, externalURL }
 */
export const grafana: Adapter = {
  name: "grafana",
  label: "Grafana",

  render(body): PushParams | null {
    const status = (str(body, "status") ?? "").toLowerCase();
    const firing = status === "firing";

    const alerts = pick(body, "alerts");
    const list = Array.isArray(alerts) ? alerts : [];
    const first = list[0];

    const name =
      str(first, "labels.alertname") ??
      str(body, "commonLabels.alertname") ??
      str(body, "title") ??
      "Grafana 告警";

    const summary =
      str(first, "annotations.summary") ??
      str(first, "annotations.description") ??
      str(body, "message");

    const instance = str(first, "labels.instance");
    const severity =
      str(first, "labels.severity") ?? str(body, "commonLabels.severity");

    const detail = [
      list.length > 1 ? `${list.length} 条告警` : null,
      instance,
      severity,
    ]
      .filter(Boolean)
      .join(" · ");

    return {
      title: `${firing ? "🔴 触发" : "🟢 恢复"} · ${name}`,
      subtitle: detail || undefined,
      body: clip(summary) ?? (firing ? "告警触发" : "告警已恢复"),
      url:
        str(first, "generatorURL") ??
        str(body, "externalURL") ??
        undefined,
      group: `grafana/${name}`,
      // 同一条告警的触发和恢复合并成一条，不在通知栏留一串
      id: `grafana-${name}`,
      // App 靠它把「触发 → 恢复」算成一次事件，显示持续了多久
      status: firing ? "firing" : "resolved",
      level: firing && severity === "critical" ? "timeSensitive" : firing ? "active" : "passive",
    };
  },
};
