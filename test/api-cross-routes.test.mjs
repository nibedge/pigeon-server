/**
 * 几条功能线合起来之后的路由：第一段路径的分派没有互相遮挡。
 * /docs、/s/{令牌}、/mcp、群机器人的兼容地址、/{key}/receipt/{id} 各走各的，不被当成推送 key；
 * index.ts 的 switch 里接走的每个第一段路径都登记在 RESERVED 里。在进程里跑（见 l4-harness.mjs）：
 *
 *   node test/api-cross-routes.test.mjs
 */
import { readFileSync } from "node:fs";
import { call, capture, check, finish, makeEnv, newAccount } from "./l4-harness.mjs";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

console.log("\n★ switch 里接走的第一段路径都在 RESERVED 里");
{
  const reserved = new Set([...(/const RESERVED = new Set\(\[([\s\S]*?)\]\);/.exec(source)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  const app = source.slice(source.indexOf("const app = {"), source.indexOf("export default {"));
  const switchBody = app.slice(app.indexOf("switch (head) {"), app.indexOf("if (RESERVED.has(head))"));
  const cases = [...switchBody.matchAll(/^\s{6}case "([^"]+)":/gm)].map((m) => m[1]);
  check("认出了 switch 里的分支", cases.length >= 20 && cases.includes("mcp") && cases.includes("s"), cases.join(","));
  const missing = cases.filter((c) => !reserved.has(c));
  check("★ 每个分支都登记了", missing.length === 0, missing.join(","));
}

const env = makeEnv();
const O = await newAccount(env, "老王");

console.log("\n★ 各走各的，不被当成推送 key");
{
  const docs = await call(env, "GET", "/docs");
  check("/docs → 文档页", docs.status === 200 && docs.text.includes("<html") && docs.text.includes('id="mcp"'), docs.status);
  const section = await call(env, "GET", "/docs/mcp");
  check("/docs/mcp → 301 到 /docs#mcp", section.status === 301 && section.headers.get("location")?.endsWith("/docs#mcp"), section.headers.get("location"));
  check("/robots.txt、/sitemap.xml", (await call(env, "GET", "/robots.txt")).text.includes("Sitemap:") && (await call(env, "GET", "/sitemap.xml")).text.includes("<urlset"));

  const made = (await O.as("POST", `/account/${O.id}/channels/${O.channelId}/tokens`, { name: "网页" })).json?.data;
  const page = await call(env, "GET", `/s/${made.value}`);
  check("★ /s/{令牌} → 令牌网页，不是推送", page.status === 200 && page.text.includes("<html") && page.text.includes("网页"), page.status);

  const mcp = await call(env, "GET", `/mcp/${O.key}`);
  check("★ GET /mcp/{key} → 405（MCP 入口），不是路径式推送", mcp.status === 405 && mcp.text.includes("MCP"), `${mcp.status} ${mcp.text}`);
  const mirror = await call(env, "GET", `/cgi-bin/webhook/send?key=${O.key}`);
  check("★ GET 兼容地址 → 405（按 msgtype 风格回话）", mirror.status === 405 && mirror.json?.errcode === 405, mirror.text);
  const unknownMirror = await call(env, "POST", "/api/nope");
  check("认不出的兼容地址 → 404，不当成 key 去推", unknownMirror.status === 404, unknownMirror.text);

  const receipt = await capture(() => call(env, "GET", `/${O.key}/receipt/job-1`));
  check("★ GET /{key}/receipt/{id} → 回执，不推", receipt.result.status === 200 && "acked_by" in (receipt.result.json?.data ?? {}) && receipt.sent.length === 0, receipt.result.text);
  const titled = await capture(() => call(env, "POST", `/${O.key}/receipt/${encodeURIComponent("正文")}`));
  check("POST /{key}/receipt/{正文} 照旧是推送（receipt 当标题）", titled.result.status === 200 && titled.sent[0]?.payload.aps.alert.title === "receipt", titled.result.text);

  for (const head of ["mcp", "docs", "s", "api", "services", "robot", "open-apis", "cgi-bin", "sitemap.xml"]) {
    const { result: r, sent } = await capture(() => call(env, "POST", `/${head}`, { body: { body: "x" } }));
    const asKey = typeof r.json?.message === "string" && r.json.message.includes("key 不存在");
    check(`POST /${head} 不被当成 key「${head}」去推`, sent.length === 0 && !asKey && r.json?.data?.delivered === undefined, `${r.status} ${r.text.slice(0, 120)}`);
  }
}

finish();
