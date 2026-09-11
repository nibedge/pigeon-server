import type { PushParams } from "../types";
import { clip, pick, str, type Adapter } from "./util";

/** 失败的事最该吵醒你，其它的安静推 */
function level(failed: boolean): string {
  return failed ? "timeSensitive" : "passive";
}

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

        const conclusion = str(run, "conclusion") ?? "unknown";
        const failed = conclusion !== "success" && conclusion !== "skipped";
        // 成功的构建不值得单独响一次
        if (!failed) return null;

        const name = str(run, "name") ?? "Workflow";
        const number = str(run, "run_number");
        const branch = str(run, "head_branch");

        return {
          title: `${name} ${conclusion === "failure" ? "失败" : conclusion} · ${repo}`,
          body: [
            branch ? `${branch} 分支` : null,
            number ? `构建 #${number}` : null,
            `由 ${actor} 触发`,
          ]
            .filter(Boolean)
            .join(" · "),
          url: str(run, "html_url"),
          group,
          level: level(failed),
        };
      }

      case "push": {
        const commits = pick(body, "commits");
        const count = Array.isArray(commits) ? commits.length : 0;
        const ref = (str(body, "ref") ?? "").replace("refs/heads/", "");
        const head = str(body, "head_commit.message");

        return {
          title: `${repo} · ${ref}`,
          subtitle: `${actor} 推送了 ${count} 个 commit`,
          body: clip(head) ?? "(无 commit 信息)",
          url: str(body, "compare"),
          group,
          level: "passive",
        };
      }

      case "issues":
      case "pull_request": {
        const action = str(body, "action") ?? "";
        // 开启、关闭、重开之外的动作太碎，不推
        if (!["opened", "closed", "reopened"].includes(action)) return null;

        const node = event === "issues" ? "issue" : "pull_request";
        const kind = event === "issues" ? "Issue" : "PR";
        const verb =
          action === "opened" ? "新建" : action === "closed" ? "关闭" : "重开";
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
