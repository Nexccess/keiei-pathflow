/**
 * api/save-shigyou.js  ─  keiei.pathflow.org
 * 機能: スプレッドシート書込み(11列) + Googleカレンダー仮予約 + Gmailオーナー通知
 * Path-Flow 展開手順書 v3.5 §5-1・§3-2 準拠
 */

import { google } from 'googleapis';
import nodemailer from 'nodemailer';

/* §5-1: SHEET_NAME・NOTIFY_EMAILはクライアントごとに更新 */
const SHEET_NAME   = 'AI診断結果';
const NOTIFY_EMAIL = 'info.nexccess@gmail.com';

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON が未設定です');
  const sa = JSON.parse(raw);
  return new google.auth.GoogleAuth({
    credentials: sa,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/calendar',
    ],
  });
}

/**
 * スプレッドシートへ1行追加（§3-2 標準11列）
 * A:送信日時 B:LP_ID C:お名前 D:携帯電話 E:メール F:希望日時(第1)
 * G:希望日時(第2) H:おすすめメニュー I:スコア J:レベル K:診断回答
 */
async function appendToSheet({ auth, lp, name, phone, email, date, date2, recommended_menu, score, level, answersStr }) {
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.SHIGYOU_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('SHIGYOU_SPREADSHEET_ID が未設定です');

  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

  const row = [
    now,                          // A 送信日時
    lp || '',                      // B LP_ID
    name || '',                    // C お名前
    phone || '',                   // D 携帯電話
    email || '',                   // E メールアドレス
    date || '',                    // F 希望日時（第1）
    date2 || '',                   // G 希望日時（第2）
    recommended_menu || '',        // H おすすめメニュー
    score != null ? String(score) : '', // I スコア
    level || '',                   // J レベル
    answersStr || '',              // K 診断回答
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

/** Googleカレンダーに仮予約終日イベントを登録 */
async function insertCalendarEvent({ auth, name, date }) {
  const calendar   = google.calendar({ version: 'v3', auth });
  const calendarId = process.env.CALENDAR_ID;
  if (!calendarId) throw new Error('CALENDAR_ID が未設定です');

  /* date: "yyyy-mm-dd HH:MM" → 終日イベント用に日付部分のみ抽出（ハイフン形式必須） */
  const dateStr = date ? date.split(' ')[0] : new Date().toISOString().split('T')[0];

  await calendar.events.insert({
    calendarId,
    requestBody: {
      summary:     `【仮予約】${name} 様`,
      description: `keiei.pathflow.org からの経営相談予約\n希望時間: ${date || ''}`,
      start: { date: dateStr },
      end:   { date: dateStr },
    },
  });
}

/** Gmailでオーナーに通知メールを送信 */
async function sendOwnerMail({ name, phone, email, date, date2, score, level, answersStr }) {
  const user     = process.env.GMAIL_USER;
  const password = process.env.GMAIL_APP_PASSWORD;
  if (!user || !password) {
    console.warn('[save-shigyou] GMAIL_USER/GMAIL_APP_PASSWORD 未設定 — メール送信をスキップ');
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass: password },
  });

  const body = `
【経営相談 仮予約のお知らせ】

keiei.pathflow.org から新規の相談予約が届きました。

━━ 基本情報 ━━
お名前　　：${name}
電　　話　：${phone}
メール　　：${email}

━━ 希望日時 ━━
第1希望　：${date}
第2希望　：${date2 || '（なし）'}

━━ 診断結果 ━━
スコア　　：${score}
レベル　　：${level}
診断回答　：${answersStr}

━━━━━━━━━━━━━━━━━━
合同会社Nexccess — Path-Flow 自動通知
`.trim();

  await transporter.sendMail({
    from:    `"Path-Flow Keiei" <${user}>`,
    to:      NOTIFY_EMAIL,
    subject: `【仮予約】${name} 様 — keiei.pathflow.org`,
    text:    body,
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    lp, name, phone, email,
    date, date2,
    recommended_menu,
    score, level,
    answersStr,
  } = req.body || {};

  if (!name || !phone || !email || !date) {
    return res.status(400).json({ error: '必須パラメータ（name / phone / email / date）が不足しています' });
  }

  let auth;
  try {
    auth = await getAuth();
  } catch (e) {
    console.error('[save-shigyou] auth error:', e.message);
    return res.status(500).json({ error: 'Google認証に失敗しました: ' + e.message });
  }

  const errors = [];

  /* 1. スプレッドシート書込み */
  try {
    await appendToSheet({
      auth, lp, name, phone, email, date, date2,
      recommended_menu: recommended_menu || '（経営相談）',
      score, level,
      answersStr: typeof answersStr === 'string' ? answersStr : '',
    });
  } catch (e) {
    console.error('[save-shigyou] sheets error:', e.message);
    errors.push('sheets: ' + e.message);
  }

  /* 2. カレンダー登録 */
  try {
    await insertCalendarEvent({ auth, name, date });
  } catch (e) {
    console.error('[save-shigyou] calendar error:', e.message);
    errors.push('calendar: ' + e.message);
  }

  /* 3. メール通知 */
  try {
    await sendOwnerMail({ name, phone, email, date, date2, score, level, answersStr });
  } catch (e) {
    console.error('[save-shigyou] mail error:', e.message);
    errors.push('mail: ' + e.message);
  }

  if (errors.length === 3) {
    return res.status(500).json({ error: '全処理に失敗しました', details: errors });
  }

  return res.status(200).json({
    ok: true,
    warnings: errors.length > 0 ? errors : undefined,
  });
}
