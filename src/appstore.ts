/**
 * App Store 相关常量，集中一处。
 *
 * 更正一处旧说法：数字 Apple ID **不需要**等上架审核，App Store Connect
 * 记录一建好就有了。真正要等的是「能不能放出下载链接」—— apps.apple.com
 * 在 App 实际发布前返回 404。所以这里把「ID 是多少」和「上架了没有」拆成两个常量。
 */

/** 团队前缀 + Bundle ID —— 通用链接（Universal Links）的 appID，AASA 里用 */
export const APPLE_APP_ID = "R4Q9M7H956.im.nfo.pigeon";

/** App Store Connect 里的数字 Apple ID。2026-09-12 建记录时取得 */
export const APPLE_ID = "6811267139";

/**
 * 是否已上架。上架当天改成 true，落地页的智能横幅和「去 App Store 下载」
 * 按钮随即生效；在那之前保持 false —— 过早放链接只会把人送进 404。
 */
export const RELEASED = false;

/** 下载链接与智能横幅用的 id；未上架时为空字符串，调用方据此显示「即将上架」 */
export const STORE_ID = RELEASED ? APPLE_ID : "";

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
