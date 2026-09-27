import {
  deleteWatch,
  getChannel,
  indexWatch,
  isValidId,
  isWatchDeleted,
  mergeWatch,
  putWatchConfig,
  readWatchConfig,
  readWatchState,
  writeWatchState,
  type StoredWatchState,
} from "../db";
import { suspensionRejection } from "../policy";
import { allow } from "../ratelimit";
import { fail, ok, tooMany } from "../respond";
import type { Account, Env, Watch } from "../types";
import { cancelWatchRepeats, checkWatchNow, nextDueAt, waitForWriteSlot } from "../watch";
import { applyWatchEdit } from "../watchedit";
import { dailyUptime, historyStats, readHistory } from "../watchhistory";
import { validTimeZone } from "../watchquiet";
import { watchDetails } from "../watchview";
import { readJSON, requireAuth, requireChannel, WATCH_NEEDS_PLAINTEXT, watchView } from "./account";

/*
 * 监控管理：编辑（含暂停、维护窗口）、立即检测、历史。新建、列表、删除在 account.ts。
 *   PATCH /account/{id}/watches/{wid}           编辑
 *   POST  /account/{id}/watches/{wid}/check     立即检测（网址监控），每个监控每分钟一次
 *   GET   /account/{id}/watches/{wid}/history   最近的状态变化、24 小时的每次检查、30 天每天的可用率
 * 都只给创建者：别人的、不存在的一律 404，不透露哪个 id 存在
 */

/** 同一个监控两次「立即检测」至少隔这么久（cron 刚查过的也算） */
export const MANUAL_CHECK_GAP_MS = 60_000;

const NO_WATCH = "没有这个监控";

/** 读出这个人的一个监控：配置、状态（原样，写之前要看它上次写的时刻）、合起来的样子 */
async function ownedWatch(
  env: Env,
  auth: Account,
  watchId: string,
): Promise<{ stored: Watch; state: StoredWatchState | null; watch: Watch } | null> {
  if (!isValidId(watchId)) return null;
  const stored = await readWatchConfig(env, watchId);
  if (!stored || stored.ownerId !== auth.id) return null;
  const state = await readWatchState(env, stored.kind, watchId);
  return { stored, state, watch: mergeWatch(stored, state) };
}

async function view(watch: Watch, request: Request): Promise<Record<string, unknown>> {
  return { ...watchView(watch, new URL(request.url).origin), ...(await watchDetails(watch)) };
}

/**
 * PATCH /account/{id}/watches/{wid} —— 改名字、网址、间隔、关键词、通道、提醒强度、心跳宽限，暂停与恢复，维护窗口。
 * 没给的字段不动。校验同新建（见 watchedit.ts）；换通道时新通道也要是自己建的、没被停用、不是只收加密的。
 *
 * 写的顺序：配置 → 索引（通道或类型变了）→ 状态（要重置或重新排期时）。先看墓碑：刚删掉的监控不会被一次编辑写回来。
 * 同一把键每秒只能写一次：离上次写不到一秒的，等一等再写（连着点两下暂停、恢复）
 */
export async function handlePatchWatch(request: Request, env: Env, accountId: string, watchId: string): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const found = await ownedWatch(env, auth, watchId);
  if (!found) return fail(404, NO_WATCH);
  const { stored, state, watch: current } = found;

  const now = Date.now();
  const edit = applyWatchEdit(current, await readJSON(request), now);
  if (typeof edit === "string") return fail(400, edit);
  if (!edit.changed) return ok({ watch: await view(current, request) });

  if (edit.watch.channelId !== current.channelId) {
    const channel = await requireChannel(env, auth, edit.watch.channelId, true);
    if (channel instanceof Response) return channel;
    const suspended = suspensionRejection(channel);
    if (suspended) return fail(403, suspended);
    if (channel.policy?.e2eOnly) return fail(400, WATCH_NEEDS_PLAINTEXT);
  }
  if (await isWatchDeleted(env, watchId)) return fail(404, NO_WATCH);

  await waitForWriteSlot(stored.updatedAt);
  await putWatchConfig(env, edit.watch);
  if (edit.indexChanged) await indexWatch(env, edit.watch);
  if (edit.stateChanged) {
    await waitForWriteSlot(state?.at);
    await writeWatchState(env, edit.watch, nextDueAt(edit.watch), now);
  }
  if (edit.cancelIn) await cancelWatchRepeats(env, current, edit.cancelIn);
  return ok({ watch: await view(edit.watch, request) });
}

/**
 * POST /account/{id}/watches/{wid}/check —— 现在就抓一次，回这次的结果。
 *
 * 结果和 cron 的检查走同一条路（见 watch.ts checkWatchNow）：真掉线了照样推告警，而且只推这一次 ——
 * 手动查出来推过的，cron 下一轮不会再推。每个监控每分钟最多一次（cron 刚查过也算），
 * 每个人每分钟还有一份总的额度：这是替人去抓别人的网站，不能被当成压测工具
 */
export async function handleCheckWatch(request: Request, env: Env, accountId: string, watchId: string): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const found = await ownedWatch(env, auth, watchId);
  if (!found) return fail(404, NO_WATCH);
  const { state, watch } = found;
  if (watch.kind === "heartbeat") {
    return fail(400, "心跳没有网址可查：它等任务来报到。看最近一次上报的时刻就知道它怎样了");
  }

  const now = Date.now();
  const since = now - (watch.lastCheckedAt ?? 0);
  if (watch.lastCheckedAt !== undefined && since >= 0 && since < MANUAL_CHECK_GAP_MS) {
    const wait = Math.ceil((MANUAL_CHECK_GAP_MS - since) / 1000);
    return tooMany(`${Math.max(1, Math.floor(since / 1000))} 秒前刚检查过，每分钟最多查一次，${wait} 秒后再试`, wait);
  }
  if (!(await allow(env.RL_ACCOUNT, `wcheck:${auth.id}`))) return tooMany("检查太频繁了，请过一分钟再试");

  const channel = await getChannel(env, watch.channelId);
  if (!channel) {
    // 推给的通道没了：监控也没有意义了（cron 也会这样清掉它）
    await deleteWatch(env, watch, now);
    return fail(404, NO_WATCH);
  }
  const suspended = suspensionRejection(channel);
  if (suspended) return fail(403, suspended);

  await waitForWriteSlot(state?.at);
  const outcome = await checkWatchNow(env, watch, channel, now);
  if (outcome.deleted) return fail(404, NO_WATCH);
  const probe = outcome.probe;
  return ok({
    result: {
      status: probe.status,
      ok: probe.status !== "down" && probe.status !== "error",
      detail: probe.detail,
      ...(probe.ms !== undefined ? { response_ms: probe.ms } : {}),
      checked_at: now,
    },
    alerted: outcome.alerted,
    watch: await view(outcome.watch, request),
  });
}

/**
 * GET /account/{id}/watches/{wid}/history?tz=Asia/Shanghai —— 详情页用的历史：
 *   changes  最近 20 次状态变化（旧的在前）：at、status、detail，暂停或维护期间发生的带 quiet
 *   checks   最近 24 小时的每次检查（心跳是每次记下的报到）：at、ok，有的带 ms（响应时间；心跳是运行用时）
 *   daily    最近 30 天按 tz 的日期汇总：date、up_seconds、down_seconds、uptime（没数据的日子不列）
 *   uptime_24h / uptime_7d / uptime_30d，last_response_ms（心跳是 last_duration_ms）
 * tz 不给就用维护窗口的时区，再没有按 UTC。服务端按小时存，按哪个时区汇总都对得上
 */
export async function handleWatchHistory(request: Request, env: Env, accountId: string, watchId: string): Promise<Response> {
  const auth = await requireAuth(request, env, accountId);
  if (auth instanceof Response) return auth;
  const found = await ownedWatch(env, auth, watchId);
  if (!found) return fail(404, NO_WATCH);
  const { watch } = found;

  const tz = (new URL(request.url).searchParams.get("tz") ?? "").trim() || watch.maintenance?.tz || "UTC";
  if (!validTimeZone(tz)) return fail(400, "tz 要写 IANA 时区名，如 Asia/Shanghai");
  const now = Date.now();
  const history = readHistory(watch.history);
  const stats = historyStats(history, now);
  const heartbeat = watch.kind === "heartbeat";
  return ok({
    watch_id: watch.id,
    kind: watch.kind,
    last_status: watch.lastStatus,
    tz,
    changes: (history?.changes ?? []).map((c) => ({
      at: c.at,
      status: c.status,
      ...(c.detail ? { detail: c.detail } : {}),
      ...(c.quiet ? { quiet: true } : {}),
    })),
    checks: (history?.checks ?? []).map(([at, ms, good]) => ({ at: at * 1000, ok: good === 1, ...(ms >= 0 ? { ms } : {}) })),
    daily: dailyUptime(history, now, tz) ?? [],
    uptime_24h: stats.uptime24h,
    uptime_7d: stats.uptime7d,
    uptime_30d: stats.uptime30d,
    ...(stats.lastMs !== null ? { [heartbeat ? "last_duration_ms" : "last_response_ms"]: stats.lastMs } : {}),
  });
}
