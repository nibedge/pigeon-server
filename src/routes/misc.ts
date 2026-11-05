import { listAdapters } from "../adapters";
import type { SweepTimes } from "../db";
import { ok } from "../respond";
import type { Env } from "../types";

export const VERSION = "0.1.0";

export function handlePing(): Response {
  return ok({ version: VERSION });
}

export function handleHealthz(): Response {
  return new Response("ok", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export function handleInfo(
  env: Env,
  sweeps: SweepTimes = { watches: null, reminders: null, apnsOk: null },
): Response {
  return ok({
    name: "pigeon",
    version: VERSION,
    // 只回 topic，不回 key id / team id —— 那两个不该对外
    topic: env.APNS_TOPIC,
    // 线上正在跑的源码版本。开源之后任何人都能拿它去对照公开仓库
    commit: env.GIT_COMMIT || "dev",
    adapters: listAdapters(),
    // 最近一轮监控巡检、重复提醒巡检跑完的时刻（毫秒）。隔了远超 5 分钟还没变，就是定时任务停了
    last_sweep_at: sweeps.watches,
    last_reminder_sweep_at: sweeps.reminders,
    // 服务端最后一次确认 APNs 通的时刻（毫秒），每轮监控巡检探一次。隔久了没变，就是推送发不出去了
    apns_ok_at: sweeps.apnsOk,
  });
}
