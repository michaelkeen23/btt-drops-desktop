// Everything that differs between the two drop-checker apps.
//
// main.js, preload.js, settings.html and the rest are IDENTICAL between btt-drops-desktop and
// fireseats-drops-desktop — this file is the only difference. Keep it that way: when you fix something in
// one app, copy the shared file across verbatim rather than hand-porting the change.

module.exports = {
  id: 'bttdrops',
  appId: 'com.firetickets.bttdrops',
  productName: 'BTT Drops',
  shortName: 'btt/drops',
  uaTag: 'BTTDropsDesktop',
  // window.<bridgeName> exposed to the hosted page by preload.js
  bridgeName: 'bttDropsDesktop',

  baseUrl: 'https://www.firetickets.ai',
  appPath: '/btt/drops',

  // The alert feed and the one-tap actions the notification buttons call.
  feedPath: '/api/btt/drops/popup',
  testPath: '/api/btt/drops/popup',        // POST { test: true } inserts a test row
  actionPath: '/api/btt/drops/action',

  // Pages this window is allowed to sit on. Anything else on our host bounces back to appPath; anything
  // off-host opens in the real browser.
  inAppPaths: [/^\/btt\/drops(\/|$|\?)/, /^\/btt\/settings(\/|$|\?)/, /^\/login/, /^\/signin/, /^\/auth\//, /^\/no-access/],

  accent: '#38bdf8',
  background: '#05070d',

  // Which alert kinds this app should raise a toast for. null = everything the feed returns.
  alertKinds: null,

  // Who the feed answers to, quoted verbatim when the app is signed out.
  audience: 'a BTT user',
}
