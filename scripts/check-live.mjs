#!/usr/bin/env node
/**
 * 从服务端外面看线上还活着没有。GitHub Actions 定时跑（见 .github/workflows/monitor.yml），
 * 这里退出码非 0，工作流就变红，GitHub 发邮件 —— 这条路不经过 Cloudflare，也不经过 APNs，
 * 服务端自己挂了、推送发不出去时，它照样报得出来。
 *
 *   node scripts/check-live.mjs [地址，默认 https://nfo.im]
 *
 * 只看 /info 上公开的几个时刻，不需要任何凭据。
 */
import { fileURLToPath } from "node:url";

/** 巡检 5 分钟一轮：隔了 20 分钟还没动静，就不是一两轮偶然没跑了 */
export const MAX_AGE_MS = 20 * 60_000;

/** /info 的内容 → 哪里不对，说给人听的话。没问题返回空数组 */
export function problemsOf(info, now = Date.now()) {
  const problems = [];
  const minutesAgo = (at) => Math.round((now - at) / 60_000);
  for (const [field, label] of [["last_sweep_at", "监控巡检"], ["last_reminder_sweep_at", "重复提醒巡检"]]) {
    const at = info?.[field];
    if (typeof at !== "number") problems.push(`${label}：/info 里没有 ${field}`);
    else if (now - at > MAX_AGE_MS) problems.push(`${label}停了：最后一轮是 ${minutesAgo(at)} 分钟之前`);
  }
  // null 是这个部署还没探过（刚上线，或者这个实例没配 APNs 私钥）；有过时刻、之后不动了才是推送断了
  const apnsOk = info?.apns_ok_at;
  if (typeof apnsOk === "number" && now - apnsOk > MAX_AGE_MS) {
    problems.push(`APNs 不通：最后一次探测通过是 ${minutesAgo(apnsOk)} 分钟之前，推送可能都发不出去了`);
  }
  return problems;
}

async function fetchInfo(base) {
  const response = await fetch(`${base}/info`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`/info 回了 ${response.status}`);
  return (await response.json()).data;
}

async function main() {
  const base = (process.argv[2] ?? "https://nfo.im").replace(/\/+$/, "");
  let lastError;
  // 只是这一下没连上不算：GitHub 的机器到 Cloudflare 偶尔抖一下，不值得发一封邮件
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const problems = problemsOf(await fetchInfo(base));
      for (const problem of problems) console.error(`::error::${problem}`);
      if (problems.length === 0) console.log(`${base} 正常`);
      process.exit(problems.length === 0 ? 0 : 1);
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
  console.error(`::error::${base} 连不上：${lastError instanceof Error ? lastError.message : lastError}`);
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
