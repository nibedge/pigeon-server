#!/usr/bin/env node
/**
 * 审核工具：看举报、停用或恢复通道。
 *
 * 直接用本机 wrangler 的登录态读写线上 KV —— 服务端没有任何「管理接口」，
 * 也就没有一把能被偷走的管理密钥。能处理举报的，只有能部署这个 Worker 的人。
 *
 *   npm run mod -- reports                       列出举报（新的在前）
 *   npm run mod -- suspend <通道 id> [理由]       停用：推送、邀请、认领一律拒绝
 *   npm run mod -- restore <通道 id>              恢复
 *   npm run mod -- suspend-owner <账号 id> [理由]  停用这个人创建的全部通道（情节严重时）
 *   npm run mod -- inbox [通道 id]                查看 / 设置接收举报通知的通道
 *   npm run mod -- inbox off                      不再推送举报通知（举报照常落盘）
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CWD = fileURLToPath(new URL("..", import.meta.url));
const BINDING = ["--binding", "PIGEON_KV"];
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const REASONS = { spam: "垃圾信息或广告", harassment: "骚扰或辱骂", sexual: "色情低俗", illegal: "违法违规", other: "其他" };

function wrangler(args) {
  const r = spawnSync("npx", ["wrangler", ...args], { cwd: CWD, encoding: "utf8", env: process.env });
  if (r.status !== 0) {
    const tail = (r.stderr || r.stdout || "").trim().split("\n").slice(-4).join("\n");
    throw new Error(tail || `wrangler 退出码 ${r.status}`);
  }
  return r.stdout;
}

// wrangler 3 的 kv 命令默认连线上；4 起默认连本地，必须显式 --remote。
// 不按版本区分的话，哪天升级了 wrangler，这个脚本就会悄悄改成读写一个空的本地库。
const major = Number((wrangler(["--version"]).match(/(\d+)\.\d+\.\d+/) ?? [])[1] ?? 3);
const REMOTE = major >= 4 ? ["--remote"] : [];

/** wrangler 会在输出前后夹带横幅和警告，截出真正的 JSON */
function extractJSON(text) {
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const kv = {
  json(key) {
    try {
      return extractJSON(wrangler(["kv", "key", "get", key, ...BINDING, ...REMOTE]));
    } catch {
      return null;
    }
  },
  id(key) {
    try {
      const lines = wrangler(["kv", "key", "get", key, ...BINDING, ...REMOTE]).split("\n").map((s) => s.trim()).filter(Boolean);
      const last = lines.at(-1) ?? "";
      return ID_RE.test(last) ? last : null;
    } catch {
      return null;
    }
  },
  put(key, value) {
    wrangler(["kv", "key", "put", key, value, ...BINDING, ...REMOTE]);
  },
  remove(key) {
    wrangler(["kv", "key", "delete", key, ...BINDING, ...REMOTE]);
  },
  list(prefix) {
    return extractJSON(wrangler(["kv", "key", "list", "--prefix", prefix, ...BINDING, ...REMOTE])) ?? [];
  },
};

const fmt = (ms) => new Date(ms).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });

function needId(value, what) {
  if (!value || !ID_RE.test(value)) {
    console.error(`缺少${what}，或格式不对`);
    process.exit(2);
  }
  return value;
}

function setSuspended(channelId, on, reason) {
  const channel = kv.json(`chan:${channelId}`);
  if (!channel) {
    console.error(`没有这个通道：${channelId}`);
    return false;
  }
  // 字段形状必须和 src/db.ts 的 setSuspended 一模一样，服务端认的就是它
  if (on) channel.suspended = { at: Date.now(), ...(reason ? { reason } : {}) };
  else delete channel.suspended;
  kv.put(`chan:${channelId}`, JSON.stringify(channel));
  const people = 1 + (channel.memberIds?.length ?? 0);
  console.log(`${on ? "已停用" : "已恢复"}「${channel.name}」（${channelId}）· 群主 ${channel.ownerId} · ${people} 人`);
  return true;
}

const [command, arg, ...rest] = process.argv.slice(2);
const reason = rest.join(" ").trim() || undefined;

switch (command) {
  case "reports": {
    const keys = kv.list("report:");
    if (keys.length === 0) {
      console.log("没有举报");
      break;
    }
    const reports = keys.map((k) => kv.json(k.name)).filter(Boolean).sort((a, b) => b.at - a.at);
    for (const r of reports) {
      console.log(`\n${fmt(r.at)}  ${REASONS[r.reason] ?? r.reason}  「${r.channelName}」`);
      console.log(`  通道 ${r.channelId} · 群主 ${r.ownerId} · 举报人 ${r.reporterId}${r.messageId ? ` · 消息 ${r.messageId}` : " · 整个群"}`);
      if (r.detail) console.log(`  说明：${r.detail}`);
      if (r.excerpt) console.log(`  附上的内容：${r.excerpt}`);
    }
    console.log(`\n共 ${reports.length} 条。停用：npm run mod -- suspend <通道 id> 理由`);
    break;
  }
  case "suspend":
    setSuspended(needId(arg, "通道 id"), true, reason);
    break;
  case "restore":
    setSuspended(needId(arg, "通道 id"), false);
    break;
  case "suspend-owner": {
    const account = kv.json(`acct:${needId(arg, "账号 id")}`);
    if (!account) {
      console.error(`没有这个账号：${arg}`);
      process.exit(1);
    }
    let count = 0;
    for (const id of account.channelIds ?? []) {
      const channel = kv.json(`chan:${id}`);
      if (channel?.ownerId === account.id && setSuspended(id, true, reason)) count++;
    }
    console.log(`停用了 ${count} 个通道`);
    break;
  }
  case "inbox": {
    if (!arg) {
      const current = kv.id("config:mod_channel");
      console.log(current ? `举报通知发往通道 ${current}` : "还没设置接收举报通知的通道（举报照常落盘，用 reports 查看）");
      break;
    }
    if (arg === "off") {
      kv.remove("config:mod_channel");
      console.log("不再推送举报通知（举报照常落盘，用 reports 查看）");
      break;
    }
    const channel = kv.json(`chan:${needId(arg, "通道 id")}`);
    if (!channel) {
      console.error(`没有这个通道：${arg}`);
      process.exit(1);
    }
    kv.put("config:mod_channel", arg);
    console.log(`之后的举报会推到「${channel.name}」（${arg}）`);
    break;
  }
  default:
    console.log(`用法：
  npm run mod -- reports
  npm run mod -- suspend <通道 id> [理由]
  npm run mod -- restore <通道 id>
  npm run mod -- suspend-owner <账号 id> [理由]
  npm run mod -- inbox [通道 id | off]`);
}
