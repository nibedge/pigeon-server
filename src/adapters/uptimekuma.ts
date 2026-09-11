import type { PushParams } from "../types";
import { clip, str, type Adapter } from "./util";

/**
 * Uptime Kuma 的 webhook。
 * payload 形如 { heartbeat: { status, msg, time }, monitor: { name, url }, msg }
 *
 * heartbeat.status: 0 = DOWN, 1 = UP
 */
export const uptimekuma: Adapter = {
  name: "uptimekuma",
  label: "Uptime Kuma",

  render(body): PushParams | null {
    const name = str(body, "monitor.name") ?? "监控";
    const raw = str(body, "heartbeat.status");
    const up = raw === "1";
    // 测试推送不带 heartbeat，照样给一条，方便用户确认配对成功
    const isTest = raw === undefined;

    if (isTest) {
      return {
        title: "Uptime Kuma 已接通",
        body: clip(str(body, "msg")) ?? "测试推送",
        group: "uptimekuma",
        level: "passive",
      };
    }

    return {
      title: `${up ? "🟢 恢复" : "🔴 掉线"} · ${name}`,
      body:
        clip(str(body, "heartbeat.msg") ?? str(body, "msg")) ??
        (up ? "服务已恢复" : "服务无响应"),
      url: str(body, "monitor.url"),
      group: `uptimekuma/${name}`,
      // 同一个监控项的掉线/恢复折叠成一条
      id: `kuma-${name}`,
      status: up ? "resolved" : "firing",
      level: up ? "passive" : "timeSensitive",
    };
  },
};
