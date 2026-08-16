/*
 * スマホ側での要約。
 *
 * PC 版と違い、ここには yt-dlp のローカルヘルパーが無い。字幕を取る経路が
 * ブラウザ内から塞がれているのは PC でも同じだが（docs/phase0-findings.md）、
 * スマホには代わりに動かせるプロセスが無い。
 *
 * そこで、字幕を介さず **YouTube の URL を Gemini に直接渡して動画そのものを
 * 読ませる**（PC 版の video-native フォールバックと同じ方式）。
 *   - 利点: ヘルパーもサーバも要らず、端末とネットだけで完結する
 *   - 欠点: 字幕方式より桁違いにトークンを使い、長尺動画は高価で遅い
 *
 * Gemini API がブラウザから直接叩けること（CORS 許可）は実測で確認済み。
 * したがってバックエンドは不要で、API キーは端末内にだけ置く。
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

/* ------------------------------------------------------------ プロンプト */

// PC 版 (extension/src/lib/prompt.js) のフレーミングを引き継ぐ。
// ただし入力が「文字起こし」ではなく「動画そのもの」なので、その前提だけ差し替える。
export const MOBILE_PROMPT = `
あなたはビジネスパーソン・投資家向けに YouTube 動画を要約するアシスタントです。
読者が「この動画を見る価値があるか」を数秒で判断できるようにすることが目的です。

【入力について】
・入力は動画そのものです。映像と音声の両方から内容を読み取ってください。
・聞き取りが不確かな固有名詞や数値は、断定せず「〜と述べている」程度に留めてください。

【出力の制約】
・前置き・挨拶・「承知しました」等は一切不要。要約内容のみを出力すること。
・文字数の上限は設けません。内容の濃さに応じて必要な分量を使ってください。
・見出しや要点には、それが語られている時刻を [m:ss] 形式で必ず添えること。
・出力は Markdown。

【出力形式】
## 3行サマリ
- （動画の主題と結論を3行で。ここだけ読めば判断できること）

## 章立て
### [m:ss] 章の見出し
- 要点（1〜2行）

（章は動画の構成に応じて3〜7個）

## 注目データ
- [m:ss] 言及された重要な数値・統計・企業名（なければこの節ごと省略）

## 示唆
- ビジネスパーソン・投資家として注目すべき点や取るべき行動を1〜2点（なければ省略）
`.trim();

/* ------------------------------------------------------------ videoId */

/**
 * 共有シートから渡ってくる文字列は形式が一定しない。
 * YouTube アプリは「タイトル\nURL」を text で寄越すことも、url に入れることもある。
 * どの形でも拾えるよう、文字列全体から動画IDらしきものを探す。
 */
export function parseVideoId(input) {
  const s = String(input || '').trim();
  if (!s) return null;

  // 素の動画ID そのもの
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;

  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/, // watch?v=
    /youtu\.be\/([A-Za-z0-9_-]{11})/, // 短縮URL
    /\/shorts\/([A-Za-z0-9_-]{11})/, // Shorts
    /\/live\/([A-Za-z0-9_-]{11})/, // ライブ
    /\/embed\/([A-Za-z0-9_-]{11})/, // 埋め込み
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
}

/* ------------------------------------------------------------ Gemini */

function buildBody(videoId) {
  return {
    contents: [
      {
        role: 'user',
        parts: [
          { fileData: { mimeType: 'video/mp4', fileUri: `https://www.youtube.com/watch?v=${videoId}` } },
          { text: 'この動画を要約してください。' },
        ],
      },
    ],
    systemInstruction: { parts: [{ text: MOBILE_PROMPT }] },
    generationConfig: {
      temperature: 0.3,
      topP: 0.9,
      // 動画をそのまま読ませるとトークンが跳ね上がる。低解像度で抑える。
      mediaResolution: 'MEDIA_RESOLUTION_LOW',
    },
  };
}

/**
 * SSE の 1 行を解釈する。
 * PC 版と同じ作りにしてある（ストリーム末尾の取りこぼしで要約が切れる問題があったため、
 * 呼び出し側で必ず最後に flush すること）。
 */
function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return [];
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return [];

  let json;
  try {
    json = JSON.parse(payload);
  } catch {
    return [{ warning: '応答の一部を解釈できませんでした' }];
  }
  const cand = json.candidates && json.candidates[0];
  if (!cand) return [];

  const out = [];
  const text = (cand.content?.parts || []).map((p) => p.text || '').join('');
  if (text) out.push({ text });
  if (cand.finishReason && cand.finishReason !== 'STOP') {
    out.push({ warning: `生成が ${cand.finishReason} で終了しました` });
  }
  return out;
}

/** 要約テキストを少しずつ返す。体感速度はこれで決まる。 */
export async function* streamSummary({ apiKey, model, videoId, signal }) {
  if (!apiKey) {
    const e = new Error('Gemini API キーが未設定です。設定画面で登録してください。');
    e.code = 'NO_API_KEY';
    throw e;
  }

  const url = `${BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildBody(videoId)),
    signal,
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    const e = new Error(`Gemini ${res.status}: ${body.slice(0, 300)}`);
    if (res.status === 429) {
      e.message = `${model} のクォータ上限です。無料枠では動画をそのまま読む方式は特に消費が大きくなります。時間を置くか、別のモデルを試してください。`;
    } else if (res.status === 400 && /API key not valid/i.test(body)) {
      e.message = 'API キーが正しくありません。設定画面で入れ直してください。';
    } else if (res.status === 404) {
      e.message = `モデル ${model} が見つかりません。設定画面でモデル名を確認してください。`;
    }
    throw e;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // 行の途中は次へ持ち越す
    for (const line of lines) for (const ev of parseLine(line)) yield ev;
  }

  // ストリームが改行で終わらないことがある。ここで流し込まないと要約の末尾が消える。
  buffer += decoder.decode();
  for (const line of buffer.split('\n')) for (const ev of parseLine(line)) yield ev;
}

/* ------------------------------------------------------------ 付随情報 */

/**
 * タイトルとチャンネル名を oEmbed から取る。キー不要で CORS も通る。
 * 取れなくても要約自体は videoId だけで成立するので、失敗は無視してよい。
 */
export async function fetchOEmbed(videoId) {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`
    );
    if (!res.ok) return null;
    const j = await res.json();
    return { title: j.title || '', channel: j.author_name || '' };
  } catch {
    return null;
  }
}

/** 要約 Markdown の冒頭の箇条書きを3行ぶん取り出す（一覧に出す見出し用）。 */
export function firstBullet(md, max = 3) {
  if (!md) return '';
  const bullets = md
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*・]\s+/.test(l))
    .map((l) => l.replace(/^[-*・]\s+/, '').replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]\s*/g, ''))
    .filter(Boolean);
  return bullets.slice(0, max).join('\n').slice(0, 400);
}
