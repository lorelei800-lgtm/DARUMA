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

    row.dataset.videoId = r.videoId;
    row.setAttribute('aria-selected', String(selectedId === r.videoId));
    row.append(img, body);
    row.addEventListener('click', () => openDetail(r));
    box.appendChild(row);
  }
}

/* ------------------------------------------------------------ 詳細 */

let detailTier = 'quick';
let selectedId = null;
// 「いま詳細を全画面で開いているか」。selectedId とは別に持つ必要がある。
// 1画面のときに戻るで一覧へ帰っても選択は残しておきたいが、
// その状態で折りたたみ直したときに詳細を開き直してはいけないため。
let detailOpen = false;

/*
 * 画面が広いとき（Galaxy Z Fold を開いた状態やタブレット）は
 * 一覧と要約を横に並べる。閉じれば 1 画面に戻る。
 */
// styles.css の 2ペイン用メディアクエリと必ず同じ条件にすること。
// ずれると「CSS は横並びなのに JS が片方を隠す」状態になる。
const WIDE = matchMedia('(min-width: 560px) and (min-height: 560px)');
const isWide = () => WIDE.matches;

function markSelection() {
  for (const row of document.querySelectorAll('#list .row')) {
    row.setAttribute('aria-selected', String(row.dataset.videoId === selectedId));
  }
}

function renderDetailPlaceholder() {
  $('detailTitle').textContent = '';
  $('detail').replaceChildren(el('div', 'detail-placeholder', '左の一覧から選んでください'));
}

function openDetail(r) {
  selectedId = r.videoId;
  detailTier = r.deep ? 'deep' : 'quick';
  renderDetail(r);
  markSelection();
  $('settingsView').hidden = true;
  $('detailView').hidden = false;
  $('detail').scrollTop = 0;

  // 2ペインのときは一覧を残したまま右側だけ差し替える。
  // 戻る操作も要らないので履歴も積まない。
  if (isWide()) return;

  detailOpen = true;
  $('listView').hidden = true;
  pushDetailState();
}

/** 1画面のときだけ、戻るで一覧に帰れるように履歴を積む。 */
function pushDetailState() {
  if (history.state?.view !== 'detail') history.pushState({ view: 'detail' }, '');
}

/**
 * 折りたたみ・展開で画面の組み立て方が変わるので、その都度整える。
 * 特に「詳細を開いたまま折りたたむ」を取りこぼすと、
 * 一覧と詳細が縦に積み重なって表示されてしまう。
 */
function applyLayout() {
  if (isWide()) {
    $('listView').hidden = false;
    $('detailView').hidden = false;
    if (!selectedId) renderDetailPlaceholder();
    return;
  }
  if (detailOpen && selectedId) {
    $('listView').hidden = true;
    $('detailView').hidden = false;
    pushDetailState(); // 折りたたんだ直後でも戻るで一覧へ帰れるように
  } else {
    $('detailView').hidden = true;
    $('listView').hidden = false;
  }
}

/* ------------------------------------------------------ 仕切りの幅 */

/*
 * 2ペインの境目をドラッグして一覧の幅を変えられるようにする。
 * 指で操作する前提なので、当たり判定は CSS 側で見た目の線より広げてある。
 */
const PANE_DEFAULT = 360;
const PANE_MIN = 220;      // 一覧側の下限
const PANE_MIN_RIGHT = 260; // 要約側に最低限残す幅
let paneW = PANE_DEFAULT;

function clampPane(w) {
  const max = Math.max(PANE_MIN, innerWidth - PANE_MIN_RIGHT);
  return Math.round(Math.min(Math.max(w, PANE_MIN), max));
}

function applyPaneWidth(w, persist) {
  paneW = clampPane(w);
  document.querySelector('.shell').style.setProperty('--pane-w', `${paneW}px`);
  if (persist) localStorage.setItem('daruma.paneW', String(paneW));
}

function initSplitter() {
  const stored = Number(localStorage.getItem('daruma.paneW'));
  applyPaneWidth(Number.isFinite(stored) && stored > 0 ? stored : PANE_DEFAULT, false);

  const splitter = $('splitter');
  let dragging = false;
  let startX = 0;
  let startW = 0;

  /*
   * ドラッグ中かどうかは自前のフラグで持ち、移動と終了は window で受ける。
   * setPointerCapture に頼ると、捕捉に失敗したときにドラッグごと死ぬうえ、
   * 指が要素の外へ出た瞬間に追従しなくなる。捕捉は「できたら使う」程度に留める。
   */
  splitter.addEventListener('pointerdown', (e) => {
    if (!isWide()) return;
    dragging = true;
    startX = e.clientX;
    startW = paneW;
    try {
      splitter.setPointerCapture(e.pointerId);
    } catch {
      /* 捕捉できなくても window 監視で動く */
    }
    splitter.classList.add('dragging');
    e.preventDefault();
  });

  addEventListener('pointermove', (e) => {
    if (!dragging) return;
    applyPaneWidth(startW + (e.clientX - startX), false);
  });

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    try {
      splitter.releasePointerCapture(e.pointerId);
    } catch {
      /* 捕捉していなければ何もしなくてよい */
    }
    splitter.classList.remove('dragging');
    applyPaneWidth(paneW, true); // 離したときに憶える
  };
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);

  // ダブルタップで既定値に戻す
  splitter.addEventListener('dblclick', () => applyPaneWidth(PANE_DEFAULT, true));

  // キーボードでも動かせるようにする
  splitter.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 40 : 16;
    if (e.key === 'ArrowLeft') applyPaneWidth(paneW - step, true);
    else if (e.key === 'ArrowRight') applyPaneWidth(paneW + step, true);
    else if (e.key === 'Home') applyPaneWidth(PANE_DEFAULT, true);
    else return;
    e.preventDefault();
  });
}

// 画面の大きさが変わったら、はみ出さないように収め直す
addEventListener('resize', () => applyPaneWidth(paneW, false));

// 画面を開いた/閉じた瞬間に組み直す
WIDE.addEventListener('change', () => {
  // 2ペインから1画面へ移るとき、直前に見ていた項目は開いたままにする
  if (!isWide() && selectedId) detailOpen = true;
  applyLayout();
  renderDiag();
});

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
  $('settingsView').hidden = true;
  document.querySelector('.shell').hidden = false;
  // 一覧へ帰ったので、この後に折りたたんでも詳細を開き直さない。
  // 選択自体は残しておき、開いたときに右側へ出す。
  detailOpen = false;
  applyLayout();
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
    lastPullAt = Date.now();
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
  renderDiag();
  // 設定は 2ペインでも全画面で出す
  document.querySelector('.shell').hidden = true;
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
  selectedId = null;
  renderChannels();
  renderList();
  applyLayout();
  setStatus($('dataStatus'), '取り込んだ要約を消しました');
});

/*
 * アプリ本体の入れ替え。
 *
 * service worker がアプリシェルをキャッシュしているため、更新しても
 * 次に開くまで古い画面が出る。ここで明示的に捨てて読み直せるようにする。
 * （「取り込んだ要約を消す」は要約データだけで、アプリ本体は消えない）
 */
$('updateApp').addEventListener('click', async () => {
  setStatus($('diag'), '更新しています…');
  try {
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    for (const k of await caches.keys()) await caches.delete(k);
  } catch {
    /* 消せなくても読み直しは試みる */
  }
  location.reload();
});

/** 画面サイズと 2ペインの判定結果。効かないときの切り分けに使う。 */
function renderDiag() {
  const node = $('diag');
  if (!node) return;
  setStatus(
    node,
    `画面 ${innerWidth} × ${innerHeight} px ／ 2ペイン: ${isWide() ? '有効' : '無効（560×560 以上で有効）'}`
  );
}
addEventListener('resize', renderDiag);

$('refresh').addEventListener('click', () => pullFromDrive({ interactive: false }));

/*
 * ホーム画面から戻ってきたときに取り込み直す。
 * 起動時にしか取りに行かないと、PWA を閉じずに放置している間に
 * PC 側で増えた要約が反映されない。
 */
let lastPullAt = 0;
const PULL_MIN_INTERVAL_MS = 60_000;

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!navigator.onLine || !LS.clientId) return;
  if (Date.now() - lastPullAt < PULL_MIN_INTERVAL_MS) return;
  pullFromDrive({ interactive: false });
});
$('q').addEventListener('input', (e) => {
  term = e.target.value;
  renderList();
});

/* ------------------------------------------------------------ 起動 */

(async () => {
  // まずキャッシュを出す。オフラインでもすぐ読める状態にしてから通信する。
  initSplitter();
  const cached = await idb.get('archive').catch(() => null);
  if (cached) applyData(cached);
  else renderList();
  applyLayout();

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
