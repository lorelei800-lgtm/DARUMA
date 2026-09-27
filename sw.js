/*
 * アプリシェルだけをキャッシュする service worker。
 *
 * 要約データはキャッシュしない（IndexedDB 側で持っている）。
 * Google の認証ライブラリと Drive API は絶対にキャッシュしないこと。
 * 古いトークン処理や応答を握ってしまうと、原因の分かりにくい不具合になる。
 */

// 版番号を上げると、次に開いたときに新しいシェルを取り直す。
// アプリ本体を変えたら必ず上げること。
const CACHE = 'daruma-shell-v11';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './summarize.js',
  './styles.css',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
];

// manifest.webmanifest は絶対にキャッシュしないこと。
// ここに入れると、ブラウザがインストール時に読む manifest が古いまま固定され、
// share_target を足しても共有先に出ない、といった「更新したのに反映されない」
// 不具合になる。実際にそれで詰まった。

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

  // manifest はブラウザがインストール判断に使う。常に取りに行かせる。
  // 一度でも古いものを返すと、インストール済みアプリがその内容で固定される。
  if (url.pathname.endsWith('.webmanifest')) return;

  // 共有シートから起動されると "./?text=..." のように付いてくる。
  // クエリまで一致を求めるとキャッシュに当たらず、オフラインで真っ白になる。
  const opts = e.request.mode === 'navigate' ? { ignoreSearch: true } : undefined;

  // 共有のたびに "./?text=<動画URL>" を別エントリとして貯め込まないようにする。
  // 保存し直すのはクエリの無い本来のシェルだけでよい。
  const cacheKey = url.search ? './index.html' : e.request;

  e.respondWith(
    caches.match(e.request, opts).then((hit) => {
      if (hit) {
        // 裏で更新しておく（次回の起動から新しくなる）
        fetch(cacheKey)
          .then((res) => res.ok && caches.open(CACHE).then((c) => c.put(cacheKey, res.clone())))
          .catch(() => {});
        return hit;
      }
      return fetch(e.request).catch(() => caches.match('./index.html'));
    })
  );
});
