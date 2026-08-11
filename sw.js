/*
 * アプリシェルだけをキャッシュする service worker。
 *
 * 要約データはキャッシュしない（IndexedDB 側で持っている）。
 * Google の認証ライブラリと Drive API は絶対にキャッシュしないこと。
 * 古いトークン処理や応答を握ってしまうと、原因の分かりにくい不具合になる。
 */

// 版番号を上げると、次に開いたときに新しいシェルを取り直す。
// アプリ本体を変えたら必ず上げること。
const CACHE = 'daruma-shell-v7';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // 自分のオリジン以外（Google 認証・Drive API・サムネイル）は素通し。
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) {
        // 裏で更新しておく（次回の起動から新しくなる）
        fetch(e.request)
          .then((res) => res.ok && caches.open(CACHE).then((c) => c.put(e.request, res.clone())))
          .catch(() => {});
        return hit;
      }
      return fetch(e.request).catch(() => caches.match('./index.html'));
    })
  );
});
