import { docsPage, docsRedirect } from "./docs";
import { docsPageEn } from "./docs.en";
import { escapeHtml } from "./invite";
import { landingPage } from "./landing";
import { landingPageEn } from "./landing.en";
import { privacyPage } from "./privacy";
import { privacyPageEn } from "./privacy.en";
import { html, PAGE_CACHE } from "./respond";
import { PUBLIC_PAGES } from "./seo";
import { supportPage } from "./support";
import { supportPageEn } from "./support.en";
import { termsPage } from "./terms";
import { termsPageEn } from "./terms.en";

export type SiteLanguage = "zh" | "en";
export type PublicPage = typeof PUBLIC_PAGES[number];

function explicitLanguage(url: URL): SiteLanguage | null {
  const value = url.searchParams.get("lang")?.toLowerCase();
  if (value === "en") return "en";
  if (value === "zh" || value === "zh-cn" || value === "zh-hans") return "zh";
  return null;
}

/** A shareable language choice wins over browser preferences. Old headerless clients stay Chinese. */
export function siteLanguage(request: Request, url: URL): SiteLanguage {
  const explicit = explicitLanguage(url);
  if (explicit) return explicit;
  const header = request.headers.get("accept-language");
  if (!header?.trim()) return "zh";
  const preferences = header.slice(0, 2048).split(",").map((part, index) => {
    const [range = "", ...parameters] = part.trim().toLowerCase().split(";");
    const quality = parameters.find((p) => p.trim().startsWith("q="))?.trim().slice(2);
    const q = quality === undefined ? 1 : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(quality) ? Number(quality) : 0;
    return { range: range.trim(), q, index };
  });
  // A specific range (including q=0) overrides a wildcard or broader range for that language.
  const candidates = (["en", "zh"] as const).map((language) => {
    const matches = preferences.map((p) => ({ ...p, specificity:
      p.range === (language === "zh" ? "zh-cn" : "en-us") || (language === "zh" && p.range === "zh-hans") ? 3 :
      p.range === language ? 2 :
      new RegExp(`^${language}(?:-[a-z0-9]+)+$`).test(p.range) ? 1 : p.range === "*" ? 0 : -1,
    })).filter((p) => p.specificity >= 0)
      .sort((a, b) => b.specificity - a.specificity || b.q - a.q || a.index - b.index);
    return { language, q: matches[0]?.q ?? -1, index: matches[0]?.index ?? Infinity };
  });
  candidates.sort((a, b) => b.q - a.q || a.index - b.index);
  if (candidates[0] && candidates[0].q > 0) return candidates[0].language;
  // Unsupported browser languages use English, unless it was explicitly excluded.
  return candidates.find((p) => p.language === "en")?.q === 0 ? "zh" : "en";
}

/** Only public navigation is localized: API, push, tool downloads and external links are untouched. */
export function localizedPageLink(path: string, language: SiteLanguage): string {
  const [pathname, fragment] = path.split("#", 2);
  if (!PUBLIC_PAGES.includes(pathname as PublicPage)) return path;
  return `${pathname}?lang=${language}${fragment === undefined ? "" : `#${fragment}`}`;
}

const NAV_STYLE = `
  .site-nav{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin:0 0 2.2rem;padding-top:1.25rem;font-size:.85rem}
  .site-nav .site-home{display:inline-flex;align-items:center;gap:.55rem;text-decoration:none;color:var(--ink);font-weight:700;letter-spacing:.01em}
  .site-home img{display:block;border-radius:6px}
  .site-language{display:flex;align-items:center;gap:.15rem;padding:.2rem;border:1px solid var(--line);border-radius:999px;background:var(--surface)}
  .site-language a{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:.25rem .7rem;border-radius:999px;text-decoration:none;color:var(--ink-2);white-space:nowrap}
  .site-language a[aria-current="true"]{background:#105A46;color:#fff}
  .site-nav a:focus-visible{outline:2px solid var(--signal);outline-offset:3px}
  @media(prefers-color-scheme:dark){.site-language a[aria-current="true"]{background:#1B755E}}
`;

const RENDERERS = {
  "/": { zh: landingPage, en: landingPageEn },
  "/docs": { zh: docsPage, en: docsPageEn },
  "/support": { zh: supportPage, en: supportPageEn },
  "/privacy": { zh: privacyPage, en: privacyPageEn },
  "/terms": { zh: termsPage, en: termsPageEn },
} satisfies Record<PublicPage, Record<SiteLanguage, (host: string) => string>>;

export function publicPageResponse(request: Request, url: URL, path: PublicPage): Response {
  const language = siteLanguage(request, url);
  const explicit = explicitLanguage(url);
  let body = RENDERERS[path][language](url.host);
  // Preserve an explicit Chinese choice even in an English browser; English links always stay English.
  if (explicit || language === "en") {
    body = body.replace(/href="(\/(?:docs|support|privacy|terms)?(?:#[^"]*)?)"/g, (_match: string, href: string) =>
      `href="${localizedPageLink(href, language)}"`);
  }
  const nav = `<nav class="site-nav" aria-label="${language === "en" ? "Site navigation" : "站点导航"}">
  <a class="site-home" href="${localizedPageLink("/", language)}"><img src="/apple-touch-icon.png" width="24" height="24" alt="">Pigeon</a>
  <div class="site-language" role="group" aria-label="${language === "en" ? "Language" : "语言"}">
    <a href="${localizedPageLink(path, "zh")}" lang="zh-CN" hreflang="zh-Hans"${language === "zh" ? ' aria-current="true"' : ""}>中文</a>
    <a href="${localizedPageLink(path, "en")}" lang="en" hreflang="en"${language === "en" ? ' aria-current="true"' : ""}>English</a>
  </div>
</nav>`;
  body = body.replace("</head>", `<style>${NAV_STYLE}</style>\n</head>`)
    .replace('<div class="wrap">', `<div class="wrap">\n${nav}`);
  // Explicit Chinese pages get stable canonical URLs too. The bare URL remains the negotiated entry.
  if (explicit === "zh") {
    const base = `https://${escapeHtml(url.host)}${path}`;
    body = body.replace(`<link rel="canonical" href="${base}">`, `<link rel="canonical" href="${base}?lang=zh">`)
      .replace(`<meta property="og:url" content="${base}">`, `<meta property="og:url" content="${base}?lang=zh">`);
  }
  // Shared caches may ignore Vary on custom headers. Cache only explicit, language-stable URLs publicly.
  const response = html(body, 200, explicit ? PAGE_CACHE : "private, max-age=0, must-revalidate");
  response.headers.set("content-language", language === "en" ? "en" : "zh-CN");
  response.headers.set("vary", "Accept-Language");
  return request.method === "HEAD" ? new Response(null, response) : response;
}

export function publicDocsRedirect(request: Request, url: URL, section: string): Response | null {
  const target = docsRedirect(section);
  if (!target) return null;
  const explicit = explicitLanguage(url);
  const language = siteLanguage(request, url);
  const path = explicit || language === "en" ? localizedPageLink(target, language) : target;
  const response = new Response(null, { status: 301, headers: { location: `https://${url.host}${path}` } });
  response.headers.set("vary", "Accept-Language");
  response.headers.set("cache-control", explicit ? PAGE_CACHE : "private, max-age=0, must-revalidate");
  return response;
}
