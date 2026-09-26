import type { PushParams } from "../types";
import { clip, pick, str, type Adapter } from "./util";

/**
 * workflow_run 跑完的结论 → 怎么推，null 表示不推。
 *
 * 只有真出了问题才用 timeSensitive 吵醒人。原先除了 success / skipped 一律按失败推，
 * 标题里直接拼英文结论：并发组自动取消旧构建是很常见的配置，每次都在半夜以时效性响一次「cancelled」。
 * 取消、跳过、中性、过期都不是故障，不推。用 Map 查：结论是对方发来的字符串，
 * 查普通对象会查到 constructor 这类原型上的东西
 */
const CONCLUSIONS = new Map<string, { text: string; level: string } | null>([
  ["success", null],
  ["skipped", null],
  ["cancelled", null],
  ["neutral", null],
  ["stale", null],
  ["failure", { text: "失败", level: "timeSensitive" }],
  ["timed_out", { text: "超时", level: "timeSensitive" }],
  ["startup_failure", { text: "没能启动", level: "timeSensitive" }],
  // 要有人批准才会跑（比如外部贡献者的 PR）：得有人动手，但不是故障
  ["action_required", { text: "需要审批", level: "active" }],
]);

/**
 * 勾了「全部事件」的仓库，每次 CI 都会来几十条这些。一条条推出来只会把通道刷到被静音 ——
 * 构建的结果看 workflow_run 那一条就够了
 */
const NOISE_EVENTS = new Set(["check_run", "check_suite", "workflow_job", "status", "deployment_status"]);

export const github: Adapter = {
  name: "github",
  label: "GitHub",

  render(body, headers): PushParams | null {
    const event = headers.get("x-github-event") ?? "";
    const repo = str(body, "repository.full_name") ?? "GitHub";
    const actor =
      str(body, "sender.login") ?? str(body, "pusher.name") ?? "someone";
    const group = `github/${repo}`;

    switch (event) {
      // GitHub 在你保存 webhook 设置时发一次，确认连通即可，不用推
      case "ping":
        return null;

      case "workflow_run": {
        const run = pick(body, "workflow_run") as Record<string, unknown> | undefined;
        if (!run) return null;
        // 只在跑完时推，排队和进行中不打扰
        if (str(run, "status") !== "completed") return null;

        const conclusion = str(run, "conclusion") ?? "";
        const known = CONCLUSIONS.get(conclusion);
        // 成功、取消、跳过的构建不值得单独响一次
        if (known === null) return null;
        // 没见过的结论照实说，但不吵人
        const outcome = known ?? { text: `结束（${conclusion || "结论未知"}）`, level: "passive" };

        const name = str(run, "name") ?? "Workflow";
        const number = str(run, "run_number");
        const branch = str(run, "head_branch");

        return {
          title: `${name} ${outcome.text} · ${repo}`,
          body: [
            branch ? `${branch} 分支` : null,
            number ? `构建 #${number}` : null,
            `由 ${actor} 触发`,
          ]
            .filter(Boolean)
            .join(" · "),
          url: str(run, "html_url"),
          group,
          level: outcome.level,
        };
      }

      case "push": {
        const fullRef = str(body, "ref") ?? "";
        const isTag = fullRef.startsWith("refs/tags/");
        const ref = fullRef.replace(/^refs\/(heads|tags)\//, "");
        const kind = isTag ? "标签" : "分支";
        const base = { title: `${repo} · ${ref}`, group, level: "passive" };

        // 删分支、删标签也是一次 push：没有 commit，原先推成「推送了 0 个 commit」
        if (pick(body, "deleted") === true) {
          return { ...base, body: `${actor} 删除了${kind} ${ref}`, url: str(body, "repository.html_url") };
        }
        if (isTag) {
          return { ...base, body: `${actor} 推送了标签 ${ref}`, url: str(body, "compare") ?? str(body, "repository.html_url") };
        }

        const commits = pick(body, "commits");
        const count = Array.isArray(commits) ? commits.length : 0;
        // 从已有的提交上拉出新分支：同样没有新 commit
        if (count === 0 && pick(body, "created") === true) {
          return { ...base, body: `${actor} 新建了分支 ${ref}`, url: str(body, "compare") };
        }

        return {
          ...base,
          subtitle: `${actor} 推送了 ${count} 个 commit`,
          body: clip(str(body, "head_commit.message")) ?? "(无 commit 信息)",
          url: str(body, "compare"),
        };
      }

      case "issues":
      case "pull_request": {
        const action = str(body, "action") ?? "";
        // 开启、关闭、重开之外的动作太碎，不推
        if (!["opened", "closed", "reopened"].includes(action)) return null;

        const node = event === "issues" ? "issue" : "pull_request";
        const kind = event === "issues" ? "Issue" : "PR";
        // 合并的 PR 在 webhook 里也是 closed：原先报成「已关闭」，意思正好相反
        const merged = event === "pull_request" && pick(body, "pull_request.merged") === true;
        const verb =
          action === "opened" ? "新建" : merged ? "合并" : action === "closed" ? "关闭" : "重开";
        const number = str(body, `${node}.number`);

        return {
          title: `${kind} #${number} 已${verb} · ${repo}`,
          subtitle: `by ${actor}`,
          body: clip(str(body, `${node}.title`)) ?? "",
          url: str(body, `${node}.html_url`),
          group,
          level: "passive",
        };
      }

      case "release": {
        if (str(body, "action") !== "published") return null;
        return {
          title: `${repo} 发布了 ${str(body, "release.tag_name") ?? "新版本"}`,
          body: clip(str(body, "release.name") ?? str(body, "release.body")) ?? "",
          url: str(body, "release.html_url"),
          group,
          level: "passive",
        };
      }

      default: {
        if (NOISE_EVENTS.has(event)) return null;
        // 没专门处理的事件，给一条最低限度但仍然可读的通知
        const action = str(body, "action");
        return {
          title: `${repo}`,
          body: `${event}${action ? ` · ${action}` : ""} · by ${actor}`,
          group,
          level: "passive",
        };
      }
    }
  },
};
