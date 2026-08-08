/*
 * DARUMA PWA — Drive に置かれた要約アーカイブをスマホで読む。
 *
 * データの流れ:
 *   拡張機能（PC） → Drive デスクトップ版の同期フォルダ → Drive クラウド
 *     → この PWA が Drive API で daruma-archive.json を読む → 端末にキャッシュ
 *
 * サーバーは持たない。このページは静的ファイルで、要約データは Drive から
 * 直接ブラウザに入る（どこかのサーバーを経由しない）。
 */

const DATA_FILE = 'daruma-archive.json';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

const $ = (id) => document.getElementById(id);

let items = [];
let term = '';
let channel = '';
let generatedAt = 0;
let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;

/* ------------------------------------------------------------ 保存領域 */

const LS = {
  get clientId() {
    return localStorage.getItem('daruma.clientId') || '';
  },
  set clientId(v) {
    localStorage.setItem('daruma.clientId', v);
  },
};

// 要約データは数MBになりうるので localStorage ではなく IndexedDB に置く。
const idb = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('daruma-pwa', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => resolve((this.db = r.result));
      r.onerror = () => reject(r.error);
    });
  },
  async get(key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const t = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      t.onsuccess = () => resolve(t.result);
      t.onerror = () => reject(t.error);
    });
  },
  async set(key, value) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};

/* ------------------------------------------------------------ 共通 */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const fmtDur = (s) => {
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const x = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(x)}` : `${m}:${p(x)}`;
};

const fmtDate = (ms) => {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// 日本語だと「ドンキ」で「ドン・キホーテ」を探せないと使いにくい。
// 中黒・空白・句読点を落とし、全角半角と大小文字を揃えてから比較する。
const norm = (s) =>
  String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s・･、。,.\-‐−–—_]/g, '');

/**
 * 状態表示。
 * 文中に URL があればリンクにする。対処先の URL を出しても
 * タップできなければ意味がないため。
 */
function setStatus(node, text, isErr = false) {
  node.replaceChildren();
  node.classList.toggle('err', !!isErr);
  if (!text) return;

  const m = String(text).match(/https?:\/\/\S+/);
  if (!m) {
    node.textContent = text;
    return;
  }
  const url = m[0];
  const at = text.indexOf(url);
  node.appendChild(document.createTextNode(text.slice(0, at)));
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = url;
  node.appendChild(a);
  node.appendChild(document.createTextNode(text.slice(at + url.length)));
}

/* ------------------------------------------------------- markdown */

const TS_RE = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;
const tsToSeconds = (ts) => {
  const p = ts.split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
};

function appendInline(parent, text, videoId) {
  let last = 0;
  text.replace(TS_RE, (match, ts, idx) => {
    if (idx > last) parent.appendChild(document.createTextNode(text.slice(last, idx)));
    const a = el('a', 'ts', ts);
    // アプリが入っていれば YouTube アプリが該当時刻から開く
    a.href = `https://www.youtube.com/watch?v=${videoId}&t=${tsToSeconds(ts)}s`;
    a.target = '_blank';
    a.rel = 'noopener';
    parent.appendChild(a);
    last = idx + match.length;
    return match;
  });
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

function renderMarkdown(md, videoId) {
  const root = el('div', 'md');
  let list = null;
  for (const raw of (md || '').split('\n')) {
    const line = raw.trimEnd();
    if (/^\s*[-*・]\s+/.test(line)) {
      if (!list) {
        list = el('ul');
        root.appendChild(list);
      }
      const li = el('li');
      appendInline(li, line.replace(/^\s*[-*・]\s+/, ''), videoId);
      list.appendChild(li);
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const node = el(h[1].length <= 2 ? 'h2' : 'h3');
      appendInline(node, h[2], videoId);
      root.appendChild(node);
      continue;
    }
    const p = el('p');
    appendInline(p, line, videoId);
    root.appendChild(p);
  }
  return root;
}

/* ------------------------------------------------------------ 一覧 */

function filtered() {
  const t = norm(term);
  return items.filter((r) => {
    if (channel && r.channel !== channel) return false;
    if (!t) return true;
    return norm(`${r.title} ${r.channel} ${r.quick} ${r.deep}`).includes(t);
  });
}

function renderChannels() {
  const box = $('chans');
  box.replaceChildren();
  const names = [...new Set(items.map((r) => r.channel).filter(Boolean))].sort();
  const mk = (label, value) => {
    const b = el('button', null, label);
    b.setAttribute('aria-pressed', String(channel === value));
    b.addEventListener('click', () => {
      channel = channel === value ? '' : value;
      renderChannels();
      renderList();
    });
    return b;
  };
  box.appendChild(mk('すべて', ''));
  for (const n of names) box.appendChild(mk(n, n));
}

function renderList() {
  const box = $('list');
  box.replaceChildren();
  const rows = filtered();

  if (!items.length) {
    box.appendChild(
      el('div', 'empty', 'まだデータがありません。設定から Google と連携し、更新してください。')
    );
    return;
  }
  if (!rows.length) {
    box.appendChild(el('div', 'empty', '該当なし'));
    return;
  }

  for (const r of rows) {
    const row = el('div', 'row');
    const img = document.createElement('img');
    img.src = `https://i.ytimg.com/vi/${r.videoId}/mqdefault.jpg`;
    img.alt = '';
    img.loading = 'lazy';

    const body = el('div');
    body.appendChild(el('div', 't', r.title || r.videoId));
    const meta = el('div', 'm');
    for (const bit of [r.channel, fmtDur(r.durationSec), fmtDate(r.updatedAt), r.deep ? '深掘り済' : null].filter(Boolean)) {
      meta.appendChild(el('span', null, bit));
    }
    body.appendChild(meta);
    if (r.headline) body.appendChild(el('div', 'h', r.headline));

    row.append(img, body);
    row.addEventListener('click', () => openDetail(r));
    box.appendChild(row);
  }
}

/* ------------------------------------------------------------ 詳細 */

let detailTier = 'quick';

function openDetail(r) {
  detailTier = r.deep ? 'deep' : 'quick';
  renderDetail(r);
  $('listView').hidden = true;
  $('settingsView').hidden = true;
  $('detailView').hidden = false;
  $('detail').scrollTop = 0;
  history.pushState({ view: 'detail' }, '');
}

function renderDetail(r) {
  $('detailTitle').textContent = r.channel || 'DARUMA';
  const box = $('detail');
  box.replaceChildren();

  const head = el('div', 'dhead');
  const img = document.createElement('img');
  img.src = `https://i.ytimg.com/vi/${r.videoId}/hqdefault.jpg`;
  img.alt = '';
  head.appendChild(img);
  head.appendChild(el('h1', null, r.title || r.videoId));

  const chips = el('div', 'chips-static');
  for (const bit of [
    r.channel,
    fmtDur(r.durationSec),
    r.source === 'video-native' ? '動画解析' : r.lang ? `字幕 ${r.lang}` : null,
    fmtDate(r.updatedAt),
  ].filter(Boolean)) {
    chips.appendChild(el('span', 'chip', bit));
  }
  head.appendChild(chips);
  box.appendChild(head);

  const bar = el('div', 'dbar');
  const open = el('a', 'btn primary', 'YouTube で開く');
  open.href = `https://www.youtube.com/watch?v=${r.videoId}`;
  open.target = '_blank';
  open.rel = 'noopener';
  bar.appendChild(open);

  if (r.quick && r.deep) {
    for (const [v, label] of [['quick', '要約'], ['deep', '深掘り']]) {
      const b = el('button', 'btn', label);
      b.setAttribute('aria-pressed', String(detailTier === v));
      b.addEventListener('click', () => {
        detailTier = v;
        renderDetail(r);
      });
      bar.appendChild(b);
    }
  }
  box.appendChild(bar);

  const text = detailTier === 'deep' ? r.deep || r.quick : r.quick || r.deep;
  box.appendChild(renderMarkdown(text, r.videoId));
}

function closeOverlay() {
  $('detailView').hidden = true;
  $('settingsView').hidden = true;
  $('listView').hidden = false;
}

$('back').addEventListener('click', () => history.back());
$('closeSettings').addEventListener('click', () => history.back());

// Android の戻るジェスチャで一覧に戻れるようにする
window.addEventListener('popstate', closeOverlay);

/* ------------------------------------------------------------ 認証 */

function ensureTokenClient() {
  if (tokenClient) return tokenClient;
  const clientId = LS.clientId;
  if (!clientId) throw new Error('OAuth クライアント ID が未設定です（設定画面で入力してください）');
  if (!window.google?.accounts?.oauth2) throw new Error('Google のライブラリを読み込めていません（オンラインで開き直してください）');

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPE,
    callback: () => {}, // requestToken 側で差し替える
  });
  return tokenClient;
}

function requestToken({ interactive }) {
  return new Promise((resolve, reject) => {
    const client = ensureTokenClient();
    client.callback = (res) => {
      if (res.error) return reject(new Error(res.error_description || res.error));
      accessToken = res.access_token;
      tokenExpiresAt = Date.now() + (Number(res.expires_in) || 3600) * 1000 - 60_000;
      resolve(accessToken);
    };
    client.error_callback = (err) => reject(new Error(err?.message || '認証に失敗しました'));
    // 一度許可していれば prompt なしで通る。初回だけ同意画面が出る。
    client.requestAccessToken({ prompt: interactive ? 'consent' : '' });
  });
}

async function getToken({ interactive = false } = {}) {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
  return requestToken({ interactive });
}

/* ------------------------------------------------------------ Drive */

async function driveFetch(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.ok) return res;

  // 生のエラー本文をそのまま出すと、肝心の対処先 URL が途中で切れて読めない。
  // よくある原因は個別に判定して、何をすればよいかだけを伝える。
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* JSON でないこともある */
  }
  const msg = body?.error?.message || '';
  const reason = `${body?.error?.status || ''} ${body?.error?.errors?.[0]?.reason || ''}`;

  if (res.status === 403 && /has not been used in project|SERVICE_DISABLED|accessNotConfigured/i.test(`${msg} ${reason}`)) {
    const project = (msg.match(/project (\d+)/) || [])[1];
    const link =
      'https://console.cloud.google.com/apis/library/drive.googleapis.com' +
      (project ? `?project=${project}` : '');
    throw new Error(
      `Google Cloud で Drive API が有効になっていません。次のページで「有効にする」を押し、数分待ってから ⟳ をもう一度押してください: ${link}`
    );
  }
  if (res.status === 401) {
    throw new Error('認証の有効期限が切れました。設定から「Google と連携する」を押し直してください。');
  }
  if (res.status === 403) {
    throw new Error(`Drive へのアクセスが拒否されました (403)。${msg.slice(0, 220)}`);
  }
  throw new Error(`Drive エラー ${res.status}。${msg.slice(0, 220)}`);
}

async function pullFromDrive({ interactive = false } = {}) {
  const btn = $('refresh');
  btn.classList.add('spin');
  setStatus($('status'), 'Drive から取り込んでいます…');
  try {
    const token = await getToken({ interactive });

    const q = encodeURIComponent(`name = '${DATA_FILE}' and trashed = false`);
    const listUrl =
      `https://www.googleapis.com/drive/v3/files?q=${q}` +
      `&fields=files(id,name,modifiedTime,size)&orderBy=modifiedTime desc&pageSize=5`;
    const list = await (await driveFetch(listUrl, token)).json();

    if (!list.files || !list.files.length) {
      throw new Error(`${DATA_FILE} が Drive に見つかりません。PC 側で一度「Drive へ同期」してください。`);
    }

    const file = list.files[0];
    const data = await (
      await driveFetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, token)
    ).json();

    await idb.set('archive', data);
    applyData(data);
    setStatus($('status'), `${items.length} 件を取り込みました（${fmtDate(generatedAt)} 時点）`);
    setTimeout(() => setStatus($('status'), ''), 4000);
  } catch (e) {
    setStatus($('status'), e.message, true);
  } finally {
    btn.classList.remove('spin');
  }
}

function applyData(data) {
  items = (data?.items || []).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  generatedAt = data?.generatedAt || 0;
  renderChannels();
  renderList();
  setStatus(
    $('dataStatus'),
    items.length ? `${items.length} 件 / 取り込み日時 ${fmtDate(generatedAt)}` : 'まだ取り込んでいません'
  );
}

/* ------------------------------------------------------------ 設定 */

function openSettings() {
  $('originHint').textContent = location.origin;
  $('clientId').value = LS.clientId;
  $('listView').hidden = true;
  $('detailView').hidden = true;
  $('settingsView').hidden = false;
  history.pushState({ view: 'settings' }, '');
}

$('openSettings').addEventListener('click', openSettings);

$('saveClientId').addEventListener('click', () => {
  LS.clientId = $('clientId').value.trim();
  tokenClient = null; // 作り直させる
  setStatus($('authStatus'), '保存しました。「Google と連携する」を押してください。');
});

$('signIn').addEventListener('click', async () => {
  try {
    LS.clientId = $('clientId').value.trim();
    tokenClient = null;
    await getToken({ interactive: true });
    setStatus($('authStatus'), '連携しました');
    await pullFromDrive();
  } catch (e) {
    setStatus($('authStatus'), e.message, true);
  }
});

$('signOut').addEventListener('click', () => {
  if (accessToken && window.google?.accounts?.oauth2) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  tokenExpiresAt = 0;
  setStatus($('authStatus'), '連携を解除しました');
});

$('clearCache').addEventListener('click', async () => {
  await idb.set('archive', null);
  items = [];
  generatedAt = 0;
  renderChannels();
  renderList();
  setStatus($('dataStatus'), 'キャッシュを消しました');
});

$('refresh').addEventListener('click', () => pullFromDrive({ interactive: false }));
$('q').addEventListener('input', (e) => {
  term = e.target.value;
  renderList();
});

/* ------------------------------------------------------------ 起動 */

(async () => {
  // まずキャッシュを出す。オフラインでもすぐ読める状態にしてから通信する。
  const cached = await idb.get('archive').catch(() => null);
  if (cached) applyData(cached);
  else renderList();

  if (!LS.clientId) {
    setStatus($('status'), '設定から OAuth クライアント ID を登録してください');
    return;
  }
  if (navigator.onLine) {
    // 同意済みなら画面を出さずに取り込める
    pullFromDrive({ interactive: false });
  }
})();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
