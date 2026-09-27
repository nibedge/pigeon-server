import type { Watch } from "./types";
import { runDuration, watchRef } from "./watch";
import { historyStats } from "./watchhistory";
import { inMaintenance, isPaused } from "./watchquiet";

/**
 * 监控视图里监控管理加的那几项（列表、新建、编辑、立即检测都带）：
 *   ref               告警 payload 里的 watch_id 对应的值（心跳不是 id 本身，见 watch.ts watchRef）
 *   paused_until      暂停着才有：暂停到的时刻，0 = 一直暂停
 *   maintenance       每周维护窗口，in_maintenance 是此刻在不在窗口里
 *   uptime_24h / uptime_7d / uptime_30d  可用率百分数（往下取两位），还没有数据是 null
 *   last_response_ms  网址监控最近一次检查收到响应头用了多少毫秒
 *   last_duration_ms  心跳最近一次运行的用时（任务开头调过 /start 才有），running_since 是正在跑的这次从何时开始
 * 旧版 App 不认识这些字段，照常解析
 */
export async function watchDetails(watch: Watch, now: number = Date.now()): Promise<Record<string, unknown>> {
  const stats = historyStats(watch.history, now);
  const heartbeat = watch.kind === "heartbeat";
  // 和算用时同一个口径（watch.ts runDuration）：开始晚于上一次报到、不到一周。开始了一周都没报到的多半是没了下文，
  // 不再一直挂着「正在跑」
  const running = heartbeat && runDuration(watch, now) !== undefined ? watch.startedAt : undefined;
  return {
    ref: await watchRef(watch),
    ...(isPaused(watch, now) ? { paused_until: watch.pausedUntil } : {}),
    ...(watch.maintenance ? { maintenance: watch.maintenance, in_maintenance: inMaintenance(watch.maintenance, now) } : {}),
    uptime_24h: stats.uptime24h,
    uptime_7d: stats.uptime7d,
    uptime_30d: stats.uptime30d,
    ...(stats.lastMs !== null ? { [heartbeat ? "last_duration_ms" : "last_response_ms"]: stats.lastMs } : {}),
    ...(running !== undefined ? { running_since: running } : {}),
  };
}
