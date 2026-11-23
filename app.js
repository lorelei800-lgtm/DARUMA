/*
 * DARUMA PWA — 要約を読み、スマホからも要約する。
 *
 * データの流れは2本ある:
 *   1. 読む: 拡張機能（PC） → Drive デスクトップ版の同期フォルダ → Drive クラウド
 *        → この PWA が Drive API で daruma-archive.json を読む → 端末にキャッシュ
 *   2. 作る: YouTube アプリの共有 → この PWA → Gemini に動画URLを直接渡す
 *        → 結果は端末内（IndexedDB）に置く
 *
 * サーバーは持たない。このページは静的ファイルで、Drive も Gemini も
 * ブラウザから直接叩く（どこかのサーバーを経由しない）。
 *
 * 2 で作った分は端末内に留まり、Drive へは書き戻していない。
 * 同じファイルを PC と両方から書くと衝突するため、その設計は別途行う。
 */

import { parseVideoId, streamSummary, fetchOEmbed, firstBullet, VIDEO_FPS } from './summarize.js';

// PC の拡張機能（v0.13〜）は、要約を「要約した月」ごとのファイルに分けて書く。
//   daruma-index.json    目次（全件数と、月ごとのファイル名・件数）
//   daruma-YYYY-MM.json  その月の要約
// 1件増えても変わるのはその月のファイルだけなので、こちらも変わった月だけ落とせばよい。
// 目次が無いとき（PC が v0.12 まで）は、全件入りの daruma-archive.json を読む。
const INDEX_FILE = 'daruma-index.json';
const MONTH_FILE = /^daruma-\d{4}-\d{2}\.json$/;
const DATA_FILE = 'daruma-archive.json';
const NOTES_FILE = 'daruma-notes.json';
// スマホで作った要約はこの別ファイルに書く。PC が書く daruma-archive.json を
// 両側から書くと衝突するので、書き手を1つに保ったまま合流させる。
const MOBILE_FILE = 'daruma-mobile.json';
// drive.file は「このアプリが作ったファイル」だけを扱える権限。
// Drive 全体への書き込み権限は要らない。
const SCOPE = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
].join(' ');
const DEFAULT_MODEL = 'gemini-3.6-flash';

const $ = (id) => document.getElementById(id);

let items = [];
// Drive から取り込んだ分と、この端末で要約した分は別々に持つ。
// 混ぜて1つにすると、Drive を取り込み直したときに端末側の要約が消える。
let driveItems = [];
let mobileItems = [];
let term = '';
let channel = '';
let generatedAt = 0;
let notesData = [];
let noteTerm = '';
// PC に頼んだ動画（v0.20.0〜）。daruma-mobile.json の requests に載せて Drive に上げる
let mobileRequests = [];
// PC が daruma-index.json に書く、頼みごとの状態（できた・できなかった）
let pcRequestStatus = {};
// この端末で作ったノート。PC が取り込んで daruma-notes.json に載るまでは、こちらで持つ
let mobileNotes = [];
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
  // Gemini のキーはこの端末から出さない。送り先は Gemini API だけ。
  get apiKey() {
    return localStorage.getItem('daruma.apiKey') || '';
  },
  set apiKey(v) {
    localStorage.setItem('daruma.apiKey', v);
  },
  get model() {
    return localStorage.getItem('daruma.model') || DEFAULT_MODEL;
  },
  set model(v) {
    localStorage.setItem('daruma.model', v || DEFAULT_MODEL);
  },
  // 動画を何コマ読むか（summarize.js の VIDEO_FPS）。既定は少なめ（利用料を抑える）
  get videoDetail() {
    const v = localStorage.getItem('daruma.videoDetail');
    return v === 'normal' ? 'normal' : 'low';
  },
  set videoDetail(v) {
    localStorage.setItem('daruma.videoDetail', v === 'normal' ? 'normal' : 'low');
  },
  // 共有・URL から来たとき: ask（毎回選ぶ）・pc（PC に頼む）・phone（スマホで要約）
  get shareMode() {
    const v = localStorage.getItem('daruma.shareMode');
    return ['pc', 'phone'].includes(v) ? v : 'ask';
  },
  set shareMode(v) {
    localStorage.setItem('daruma.shareMode', ['pc', 'phone'].includes(v) ? v : 'ask');
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

// **太字** を切り出し、残りでタイムスタンプを処理する（以前は記号のまま出ていた）。
function appendInline(parent, text, videoId) {
  text.split(/\*\*([^*\n]+?)\*\*/).forEach((part, i) => {
    if (!part) return;
    appendTimestamps(i % 2 ? parent.appendChild(document.createElement('strong')) : parent, part, videoId);
  });
}

function appendTimestamps(parent, text, videoId) {
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

/*
 * 期間で遡る（PC のアーカイブ画面と同じ考え方）。
 * 千件を超えると、1本のリストをスクロールして遡るのは現実的でない。
 * 日付は「要約した日」（createdAt）。updatedAt は質問するたびに進むので使わない。
 */
const summarizedAt = (r) => r.createdAt || r.updatedAt || 0;
const monthKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const monthLabel = (k) => `${k.slice(0, 4)}年${Number(k.slice(5))}月`;
let period = '';

function inPeriod(r) {
  if (!period) return true;
  const at = summarizedAt(r);
  if (period === '7d') return at >= Date.now() - 7 * 864e5;
  if (period === '30d') return at >= Date.now() - 30 * 864e5;
  return monthKey(at) === period;
}

function renderPeriod() {
  const sel = $('period');
  const counts = new Map();
  for (const r of items) {
    const k = monthKey(summarizedAt(r));
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const opt = (v, label) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    return o;
  };
  // 選んでいた月が消えた（データを消した等）ときは「すべて」に戻す
  if (period && period.length === 7 && !counts.has(period)) period = '';
  sel.replaceChildren(
    opt('', 'すべての期間'),
    opt('7d', '直近7日'),
    opt('30d', '直近30日'),
    ...[...counts.keys()].sort().reverse().map((k) => opt(k, `${monthLabel(k)}（${counts.get(k)}）`))
  );
  sel.value = period;
}

$('period').addEventListener('change', (e) => {
  period = e.target.value;
  $('list').scrollTop = 0;
  renderList();
});

// 検索用に整えた文字列は、要約ごとに一度だけ作って覚えておく。
// 1文字打つたびに全要約（計 11MB）を整え直すと、スマホでは入力が引っかかる。
// 質問と回答も対象にする（「あの質問をした動画」を探せるように）。
const hayCache = new WeakMap();
function haystack(r) {
  let h = hayCache.get(r);
  if (h === undefined) {
    const chat = (r.chat || []).map((c) => `${c.q} ${c.a}`).join(' ');
    h = norm(`${r.title} ${r.channel} ${r.quick || ''} ${r.deep || ''} ${chat}`);
    hayCache.set(r, h);
  }
  return h;
}

function filtered() {
  const t = norm(term);
  return items.filter((r) => {
    if (channel && r.channel !== channel) return false;
    if (!inPeriod(r)) return false;
    if (!t) return true;
    return haystack(r).includes(t);
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

// スマホで千件を一度に描くと開くたびに重い。見える分から順に足していく。
const CHUNK = 80;

function renderList() {
  const box = $('list');
  box.replaceChildren();
  box.onscroll = null;
  const rows = filtered();

  if (!items.length) {
    box.appendChild(
      el(
        'div',
        'empty',
        'まだ要約がありません。上に YouTube の URL を貼るか、YouTube アプリの共有から DARUMA を選んでください。PC で作った要約を読むには、設定から Google と連携します。'
      )
    );
    return;
  }
  if (!rows.length) {
    box.appendChild(el('div', 'empty', '該当なし'));
    return;
  }

  const selIdx = selectedId ? rows.findIndex((r) => r.videoId === selectedId) : -1;
  let shown = 0;
  let lastMonth = null;
  const appendUpTo = (n) => {
    const end = Math.min(rows.length, n);
    const frag = document.createDocumentFragment();
    for (; shown < end; shown++) {
      const r = rows[shown];
      const m = monthKey(summarizedAt(r));
      if (m !== lastMonth) {
        lastMonth = m;
        frag.appendChild(el('div', 'month', monthLabel(m)));
      }
      frag.appendChild(buildRow(r));
    }
    box.appendChild(frag);
    if (shown >= rows.length) box.onscroll = null;
  };
  appendUpTo(Math.max(CHUNK, selIdx + 20));
  if (shown < rows.length) {
    box.onscroll = () => {
      if (box.scrollTop + box.clientHeight > box.scrollHeight - 1200) appendUpTo(shown + CHUNK);
    };
  }
}

function buildRow(r) {
    const row = el('div', 'row');
    const img = document.createElement('img');
    img.src = `https://i.ytimg.com/vi/${r.videoId}/mqdefault.jpg`;
    img.alt = '';
    img.loading = 'lazy';

    const body = el('div');
    body.appendChild(el('div', 't', r.title || r.videoId));
    const meta = el('div', 'm');
    const working = r.status === 'streaming' || r.status === 'starting';
    for (const bit of [
      r.channel,
      fmtDur(r.durationSec),
      working ? '要約中…' : fmtDate(summarizedAt(r)),
      r.error ? '失敗' : null,
      r.deep ? '深掘り済' : null,
    ].filter(Boolean)) {
      meta.appendChild(el('span', null, bit));
    }
    body.appendChild(meta);
    if (r.headline) body.appendChild(el('div', 'h', r.headline));

    row.dataset.videoId = r.videoId;
    row.setAttribute('aria-selected', String(selectedId === r.videoId));
    row.append(img, body);
    row.addEventListener('click', () => openDetail(r));
    return row;
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
  const hint = $('splitterHint');
  if (hint) hint.textContent = `${paneW}px`;
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
    const hint = $('splitterHint');
    if (hint) hint.style.opacity = '1';
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
    const hint = $('splitterHint');
    if (hint) hint.style.opacity = '0';
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
    // スマホで要約したときに読んだ量（利用料の目安）
    r.tokensIn ? `${fmtTokens(r.tokensIn)} トークン` : null,
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

  if (r.error) {
    box.appendChild(el('div', 'empty', r.error));
  }

  const text = detailTier === 'deep' ? r.deep || r.quick : r.quick || r.deep;
  const body = renderMarkdown(text, r.videoId);
  box.appendChild(body);

  // PC で交わした質問と回答。要約の下に続けて出す。
  for (const turn of r.chat || []) {
    const q = el('div', 'chat-q');
    q.appendChild(el('span', 'chat-label', 'Q'));
    q.appendChild(el('span', 'chat-qtext', turn.q));
    box.appendChild(q);
    if (turn.a) box.appendChild(renderMarkdown(turn.a, r.videoId));
  }
  // 生成中はここだけ差し替える。全体を作り直すとスクロール位置が飛ぶ。
  streamBodyNode = body;

  if (r.status === 'streaming' || r.status === 'starting') {
    box.appendChild(el('div', 'status', r.status === 'starting' ? '動画を読み込んでいます…' : '要約中…'));
  }
}

// 生成中の本文ノード。renderDetail が張り替えるたびに更新する。
let streamBodyNode = null;

function updateStreamBody(r) {
  if (!streamBodyNode || selectedId !== r.videoId) return;
  const next = renderMarkdown(r.quick, r.videoId);
  streamBodyNode.replaceWith(next);
  streamBodyNode = next;
}

function closeOverlay() {
  $('settingsView').hidden = true;
  $('notesView').hidden = true;
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
    // Google 側が成功も失敗も知らせてこないことがある（確認画面が開けなかった等）。
    // 待ち続けると「取り込んでいます…」のまま戻らなくなるので、時間で切る。
    const timer = setTimeout(
      () => reject(new Error('Google の認証が完了しませんでした。設定から「Google と連携する」を押し直してください。')),
      interactive ? 180_000 : 45_000
    );
    client.callback = (res) => {
      clearTimeout(timer);
      if (res.error) return reject(new Error(res.error_description || res.error));
      accessToken = res.access_token;
      tokenExpiresAt = Date.now() + (Number(res.expires_in) || 3600) * 1000 - 60_000;
      resolve(accessToken);
    };
    client.error_callback = (err) => {
      clearTimeout(timer);
      reject(new Error(err?.message || '認証に失敗しました'));
    };
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

/** Drive から名前で JSON を1つ取得する。見つからなければ null。 */
/** 名前でファイルを1つ探す。見つからなければ null。 */
async function findDriveFile(token, name, fields = 'id,name,modifiedTime') {
  const q = encodeURIComponent(`name = '${name}' and trashed = false`);
  const listUrl =
    `https://www.googleapis.com/drive/v3/files?q=${q}` +
    `&fields=files(${fields})&orderBy=modifiedTime desc&pageSize=3`;
  const list = await (await driveFetch(listUrl, token)).json();
  return list.files && list.files.length ? list.files[0] : null;
}

/*
 * 前回取り込んだときから変わっていなければ、ダウンロードしない。
 *
 * 要約ファイルは 11MB を超えている。アプリに戻るたびに丸ごと落とし直すと、
 * 外出先では通信量を使い、表示も待たされる。先に Drive 上の指紋（md5）だけを見て、
 * 同じなら手元の分をそのまま使う。
 *
 * 戻り値: { missing } / { unchanged } / { data, commit }。
 * commit は端末への保存が済んでから呼ぶ（保存に失敗したのに「取り込み済み」と覚えないため）。
 */
const pulledKey = (name) => `daruma.pulled.${name}`;
async function fetchDriveJsonIfChanged(token, name, { force = false } = {}) {
  const f = await findDriveFile(token, name, 'id,name,modifiedTime,md5Checksum');
  if (!f) return { missing: true };
  const stamp = `${f.id}:${f.md5Checksum || f.modifiedTime}`;
  if (!force && localStorage.getItem(pulledKey(name)) === stamp) return { unchanged: true };
  const data = await (await driveFetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`, token)).json();
  return { data, commit: () => localStorage.setItem(pulledKey(name), stamp) };
}

const driveStamp = (f) => `${f.id}:${f.md5Checksum || f.modifiedTime}`;
const monthCacheKey = (name) => `m:${name}`;
// 端末に覚えた月のファイルが欠けている（保存の途中で閉じた等）。次の取り込みで必ず落とし直す。
let cacheIncomplete = false;

/** フォルダ直下のファイルの指紋を1回でまとめて取る。{ 名前: {id, md5Checksum, ...} } */
async function listDriveFolder(token, folderId) {
  const out = new Map();
  if (!folderId) return out;
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const url =
      `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime desc&pageSize=1000` +
      `&fields=nextPageToken,files(id,name,md5Checksum,modifiedTime)${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const j = await (await driveFetch(url, token)).json();
    // 同じ名前が2つあるときは新しい方（並びが新しい順なので先に来た方）
    for (const f of j.files || []) if (!out.has(f.name)) out.set(f.name, f);
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}

/** 月ごとの中身を1つの一覧にまとめる。同じ動画が2つの月にあれば新しい方。 */
function assembleMonths(meta, parts) {
  const map = new Map();
  for (const p of parts) {
    for (const r of p?.items || []) {
      if (!r?.videoId) continue;
      const cur = map.get(r.videoId);
      if (!cur || (r.updatedAt || 0) > (cur.updatedAt || 0)) map.set(r.videoId, r);
    }
  }
  return { version: 1, generatedAt: meta.generatedAt || 0, count: map.size, items: [...map.values()], requests: meta.requests || {} };
}

/** 端末に覚えている Drive 由来の要約。月ごとに覚えていれば組み立てる。 */
async function loadCachedArchive() {
  const a = await idb.get('archive').catch(() => null);
  if (!a) return null;
  if (!Array.isArray(a.months)) return a; // PC が v0.12 までのときの全件ファイル
  const parts = await Promise.all(a.months.map((f) => idb.get(monthCacheKey(f)).catch(() => null)));
  cacheIncomplete = parts.some((p) => !p);
  return assembleMonths(a, parts);
}

/**
 * Drive の要約を取り込む。変わっていなければ落とさない。
 * 戻り値: { missing } / { unchanged } / { data, save, downloaded }。
 * save は画面に出す前に呼ぶ（端末に覚えてから「取り込み済み」とする）。
 */
async function fetchArchiveFromDrive(token, { force = false } = {}) {
  const idx = await findDriveFile(token, INDEX_FILE, 'id,name,parents,md5Checksum,modifiedTime');
  if (!idx) {
    const arch = await fetchDriveJsonIfChanged(token, DATA_FILE, { force });
    if (!arch.data) return arch;
    return {
      data: arch.data,
      downloaded: 1,
      save: async () => {
        await idb.set('archive', arch.data);
        arch.commit();
      },
    };
  }
  const stamp = driveStamp(idx);
  if (!force && localStorage.getItem(pulledKey(INDEX_FILE)) === stamp) return { unchanged: true };
  const index = await (await driveFetch(`https://www.googleapis.com/drive/v3/files/${idx.id}?alt=media`, token)).json();
  const months = (index.months || []).map((m) => m.file).filter((f) => MONTH_FILE.test(f || ''));
  const listing = await listDriveFolder(token, idx.parents?.[0]);

  const parts = [];
  let downloaded = 0;
  let missing = 0;
  for (const name of months) {
    const f = listing.get(name) || (await findDriveFile(token, name, 'id,name,md5Checksum,modifiedTime'));
    if (!f) {
      // 目次は Drive に届いたが、月のファイルがまだ届いていない（PC からの送信の途中）
      missing++;
      parts.push(await idb.get(monthCacheKey(name)).catch(() => null));
      continue;
    }
    const fstamp = driveStamp(f);
    let data = localStorage.getItem(pulledKey(name)) === fstamp ? await idb.get(monthCacheKey(name)).catch(() => null) : null;
    if (!data) {
      data = await (await driveFetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`, token)).json();
      await idb.set(monthCacheKey(name), data);
      localStorage.setItem(pulledKey(name), fstamp);
      downloaded++;
    }
    parts.push(data);
  }
  // requests: PC が書く「頼みごとの状態」（PC に頼む、v0.20.0〜）
  const meta = { version: 2, generatedAt: index.generatedAt || 0, count: index.count || 0, months, requests: index.requests || {} };
  return {
    data: assembleMonths(meta, parts),
    downloaded,
    save: async () => {
      await idb.set('archive', meta);
      cacheIncomplete = parts.some((p) => !p);
      // 欠けた月があるときは目次を「取り込み済み」にしない。次の取り込みでまた見に行く。
      if (!missing) localStorage.setItem(pulledKey(INDEX_FILE), stamp);
    },
  };
}

/* --------------------------------------------- スマホ→PC の書き戻し */

/**
 * 端末で作った要約を daruma-mobile.json として Drive に上げる。
 *
 * 置き場所は daruma-archive.json と同じフォルダにする。そこは PC の Drive
 * デスクトップ版が同期しているフォルダなので、上げれば PC のローカルにも降りてくる。
 * 拡張機能はそれを読んで取り込む（別のアカウント連携を増やさずに済む）。
 */
/**
 * アップロード系は driveFetch（GET 用）を通さないので、失敗をここで解釈する。
 * 権限不足は「再連携すれば直る」ことが分からないと詰むので、必ずそう伝える。
 */
async function checkUpload(res) {
  if (res.ok) return;
  let msg = '';
  try {
    msg = (await res.json())?.error?.message || '';
  } catch {
    /* JSON でないこともある */
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      '書き込みの権限がありません。設定から「Google と連携する」を押し直して、追加の許可を与えてください。'
    );
  }
  throw new Error(`Drive への書き込みに失敗 (${res.status}) ${msg.slice(0, 160)}`);
}

async function pushMobileToDrive({ force = false } = {}) {
  // 頼みごとを全部取り消したときなどは、空でも書く（PC が古い頼みごとを見続けないように）
  if (!force && !mobileItems.length && !mobileRequests.length && !mobileNotes.length) return null;
  if (!LS.clientId) return null; // Google 連携そのものが未設定。要約は端末に残る。
  const token = await getToken({ interactive: false });

  const payload = JSON.stringify({
    version: 1,
    generatedAt: Date.now(),
    device: 'mobile',
    count: mobileItems.length,
    // 生成途中や失敗したものは送らない。PC 側に半端な要約を混ぜない。
    items: mobileItems.filter((r) => r.status === 'done' && r.quick),
    // PC に頼んだ動画（PC の拡張機能が数分おきに見て要約する）
    requests: mobileRequests.map(({ videoId, title, channel, at }) => ({ videoId, title, channel, at })),
    // この端末で作ったノート（PC が取り込む）
    notes: mobileNotes,
  });

  const existing = await findDriveFile(token, MOBILE_FILE, 'id,name');
  if (existing) {
    // 中身だけ差し替える。作り直すと ID が変わり、PC 側で重複して見える。
    const res = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: payload,
      }
    );
    await checkUpload(res);
    return 'updated';
  }

  // 初回。PC が読んでいるフォルダと同じ場所に作る。
  const archive = (await findDriveFile(token, INDEX_FILE, 'id,parents')) || (await findDriveFile(token, DATA_FILE, 'id,parents'));
  const parents = archive?.parents || [];
  const boundary = 'daruma' + Math.random().toString(36).slice(2);
  const meta = { name: MOBILE_FILE, mimeType: 'application/json', ...(parents.length ? { parents } : {}) };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n` +
    `--${boundary}--`;

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  await checkUpload(res);
  return parents.length ? 'created' : 'created-in-root';
}

async function pullFromDrive({ interactive = false, quiet = false } = {}) {
  const btn = $('refresh');
  btn.classList.add('spin');
  if (!quiet) setStatus($('status'), 'Drive から取り込んでいます…');
  try {
    const token = await getToken({ interactive });

    // 手元に何も無い・欠けているときは、指紋が同じでも必ず見に行く（端末のデータを消した後など）。
    const arch = await fetchArchiveFromDrive(token, { force: !driveItems.length || cacheIncomplete });
    if (arch.missing) {
      throw new Error(`要約ファイル（${INDEX_FILE}）が Drive に見つかりません。PC 側で一度「Drive へ同期」してください。`);
    }
    lastPullAt = Date.now();
    if (!arch.unchanged) {
      await arch.save();
      applyData(arch.data);
    }

    // ノートは無くてもエラーにしない（要約より後から使い始める機能なので）
    try {
      const notes = await fetchDriveJsonIfChanged(token, NOTES_FILE);
      if (notes.data) {
        await idb.set('notes', notes.data);
        notes.commit();
        applyNotes(notes.data);
        // PC が取り込んだ（daruma-notes.json に載った）ノートは、こちらで持たなくてよい
        const before = mobileNotes.length;
        const pcIds = new Set(notesData.map((n) => n.id));
        mobileNotes = mobileNotes.filter((n) => !pcIds.has(n.id));
        if (mobileNotes.length !== before) {
          await idb.set('mobileNotes', mobileNotes).catch(() => {});
          pushMobileToDrive({ force: true }).catch(() => {});
        }
      }
    } catch (_) {
      /* ノート取得の失敗は要約の取り込みを妨げない */
    }

    if (!quiet) {
      setStatus(
        $('status'),
        arch.unchanged
          ? `最新です（${items.length} 件・${fmtDate(generatedAt)} 時点）`
          : `${items.length} 件を取り込みました（${fmtDate(generatedAt)} 時点）`
      );
      setTimeout(() => setStatus($('status'), ''), 4000);
    }
    await settleRequests();
  } catch (e) {
    if (!quiet) setStatus($('status'), e.message, true);
  } finally {
    btn.classList.remove('spin');
  }
}

/**
 * Drive 由来と端末由来をひとつの一覧にまとめ直す。
 * 同じ動画が両方にある場合は新しい方を採る。
 */
function recomputeItems() {
  const map = new Map();
  for (const r of driveItems) map.set(r.videoId, r);
  for (const r of mobileItems) {
    const cur = map.get(r.videoId);
    if (!cur || (r.updatedAt || 0) >= (cur.updatedAt || 0)) map.set(r.videoId, r);
  }
  // 要約した日の新しい順（質問しただけの古い動画が先頭に来ないように）
  items = [...map.values()].sort((a, b) => summarizedAt(b) - summarizedAt(a));
  renderChannels();
  renderPeriod();
  renderList();
}

function applyData(data) {
  driveItems = (data?.items || []).slice();
  generatedAt = data?.generatedAt || 0;
  pcRequestStatus = data?.requests || {};
  recomputeItems();
  setStatus(
    $('dataStatus'),
    driveItems.length
      ? `${driveItems.length} 件 / 取り込み日時 ${fmtDate(generatedAt)}`
      : 'まだ取り込んでいません'
  );
}

/* ------------------------------------------------- スマホ側での要約 */

let summarizing = false;

async function saveMobileItems() {
  await idb.set('mobile', mobileItems).catch(() => {});
}

function upsertMobile(rec) {
  const i = mobileItems.findIndex((x) => x.videoId === rec.videoId);
  if (i >= 0) mobileItems[i] = rec;
  else mobileItems.unshift(rec);
}

/**
 * 動画URL（または動画ID）を受け取って要約する。
 * 字幕は使わず、Gemini に動画そのものを読ませる（summarize.js の説明を参照）。
 */
async function runSummarize(input) {
  const videoId = parseVideoId(input);
  if (!videoId) {
    setStatus($('status'), 'YouTube の動画URLとして読み取れませんでした', true);
    return;
  }
  if (summarizing) {
    setStatus($('status'), '別の要約を実行中です。終わるまでお待ちください', true);
    return;
  }
  if (!LS.apiKey) {
    setStatus($('status'), '設定から Gemini API キーを登録してください', true);
    openSettings();
    return;
  }

  summarizing = true;
  closeOverlay();

  // 先に器を作って画面に出す。待たされている間、何が起きているか見えるようにする。
  const rec = {
    videoId,
    title: '',
    channel: '',
    durationSec: null,
    quick: '',
    deep: '',
    headline: '',
    model: LS.model,
    source: 'video-native',
    updatedAt: Date.now(),
    status: 'starting',
    error: null,
  };
  upsertMobile(rec);
  recomputeItems();
  openDetail(rec);

  // タイトルは要約に必須ではないので、取れなくても止めない。
  fetchOEmbed(videoId).then((meta) => {
    if (!meta) return;
    rec.title = meta.title;
    rec.channel = meta.channel;
    recomputeItems();
    if (selectedId === videoId) renderDetail(rec);
  });

  try {
    for await (const ev of streamSummary({ apiKey: LS.apiKey, model: LS.model, videoId, fps: VIDEO_FPS[LS.videoDetail] })) {
      if (ev.usage) {
        rec.tokensIn = ev.usage.promptTokenCount || rec.tokensIn || 0;
        rec.tokensOut = ev.usage.candidatesTokenCount || rec.tokensOut || 0;
      }
      if (ev.text) {
        if (rec.status !== 'streaming') {
          rec.status = 'streaming';
          renderDetail(rec);
        }
        rec.quick += ev.text;
        updateStreamBody(rec);
      }
      if (ev.warning) setStatus($('status'), ev.warning, true);
    }
    rec.status = 'done';
    rec.headline = firstBullet(rec.quick);
    rec.updatedAt = Date.now();
    if (!rec.quick.trim()) {
      rec.error = '要約が空でした。もう一度お試しください。';
      rec.status = 'error';
    }
  } catch (e) {
    rec.status = 'error';
    rec.error = e.message;
  } finally {
    summarizing = false;
    hayCache.delete(rec); // 本文が入ったので、検索用の文字列を作り直させる
    upsertMobile(rec);
    await saveMobileItems();
    recomputeItems();
    if (selectedId === videoId) renderDetail(rec);
  }

  // 端末に保存できた後で PC へ送る。ここが失敗しても要約は手元に残っているので、
  // 要約そのものを失敗扱いにはしない。
  if (rec.status === 'done') {
    // PC にも頼んでいたら、それは取り消す（スマホで出来たので）
    mobileRequests = mobileRequests.filter((x) => x.videoId !== videoId);
    await saveRequests();
    renderRequests();
    try {
      await pushMobileToDrive({ force: true });
      setStatus($('status'), `PC にも送りました${rec.tokensIn ? `（この要約で読んだ量: ${fmtTokens(rec.tokensIn)} トークン）` : ''}`);
    } catch (e) {
      setStatus($('status'), `PC への送信は失敗しました（要約は端末に保存済み）: ${e.message}`, true);
    }
  }
}

$('summarizeBtn').addEventListener('click', () => {
  const v = $('ytUrl').value.trim();
  if (v) {
    $('ytUrl').value = '';
    handleIncoming(v);
  }
});

const fmtTokens = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n));

/* ------------------------------------------------- PC に頼む（v0.20.0〜） */

/*
 * スマホで共有した動画を、PC の拡張機能に要約してもらう。
 *   スマホ: daruma-mobile.json の requests に書いて Drive に上げる（このファイルの書き手はスマホだけ）
 *   PC:     数分おきにそれを見て、字幕で要約し、いつもの同期で要約ファイルに載せる
 *           できなかった理由は daruma-index.json の requests に書く（こちらの書き手は PC だけ）
 * 要約が一覧に届いたら、頼みごとはここから消す。
 */
const REQ_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
let reqTimer = null;

async function saveRequests() {
  await idb.set('requests', mobileRequests).catch(() => {});
}

const hasSummary = (videoId) =>
  driveItems.some((r) => r.videoId === videoId && (r.quick || r.deep)) ||
  mobileItems.some((r) => r.videoId === videoId && r.status === 'done' && r.quick);

/** 届いた・古くなった頼みごとを片付ける。 */
async function settleRequests() {
  const now = Date.now();
  const before = mobileRequests.length;
  mobileRequests = mobileRequests.filter((r) => now - (r.at || 0) < REQ_MAX_AGE_MS && !hasSummary(r.videoId));
  if (mobileRequests.length !== before) {
    await saveRequests();
    pushMobileToDrive({ force: true }).catch(() => {});
  }
  renderRequests();
}

async function requestOnPc(videoId, meta = null) {
  if (!LS.clientId) {
    setStatus($('status'), 'PC に頼むには、設定から Google と連携してください', true);
    openSettings();
    return;
  }
  const cur = mobileRequests.find((r) => r.videoId === videoId);
  const rec = { videoId, title: meta?.title || cur?.title || '', channel: meta?.channel || cur?.channel || '', at: Date.now() };
  mobileRequests = [rec, ...mobileRequests.filter((r) => r.videoId !== videoId)];
  await saveRequests();
  renderRequests();
  if (!rec.title) {
    fetchOEmbed(videoId).then(async (m) => {
      if (!m) return;
      rec.title = m.title;
      rec.channel = m.channel;
      await saveRequests();
      renderRequests();
    });
  }
  try {
    await pushMobileToDrive({ force: true });
    setStatus($('status'), 'PC に頼みました。PC の Chrome が開いていれば、数分で要約が届きます');
  } catch (e) {
    setStatus($('status'), `PC に頼めませんでした: ${e.message}`, true);
  }
  watchRequests();
}

async function cancelRequest(videoId) {
  mobileRequests = mobileRequests.filter((r) => r.videoId !== videoId);
  await saveRequests();
  renderRequests();
  pushMobileToDrive({ force: true }).catch((e) => setStatus($('status'), e.message, true));
}

/** 頼んでいる間は、1 分おきに Drive を見に行く（画面を見ているときだけ）。 */
function watchRequests() {
  if (reqTimer || !mobileRequests.length) return;
  reqTimer = setInterval(() => {
    if (!mobileRequests.length) {
      clearInterval(reqTimer);
      reqTimer = null;
      return;
    }
    if (document.visibilityState === 'visible' && navigator.onLine && LS.clientId) pullFromDrive({ quiet: true });
    renderRequests(); // 「頼んでから n 分」を進める
  }, 60_000);
}

const agoText = (ms) => {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return 'たった今';
  if (m < 60) return `${m} 分前`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} 時間前` : `${Math.floor(h / 24)} 日前`;
};

function requestState(r) {
  const st = pcRequestStatus[r.videoId];
  // 前に頼んだときの結果は見ない（頼み直したら、新しい結果を待つ）
  if (st && (st.requestedAt || 0) >= (r.at || 0)) {
    if (st.status === 'running') return { text: 'PC で要約しています…' };
    if (st.status === 'done') return { text: 'PC で要約しました。届くのを待っています…' };
    if (st.status === 'error') {
      const why = st.code === 'NO_SUBTITLES' ? 'この動画には字幕がありません' : st.error || st.code || '原因不明';
      return { text: `PC では要約できませんでした（${why}）`, err: true, retry: !st.final };
    }
  }
  const late = Date.now() - (r.at || 0) > 10 * 60000;
  return { text: `PC の受け取り待ち（${agoText(r.at)}に頼みました）${late ? '。PC の Chrome が閉じていると進みません' : ''}` };
}

function renderRequests() {
  const box = $('requests');
  box.replaceChildren();
  box.hidden = !mobileRequests.length;
  if (!mobileRequests.length) return;
  box.appendChild(el('div', 'rq-head', `PC に頼んだ動画（${mobileRequests.length}）`));
  for (const r of mobileRequests) {
    const row = el('div', 'rq');
    const img = document.createElement('img');
    img.src = `https://i.ytimg.com/vi/${r.videoId}/mqdefault.jpg`;
    img.alt = '';
    img.loading = 'lazy';
    const body = el('div', 'rq-body');
    body.appendChild(el('div', 'rq-t', r.title || r.videoId));
    const state = requestState(r);
    body.appendChild(el('div', `rq-s${state.err ? ' err' : ''}`, state.text));
    const acts = el('div', 'rq-acts');
    if (LS.apiKey) {
      const now = el('button', 'btn', 'スマホで要約');
      now.addEventListener('click', () => runSummarize(r.videoId));
      acts.appendChild(now);
    }
    if (state.retry) {
      const again = el('button', 'btn', 'もう一度頼む');
      again.addEventListener('click', () => requestOnPc(r.videoId, r));
      acts.appendChild(again);
    }
    const cancel = el('button', 'btn', '取り消す');
    cancel.addEventListener('click', () => cancelRequest(r.videoId));
    acts.appendChild(cancel);
    body.appendChild(acts);
    row.append(img, body);
    box.appendChild(row);
  }
}

/* ------------------------------------------------- どこで要約するか */

/**
 * 共有シート・URL 欄から来た動画。設定（毎回選ぶ・PC に頼む・スマホで要約）に従う。
 * もう要約がある動画は、要約し直さずにそれを開く。
 */
async function handleIncoming(input) {
  const videoId = parseVideoId(input);
  if (!videoId) {
    setStatus($('status'), 'YouTube の動画URLとして読み取れませんでした', true);
    return;
  }
  const have = items.find((r) => r.videoId === videoId && (r.quick || r.deep) && r.status !== 'error');
  if (have) {
    openDetail(have);
    setStatus($('status'), 'この動画はもう要約があります');
    return;
  }
  const mode = LS.shareMode;
  if (mode === 'pc' && LS.clientId) return requestOnPc(videoId);
  if (mode === 'phone' && LS.apiKey) return runSummarize(videoId);
  openChooser(videoId);
}

let chooserVideo = null;
function openChooser(videoId) {
  chooserVideo = videoId;
  $('chooserThumb').src = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  $('chooserTitle').textContent = '';
  fetchOEmbed(videoId).then((m) => {
    if (m && chooserVideo === videoId) $('chooserTitle').textContent = m.title;
  });
  $('choosePc').disabled = !LS.clientId;
  $('choosePc').querySelector('.cd').textContent = LS.clientId
    ? 'PC が字幕で要約します。安く正確で、PC の Chrome が開いていれば数分で届きます'
    : '使うには、設定で Google と連携してください';
  $('choosePhone').disabled = !LS.apiKey;
  $('choosePhone').querySelector('.cd').textContent = LS.apiKey
    ? 'Gemini が動画を直接読みます。すぐ読めますが、利用料は多めです'
    : '使うには、設定で Gemini API キーを登録してください';
  $('chooserRemember').checked = false;
  $('chooser').hidden = false;
}
const closeChooser = () => {
  $('chooser').hidden = true;
  chooserVideo = null;
};
$('chooserCancel').addEventListener('click', closeChooser);
$('chooser').addEventListener('click', (e) => {
  if (e.target === $('chooser')) closeChooser();
});
for (const [id, mode] of [['choosePc', 'pc'], ['choosePhone', 'phone']]) {
  $(id).addEventListener('click', () => {
    const v = chooserVideo;
    if ($('chooserRemember').checked) LS.shareMode = mode;
    closeChooser();
    if (!v) return;
    if (mode === 'pc') requestOnPc(v, { title: $('chooserTitle').textContent });
    else runSummarize(v);
  });
}
$('ytUrl').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('summarizeBtn').click();
});

/**
 * 共有シートから起動されたときは URL にパラメータが乗ってくる。
 * 読み取ったら履歴から消す。残しておくと、再読み込みのたびに要約が走ってしまう。
 */
function sharedTarget() {
  const p = new URLSearchParams(location.search);
  const raw = [p.get('url'), p.get('text'), p.get('title')].filter(Boolean).join('\n');
  if (!raw) return null;
  history.replaceState(null, '', location.pathname);
  return parseVideoId(raw);
}

/* ------------------------------------------------------------ ノート */

function applyNotes(nd) {
  notesData = (nd?.notes || []).slice();
  if (!$('notesView').hidden) renderNotes();
}

// PC から届いたノートと、この端末で作ってまだ PC に取り込まれていないノート
function allNotes() {
  const pcIds = new Set(notesData.map((n) => n.id));
  return [...mobileNotes.filter((n) => !pcIds.has(n.id)), ...notesData].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function filteredNotes() {
  const q = normNote(noteTerm);
  const list = allNotes();
  if (!q) return list;
  return list.filter((n) => normNote(`${n.text} ${n.memo} ${n.videoTitle} ${n.channel}`).includes(q));
}

const normNote = (s) =>
  String(s || '').normalize('NFKC').toLowerCase().replace(/[\s・･、。,.\-‐−–—_]/g, '');

const mmssN = (sec) => {
  if (sec == null) return '';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
};

function renderNotes() {
  const box = $('noteList');
  box.replaceChildren();
  const rows = filteredNotes();

  if (!notesData.length && !mobileNotes.length) {
    box.appendChild(el('div', 'empty', 'まだノートがありません。要約の文章を選ぶと追加できます（スマホでも PC でも）。'));
    return;
  }
  if (!rows.length) {
    box.appendChild(el('div', 'empty', '該当なし'));
    return;
  }

  const byVideo = new Map();
  for (const n of rows) {
    if (!byVideo.has(n.videoId)) byVideo.set(n.videoId, []);
    byVideo.get(n.videoId).push(n);
  }

  for (const [videoId, group] of byVideo) {
    const head = el('div', 'note-group-head');
    const img = document.createElement('img');
    img.src = group[0].thumb || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
    img.alt = '';
    img.loading = 'lazy';
    const meta = el('div');
    meta.appendChild(el('div', 'ngt', group[0].videoTitle || videoId));
    meta.appendChild(el('div', 'ngm', [group[0].channel, `${group.length} 件`].filter(Boolean).join(' · ')));
    head.append(img, meta);
    box.appendChild(head);

    for (const n of group) {
      const card = el('div', 'note-card');
      card.appendChild(el('div', 'nq', n.text));
      if (n.memo) card.appendChild(el('div', 'nm', n.memo));
      const foot = el('div', 'nf');
      if (n.timestampSec != null) {
        const a = document.createElement('a');
        a.className = 'ts';
        a.textContent = mmssN(n.timestampSec);
        a.href = `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(n.timestampSec)}s`;
        a.target = '_blank';
        a.rel = 'noopener';
        foot.appendChild(a);
      }
      foot.appendChild(el('span', null, fmtDate(n.createdAt)));
      // まだ PC に取り込まれていない、この端末のノート
      if (mobileNotes.some((m) => m.id === n.id)) foot.appendChild(el('span', 'src', 'スマホ・PC へ送信待ち'));
      card.appendChild(foot);
      box.appendChild(card);
    }
  }
}

function openNotes() {
  document.querySelector('.shell').hidden = true;
  $('settingsView').hidden = true;
  $('notesView').hidden = false;
  renderNotes();
  history.pushState({ view: 'notes' }, '');
}

$('openNotes').addEventListener('click', openNotes);
$('closeNotes').addEventListener('click', () => history.back());
$('noteQ').addEventListener('input', (e) => {
  noteTerm = e.target.value;
  renderNotes();
});

/* ------------------------------------------------------------ 設定 */

function openSettings() {
  $('originHint').textContent = location.origin;
  $('clientId').value = LS.clientId;
  $('apiKey').value = LS.apiKey;
  $('mobileModel').value = LS.model;
  $('videoDetail').value = LS.videoDetail;
  $('shareMode').value = LS.shareMode;
  renderDiag();
  // 設定は 2ペインでも全画面で出す
  document.querySelector('.shell').hidden = true;
  $('notesView').hidden = true;
  $('settingsView').hidden = false;
  history.pushState({ view: 'settings' }, '');
}

$('openSettings').addEventListener('click', openSettings);

$('saveClientId').addEventListener('click', () => {
  LS.clientId = $('clientId').value.trim();
  tokenClient = null; // 作り直させる
  setStatus($('authStatus'), '保存しました。「Google と連携する」を押してください。');
});

$('saveApiKey').addEventListener('click', () => {
  LS.apiKey = $('apiKey').value.trim();
  LS.model = $('mobileModel').value.trim();
  setStatus(
    $('apiKeyStatus'),
    LS.apiKey
      ? `保存しました（モデル: ${LS.model}）。YouTube の共有から DARUMA を選べます。`
      : 'キーを空にしました。スマホ側での要約はできません。',
    !LS.apiKey
  );
});

// 動画の読み方・共有したときの動きは、選んだ瞬間に保存する
$('videoDetail').addEventListener('change', () => {
  LS.videoDetail = $('videoDetail').value;
  setStatus($('prefStatus'), '保存しました');
});
$('shareMode').addEventListener('change', () => {
  LS.shareMode = $('shareMode').value;
  setStatus($('prefStatus'), '保存しました');
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
  // 消すのは Drive から取り込んだ分だけ。
  // この端末で作った要約は Drive に無いので、消すと取り返しがつかない。
  const meta = await idb.get('archive').catch(() => null);
  for (const f of meta?.months || []) await idb.set(monthCacheKey(f), null);
  await idb.set('archive', null);
  // 「取り込み済み」の覚えも消す。残すと、次の取り込みで「変わっていない」と判断して
  // 何も落とさず、消したまま戻らなくなる。ノートは消していないので、ノートの覚えは残す。
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('daruma.pulled.') && k !== pulledKey(NOTES_FILE)) localStorage.removeItem(k);
  }
  cacheIncomplete = false;
  driveItems = [];
  generatedAt = 0;
  selectedId = null;
  recomputeItems();
  applyLayout();
  setStatus(
    $('dataStatus'),
    mobileItems.length
      ? `取り込んだ要約を消しました（この端末で作った ${mobileItems.length} 件は残しています）`
      : '取り込んだ要約を消しました'
  );
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
  // 共有シート由来かどうかは、他の処理より先に確かめて URL から消しておく。
  // 消す前に他の非同期処理が走ると、再読み込み扱いで二重に要約しかねない。
  const shared = sharedTarget();

  // まずキャッシュを出す。オフラインでもすぐ読める状態にしてから通信する。
  initSplitter();
  const cached = await loadCachedArchive().catch(() => null);
  if (cached) applyData(cached);
  mobileItems = (await idb.get('mobile').catch(() => null)) || [];
  // 前回の生成中に画面を閉じた分が「要約中」のまま残らないようにする。
  for (const r of mobileItems) {
    if (r.status === 'streaming' || r.status === 'starting') {
      r.status = r.quick ? 'done' : 'error';
      if (!r.quick) r.error = '前回の要約は完了しませんでした。もう一度お試しください。';
    }
  }
  recomputeItems();
  const cachedNotes = await idb.get('notes').catch(() => null);
  if (cachedNotes) applyNotes(cachedNotes);
  mobileRequests = (await idb.get('requests').catch(() => null)) || [];
  mobileNotes = (await idb.get('mobileNotes').catch(() => null)) || [];
  renderRequests();
  watchRequests();
  applyLayout();

  if (shared) {
    handleIncoming(shared);
    return; // 共有から来たときは要約が主目的。Drive の取り込みは後回しでよい。
  }

  if (!LS.clientId) {
    setStatus($('status'), '設定から OAuth クライアント ID を登録してください');
    return;
  }
  if (navigator.onLine) {
    // 同意済みなら画面を出さずに取り込める
    pullFromDrive({ interactive: false });
  }
})();

/* ------------------------------------------------- スマホでノートを作る（v0.20.0〜） */

/*
 * 要約の文字を選ぶと、画面の下に「ノートに追加」の帯を出す（Android の選択メニューと重ならないよう下に固定）。
 * ノートは端末に置き、daruma-mobile.json の notes で PC に送る。PC が取り込んで daruma-notes.json に
 * 載ったら、こちらの分は消す（pullFromDrive を参照）。
 */
let pendingSel = '';
document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  const text = sel ? sel.toString().trim() : '';
  const anchorNode = sel && sel.anchorNode;
  const inSummary = anchorNode && (anchorNode.nodeType === 1 ? anchorNode : anchorNode.parentElement)?.closest?.('#detail .md');
  if (text.length >= 4 && inSummary && selectedId) {
    pendingSel = text;
    $('noteBar').hidden = false;
  } else if (!text) {
    // 帯を押した瞬間に選択が外れる端末があるので、少し待ってから消す
    setTimeout(() => {
      if (!window.getSelection()?.toString().trim()) $('noteBar').hidden = true;
    }, 400);
  }
});

const firstTs = (text) => {
  const m = String(text).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return m[3] ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
};

async function addMobileNote(withMemo) {
  const text = pendingSel;
  if (!text || !selectedId) return;
  const r = items.find((x) => x.videoId === selectedId) || {};
  let memo = '';
  if (withMemo) {
    const v = window.prompt('メモ（空でも可）', '');
    if (v === null) return;
    memo = v.trim();
  }
  const now = Date.now();
  mobileNotes.unshift({
    id: crypto.randomUUID ? crypto.randomUUID() : `m-${now}-${Math.random().toString(36).slice(2)}`,
    videoId: selectedId,
    videoTitle: r.title || '',
    channel: r.channel || '',
    text,
    memo,
    timestampSec: firstTs(text),
    tier: detailTier === 'deep' ? 'deep' : 'quick',
    createdAt: now,
    updatedAt: now,
  });
  await idb.set('mobileNotes', mobileNotes).catch(() => {});
  window.getSelection()?.removeAllRanges();
  pendingSel = '';
  $('noteBar').hidden = true;
  setStatus($('status'), 'ノートに追加しました');
  pushMobileToDrive({ force: true }).catch(() => {
    /* 送れなくても端末には残る。次に送るときに一緒に送る */
  });
}
for (const [id, memo] of [['noteAdd', false], ['noteAddMemo', true]]) {
  // 押した瞬間に選択が外れないよう、既定の動きを止める
  $(id).addEventListener('pointerdown', (e) => e.preventDefault());
  $(id).addEventListener('click', () => addMobileNote(memo));
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
