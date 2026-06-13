/**
 * api/diagnose.js  ─  keiei.pathflow.org
 * エンドポイント: /api/generate (POST)
 * Gemini API による経営状態の一次整理テキスト生成
 * モデル優先順: gemini-2.5-flash-lite → gemini-1.5-flash → gemini-1.5-flash-8b → ルールベースフォールバック
 * Path-Flow 展開手順書 v3.5 §5-2 準拠
 */

const MODELS = [
  'gemini-2.5-flash-lite-preview-06-17',
  'gemini-2.5-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
];

const INDUSTRY_JP = {
  manufacturing:       '製造業',
  construction:        '建設・土木',
  wholesale_retail:    '卸売・小売',
  food_hospitality:    '飲食・宿泊',
  care_medical:        '介護・医療',
  logistics:           '物流・運輸',
  it_info:             'IT・情報',
  professional_services: '専門サービス',
  other:               'その他',
};
const SIZE_JP = {
  '1-30':   '1〜30名',
  '31-100': '31〜100名',
  '101-300':'101〜300名',
  '301+':   '301名以上',
};
const SALES_JP = {
  growing:  '伸びている',
  flat:     '横ばい',
  declining:'下がっている',
};
const HR_JP = {
  stable:    '順調',
  struggling:'苦戦している',
  paused:    '停止・未実施',
};
const DX_JP = {
  partial: '部分的に導入',
  siloed:  'ツールはあるが属人化',
  none:    '未着手',
};

/**
 * スコア計算（内部管理用）
 * 展開手順書 §2-4 booking_complete に level プロパティを含める
 */
function calcScore(d) {
  let s = 0;
  if (['flat','declining'].includes(d.sales))      s += 20;
  if (['struggling','paused'].includes(d.hr))      s += 20;
  if (['101-300','301+'].includes(d.size))          s += 15;
  if (['siloed','none'].includes(d.dx))             s += 25;
  if (['care_medical','logistics','food_hospitality','construction','manufacturing'].includes(d.industry)) s += 20;
  return s;
}
function getLevel(score) {
  if (score <= 39) return 'A';
  if (score <= 69) return 'B';
  return 'C';
}
function getLevelLabel(level) {
  return { A:'論点未自覚層', B:'構造化予備層', C:'構造顕在層' }[level] || level;
}

function buildPrompt(d) {
  const ind  = INDUSTRY_JP[d.industry]  || d.industry;
  const size = SIZE_JP[d.size]          || d.size;
  const sal  = SALES_JP[d.sales]        || d.sales;
  const hr   = HR_JP[d.hr]              || d.hr;
  const dx   = DX_JP[d.dx]             || d.dx;

  return `あなたは中小企業のオーナー社長に寄り添う経営アドバイザーです。
以下の経営状況に基づき、「現状の整理コメント」を3セクション構成で生成してください。

【入力情報】
- 業種：${ind}
- 従業員規模：${size}
- 直近の売上傾向：${sal}
- 採用・人材定着：${hr}
- IT・DXの現状：${dx}

【出力形式（厳守）】
以下の形式で3つのセクションを出力してください。

【1. 現状の整理】
（ここに150〜200字程度のテキスト）

【2. この状態が続いた場合に見えやすい変化】
（ここに150〜200字程度のテキスト）

【3. 整理しておくと、見え方が変わること】
（ここに150〜200字程度のテキスト）

【制約事項】
- 診断・評価・スコアリングを行わない。あくまで「整理」に徹すること
- 「〜すべきです」「〜を導入してください」等の指示・推奨表現を使用しない
- 経営者が「そうか、こういう状態なのか」と腑に落ちる言葉で書く
- ビジネス書的な一般論ではなく、この会社の具体的な状況に即した言葉を使う
- 解決策・提案・営業的表現は一切含めない
- 「先生」や「コンサルタント」的な上から目線を使わない
- 平易な文語体（です・ます調）で記述する
- JSON・マークダウン記法・箇条書き記号は使用しない
- 各セクションは連続した文章（散文）で書く`;
}

/**
 * ルールベースフォールバック（全Geminiモデル失敗時）
 */
function fallback(d) {
  const sal  = SALES_JP[d.sales]  || d.sales;
  const hr   = HR_JP[d.hr]        || d.hr;
  const dx   = DX_JP[d.dx]       || d.dx;
  const ind  = INDUSTRY_JP[d.industry] || d.industry;
  const size = SIZE_JP[d.size]    || d.size;

  return `【1. 現状の整理】
${ind}・${size}の企業として、売上は「${sal}」、採用・定着は「${hr}」、IT活用は「${dx}」という状態にあります。それぞれの要素は独立しているように見えて、多くの場合、内部で連動しています。まずこの全体像を俯瞰することが、次の一手を考える出発点になります。

【2. この状態が続いた場合に見えやすい変化】
現状の構造が続く場合、特定の課題が徐々に表面化してくることがあります。売上・人材・仕組みの三つが噛み合っていないと、個別の対処を繰り返すだけになりやすく、根本の構造は変わらないままになります。「なんとなく変だな」という感覚が続く場合、その感覚には根拠があることが多いです。

【3. 整理しておくと、見え方が変わること】
今の状態を「なぜそうなっているか」という視点から言語化しておくと、問題の優先順位が見えやすくなります。急いで動くよりも、まず構造を整理することで、次の判断が自然に絞られてきます。一人で抱えているうちは全体像が見えにくいことも多く、話すことで整理が進む場合もあります。`;
}

async function callGemini(model, prompt, apiKey) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.75,
        maxOutputTokens: 1024,
      },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${model} HTTP ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { industry, size, sales, hr, dx } = req.body || {};
  if (!industry || !size || !sales || !hr || !dx) {
    return res.status(400).json({ error: '必須パラメータが不足しています' });
  }

  const d = { industry, size, sales, hr, dx };
  const score = calcScore(d);
  const level = getLevel(score);
  const prompt = buildPrompt(d);
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY が設定されていません' });
  }

  let result = '';
  let lastError = null;

  for (const model of MODELS) {
    try {
      result = await callGemini(model, prompt, apiKey);
      if (result.trim()) break;
    } catch (e) {
      lastError = e;
      console.error(`[diagnose] ${model} failed:`, e.message);
    }
  }

  if (!result.trim()) {
    console.warn('[diagnose] All Gemini models failed, using fallback. Last error:', lastError?.message);
    result = fallback(d);
  }

  return res.status(200).json({
    result,
    score,
    level,
    level_label: getLevelLabel(level),
  });
}
