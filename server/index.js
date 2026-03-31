const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const Groq = require('groq-sdk');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const GROQ_MODEL = process.env.GROQ_MODEL || 'mixtral-8x7b-32768';

app.use(cors());
app.use(express.json());

// ─── DB接続 ───
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ─── Groq クライアント ───
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// ─── 管理者認証 ───
async function checkAdmin(req, res) {
  const pwd = req.headers['x-admin-password'];
  const result = await pool.query(
    "SELECT value FROM settings WHERE key = 'admin_password'"
  );
  const stored = result.rows[0]?.value;
  if (pwd !== stored) {
    res.status(401).json({ error: '認証エラー' });
    return false;
  }
  return true;
}

// ─── AI返信生成 ───
async function generateAiReply(message, visitorName) {
  try {
    // 学習データを取得（5件以上あれば使う）
    const repliesResult = await pool.query(
      'SELECT original_message, host_reply FROM host_replies ORDER BY created_at DESC LIMIT 10'
    );
    const examples = repliesResult.rows;
    
    let fewShot = '';
    if (examples.length >= 5) {
      fewShot = '\n\n庵の主の返し方の例（参考にしてください）:\n';
      examples.slice(0, 5).forEach(ex => {
        fewShot += `投稿: ${ex.original_message}\n返事: ${ex.host_reply}\n\n`;
      });
    }

    const isLong = Math.random() < 0.3;
    const name = visitorName || '旅人';
    
    const systemPrompt = `あなたはカピバラです。泉のそばにいます。
訪問者の言葉を静かに受け取ってください。
ルール：
- 説教しない
- 解決策を出さない
- ただそこにいる感じで返す
- 日本語、ひらがな多め、やわらかいトーン
- 名前がある場合は「${name}さん」と呼ぶ
- ${isLong ? '3〜4文で返す' : '1〜2文の短い一言で返す'}${fewShot}`;

    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: message
        }
      ]
    });

    return completion.choices[0].message.content;
  } catch (err) {
    console.error('AI返信生成エラー:', err);
    // エラー時はデフォルト返信
    return `${visitorName || '旅人'}さんの声、聞こえたよ。`;
  }
}

// ─── POST /api/posts — 投稿を受け取る ───
app.post('/api/posts', async (req, res) => {
  const { message, browserToken, visitorName } = req.body;
  
  if (!message || !browserToken) {
    return res.status(400).json({ error: 'message と browserToken は必須です' });
  }

  try {
    const aiReply = await generateAiReply(message, visitorName);
    
    const result = await pool.query(
      `INSERT INTO posts
       (message, browser_token, visitor_name, ai_reply, ai_reply_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id`,
      [message, browserToken, visitorName || '旅人', aiReply]
    );

    const postId = result.rows[0].id;

    // Slack通知
    const settingsResult = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('slack_enabled','slack_webhook_url')"
    );
    const settings = {};
    settingsResult.rows.forEach(r => { settings[r.key] = r.value; });

    if (settings.slack_enabled === 'true' && settings.slack_webhook_url) {
      const preview = message.slice(0, 50) + (message.length > 50 ? '…' : '');
      const name = visitorName || '旅人';
      await fetch(settings.slack_webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `🍃 *${name}* から声が届きました\n> ${preview}`
        })
      });
      await pool.query('UPDATE posts SET slack_notified = TRUE WHERE id = $1', [postId]);
    }

    res.json({ id: postId, aiReply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ─── GET /api/posts/:browserToken — 自分の投稿を取得 ───
app.get('/api/posts/:browserToken', async (req, res) => {
  const { browserToken } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM posts WHERE browser_token = $1 ORDER BY created_at DESC',
      [browserToken]
    );
    
    // 未読の人間返信をis_read: trueに更新
    await pool.query(
      'UPDATE posts SET is_read = TRUE WHERE browser_token = $1 AND human_reply IS NOT NULL AND is_read = FALSE',
      [browserToken]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ─── GET /api/admin/posts — 管理画面用全投稿 ───
app.get('/api/admin/posts', async (req, res) => {
  if (!await checkAdmin(req, res)) return;
  try {
    const result = await pool.query(
      'SELECT * FROM posts ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ─── POST /api/admin/posts/:id/reply — 庵の主が返信 ───
app.post('/api/admin/posts/:id/reply', async (req, res) => {
  if (!await checkAdmin(req, res)) return;
  const { id } = req.params;
  const { reply, replyFrom } = req.body;

  if (!reply) return res.status(400).json({ error: 'reply は必須です' });

  try {
    // 元の投稿を取得
    const postResult = await pool.query('SELECT * FROM posts WHERE id = $1', [id]);
    if (!postResult.rows.length) return res.status(404).json({ error: '投稿が見つかりません' });
    
    const post = postResult.rows[0];

    // 返信を保存
    await pool.query(
      'UPDATE posts SET human_reply = $1, human_reply_at = NOW(), reply_from = $2, is_read = FALSE WHERE id = $3',
      [reply, replyFrom || 'host', id]
    );

    // 学習データに保存（庵の主の返信のみ）
    if (replyFrom === 'host') {
      await pool.query(
        'INSERT INTO host_replies (original_message, host_reply) VALUES ($1, $2)',
        [post.message, reply]
      );
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ─── POST /api/admin/settings/slack — Slack設定 ───
app.post('/api/admin/settings/slack', async (req, res) => {
  if (!await checkAdmin(req, res)) return;
  const { enabled, webhookUrl } = req.body;

  try {
    await pool.query(
      "UPDATE settings SET value = $1 WHERE key = 'slack_enabled'",
      [enabled ? 'true' : 'false']
    );
    await pool.query(
      "UPDATE settings SET value = $1 WHERE key = 'slack_webhook_url'",
      [webhookUrl || '']
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

app.listen(PORT, () => {
  console.log(`カピバラの庵サーバー起動中... port ${PORT}`);
});
