/**
 * api/diagnose.js  ─  keiei.pathflow.org
 * エンドポイント: /api/generate (POST)
 * index.htmlから日本語値が直接送られてくる前提
 * Geminiモデル優先順: gemini-2.5-flash-lite → gemini-1.5-flash → gemini-1.5-flash-8b → fallback
 * Path-Flow 展開手順書 v3.5 §5-2 準拠
 */

const MODELS = [
  'gemini-2.5-flash-lite-preview-06-17',
  'gemini-2.5-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
];

function calcScore(d) {
  let s = 0;
  if (['横ばい','下がっている'].includes(d.sales))                    s += 20;
  if (['苦戦している','停止・未実施'].includes(d.hr))                 s += 20;
  if (['101〜300名','301名以上'].includes(d.size))                    s += 15;
  if (['ツールはあるが属人化','未着手'].includes(d.dx))               s += 25;
  if (['介護・医療','物流・運輸','飲食・宿泊','建設・土木','製造業'].includes(d.industry)) s += 20;
  return s;
}
function getLevel(score) {
  if (score <= 39) return 'A';
  if (score <= 69) return 'B';
  return 'C';
}

function buildPrompt(d) {
  return `あなたは中小企業のオーナー社長に寄り添う経営アドバイザーです。
以下の経営状況に基づき、「現状の整理コメント」を3セクション構成で生成してください。

【入力情報】
- 業種：${d.industry}
- 従業員規模：${d.size}
- 直近の売上傾向：${d.sales}
- 採用・人材定着：${d.hr}
- IT・DXの現状：${d.dx}

【出力形式（厳守）】
【1. 現状の整理】
（150〜200字の散文）

【2. この状態が続いた場合に見えやすい変化】
（150〜200字の散文）

【3. 整理しておくと、見え方が変わること】
（150〜200字の散文）

【制約】
- 診断・評価・スコアリング・推奨・提案表現を一切使わない
- 「整理」視点の平易な文語体（です・ます調）
- JSON・マークダウン・箇条書き記号を使わない
- 各セクションは連続した散文で書く`;
}

function fallback(d) {
  return `【1. 現状の整理】
${d.industry}・${d.size}の企業として、売上は「${d.sales}」、採用・定着は「${d.hr}」、IT活用は「${d.dx}」という状態にあります。それぞれの要素は独立しているように見えて、多くの場合、内部で連動しています。まずこの全体像を俯瞰することが、次の一手を考える出発点になります。

【2. この状態が続いた場合に見えやすい変化】
現状の構造が続く場合、特定の課題が徐々に表面化してくることがあります。売上・人材・仕組みの三つが噛み合っていないと、個別の対処を繰り返すだけになりやすく、根本の構造は変わらないままになります。「なんとなく変だな」という感覚が続く場合、その感覚には根拠があることが多いです。

【3. 整理しておくと、見え方が変わること】
今の状態を「なぜそうなっているか」という視点から言語化しておくと、問題の優先順位が見えやすくなります。急いで動くよりも、まず構造を整理することで、次の判断が自然に絞られてきます。話すことで整理が進む場合もあります。`;
}

async function callGemini(model, prompt, apiKey) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.75, maxOutputTokens: 1024 },
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

  const d      = { industry, size, sales, hr, dx };
  const score  = calcScore(d);
  const level  = getLevel(score);
  const prompt = buildPrompt(d);
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY が未設定です' });
  }

  let result    = '';
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
    console.warn('[diagnose] All models failed, using fallback:', lastError?.message);
    result = fallback(d);
  }

  return res.status(200).json({ result, score, level });
}
