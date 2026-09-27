import { escapeHtml } from "./invite";

/**
 * 公开页面给搜索引擎和链接预览看的东西：robots.txt、sitemap.xml，各页 <head> 里的 canonical 与 og 标签。
 *
 * 公开的只有这几页。其余路径都是接口：/{key} 一打开就是一次推送，/hb/{id} 一打开就是一次报到 ——
 * 守规矩的爬虫一律别碰。预览爬虫、预取已经在入口挡掉了（见 preview.ts），这里是再早一道
 */
export const PUBLIC_PAGES = ["/", "/docs", "/support", "/privacy", "/terms"] as const;

export function robotsTxt(host: string): string {
  return [
    "# 信鸽Push。公开的只有下面这几页；其余路径都是接口（推送、webhook、心跳），抓一次就是推一次、报到一次",
    "User-agent: *",
    "Allow: /$",
    ...PUBLIC_PAGES.filter((p) => p !== "/").map((p) => `Allow: ${p}`),
    "Allow: /favicon.png",
    "Allow: /apple-touch-icon.png",
    "Disallow: /",
    "",
    `Sitemap: https://${host}/sitemap.xml`,
    "",
  ].join("\n");
}

export function sitemapXml(host: string): string {
  const site = escapeHtml(host);
  const urls = PUBLIC_PAGES.map((p) => `  <url><loc>https://${site}${p}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

/**
 * 一页的 canonical、description 和 og 标签。链接被贴进聊天、被搜索到时，显示的是这里写的标题和一句话，
 * 而不是页面第一段。host 取自请求（路由只放行自己的域名），照样转义
 */
export function pageMeta(host: string, path: string, title: string, description: string): string {
  const url = `https://${escapeHtml(host)}${path}`;
  const t = escapeHtml(title);
  const d = escapeHtml(description);
  return [
    `<meta name="description" content="${d}">`,
    `<link rel="canonical" href="${url}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="信鸽Push">`,
    `<meta property="og:locale" content="zh_CN">`,
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="https://${escapeHtml(host)}/apple-touch-icon.png">`,
  ].join("\n");
}

export function textResponse(body: string, type: string): Response {
  return new Response(body, {
    headers: {
      "content-type": `${type}; charset=utf-8`,
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
