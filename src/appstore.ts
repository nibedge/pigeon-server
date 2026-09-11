/**
 * App Store 相关常量，集中一处。
 *
 * 数字 App ID 要等 App 在 App Store Connect 建好、上架审核通过才拿得到。
 * 拿到后把 STORE_ID 填上，落地页的智能横幅和「去 App Store 下载」按钮就自动生效；
 * 在那之前显示「即将上架」。
 */

/** 团队前缀 + Bundle ID —— 通用链接（Universal Links）的 appID，AASA 里用 */
export const APPLE_APP_ID = "R4Q9M7H956.im.nfo.pigeon";

/** App Store 的数字 id（形如 "6812345678"）。上架前留空 */
export const STORE_ID = "";

export function storeURL(): string | null {
  return STORE_ID ? `https://apps.apple.com/app/id${STORE_ID}` : null;
}

/**
 * apple-app-site-association：让通用链接生效。
 * 装了信鸽的手机点开 https://nfo.im/i/... 会直接进 App（连"是否打开"都不弹）；
 * 没装的走落地页。iOS 会拉取 https://nfo.im/.well-known/apple-app-site-association，
 * 必须是 application/json、不能重定向、不能要鉴权。
 */
export function appSiteAssociation(): string {
  return JSON.stringify({
    applinks: {
      details: [{ appIDs: [APPLE_APP_ID], components: [{ "/": "/i/*" }] }],
    },
  });
}
