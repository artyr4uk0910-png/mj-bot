require('dotenv').config();

const http = require('http');
const { Client, GatewayIntentBits } = require('discord.js');
const { Pool } = require('pg');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DISCORD_TOKEN || !DATABASE_URL) {
  console.error('❌ Не заданы DISCORD_TOKEN или DATABASE_URL');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => console.log(`🤖 Бот запущен как ${client.user.tag}`));

// ===== HTTP API =====
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const path = new URL(req.url, 'http://x').pathname;

  try {
    if (path === '/api/request-code' && req.method === 'POST') {
      const { nick } = await readBody(req);
      if (!nick) return sendJSON(res, 400, { error: 'Введи ник' });
      const p = await pool.query('SELECT * FROM players WHERE game_nick = $1', [nick.trim()]);
      if (!p.rows.length) return sendJSON(res, 404, { error: 'Ник не найден' });
      const player = p.rows[0];
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expires = new Date(Date.now() + 5 * 60 * 1000);
      await pool.query('INSERT INTO auth_codes (code, discord_id, expires_at) VALUES ($1,$2,$3)', [code, player.discord_id, expires]);
      return sendJSON(res, 200, { ok: true, discordId: player.discord_id });
    }

    if (path === '/api/verify-code' && req.method === 'POST') {
      const { code, discordId, nick } = await readBody(req);
      const r = await pool.query(
        'SELECT * FROM auth_codes WHERE code=$1 AND discord_id=$2 AND used=false AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1',
        [code, discordId]
      );
      if (!r.rows.length) return sendJSON(res, 400, { error: 'Неверный или истёкший код' });
      await pool.query('DELETE FROM auth_codes WHERE id=$1', [r.rows[0].id]);
      let u = await pool.query('SELECT * FROM users WHERE discord_id=$1', [discordId]);
      let user;
      if (!u.rows.length) {
        u = await pool.query('INSERT INTO users (discord_id, display_name, nickname) VALUES ($1,$2,$3) RETURNING *', [discordId, nick, nick]);
        user = u.rows[0];
      } else {
        user = u.rows[0];
        if (nick && user.nickname !== nick) {
          await pool.query('UPDATE users SET nickname=$1, display_name=$1 WHERE id=$2', [nick, user.id]);
          user.nickname = nick; user.display_name = nick;
        }
      }
      return sendJSON(res, 200, { ok: true, user });
    }

    if (path === '/api/logs' && req.method === 'POST') {
      const { userId, logs, periodStart, periodEnd } = await readBody(req);
      if (!userId || !Array.isArray(logs)) return sendJSON(res, 400, { error: 'Неверные данные' });
      for (const l of logs) {
        await pool.query(
          'INSERT INTO online_logs (user_id, player_nick, hours, per_day_hours, active_days, period_start, period_end) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [userId, l.nick, l.hours, l.perDayHours, l.activeDays, periodStart, periodEnd]
        );
      }
      return sendJSON(res, 200, { ok: true, count: logs.length });
    }

    if (path === '/api/action' && req.method === 'POST') {
      const { userId, action, details } = await readBody(req);
      if (!userId || !action) return sendJSON(res, 400, { error: 'Неверные данные' });
      await pool.query('INSERT INTO action_logs (user_id, action, details) VALUES ($1,$2,$3)', [userId, action, JSON.stringify(details || {})]);
      return sendJSON(res, 200, { ok: true });
    }

    if (path === '/api/players' && req.method === 'GET') {
      const r = await pool.query('SELECT * FROM players ORDER BY game_nick');
      return sendJSON(res, 200, { players: r.rows });
    }

    if (path === '/api/players' && req.method === 'POST') {
      const { nick, discordId } = await readBody(req);
      if (!nick || !discordId) return sendJSON(res, 400, { error: 'Заполни ник и Discord ID' });
      if (!/^\d{15,25}$/.test(discordId)) return sendJSON(res, 400, { error: 'Discord ID — это число' });
      try { await pool.query('INSERT INTO players (game_nick, discord_id) VALUES ($1,$2)', [nick, discordId]); }
      catch (e) { if (e.code === '23505') return sendJSON(res, 409, { error: 'Такой ник уже есть' }); throw e; }
      return sendJSON(res, 200, { ok: true });
    }

    if (path.startsWith('/api/players/') && req.method === 'DELETE') {
      const nick = decodeURIComponent(path.replace('/api/players/', ''));
      await pool.query('DELETE FROM players WHERE game_nick=$1', [nick]);
      return sendJSON(res, 200, { ok: true });
    }

    sendJSON(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error('API error:', e);
    sendJSON(res, 500, { error: e.message });
  }
});

function sendJSON(res, s, d) { res.writeHead(s, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(d)); }
function readBody(req) { return new Promise((ok, err) => { let d=''; req.on('data',c=>d+=c); req.on('end',()=>{try{ok(d?JSON.parse(d):{});}catch(e){err(e);}}); req.on('error',err); }); }

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log('HTTP API on port ' + PORT);
  try {
    const localtunnel = require('localtunnel');
    const tunnel = await localtunnel({ port: PORT });
    console.log('');
    console.log('========================================');
    console.log('🌐 API_URL (скопируй в index.html):');
    console.log('   ' + tunnel.url);
    console.log('========================================');
    console.log('');
    tunnel.on('close', () => console.log('Tunnel closed'));
    tunnel.on('error', (e) => console.error('Tunnel error:', e.message));
  } catch (e) {
    console.error('❌ Localtunnel error:', e.message);
  }
});

// ===== Discord: отправка кодов =====
async function sendPendingCodes() {
  try {
    const r = await pool.query('SELECT * FROM auth_codes WHERE sent=false AND used=false AND expires_at>NOW() AND discord_id IS NOT NULL');
    for (const row of r.rows) {
      try {
        const user = await client.users.fetch(row.discord_id);
        await user.send(`🔐 **Код для входа в Space MJ**\n\n\`${row.code}\`\n\n⏱️ Код действителен 5 минут.\nНикому не сообщайте его.`);
        await pool.query('UPDATE auth_codes SET sent=true WHERE id=$1', [row.id]);
        console.log(`✅ Отправлен код ${row.code} → ${user.tag}`);
      } catch (e) {
        console.error(`❌ Не смог отправить ${row.discord_id}: ${e.message}`);
        if (e.code === 50007 || (e.message && e.message.includes('50007'))) {
          await pool.query('UPDATE auth_codes SET sent=true WHERE id=$1', [row.id]);
        }
      }
    }
  } catch (e) { console.error('Loop error:', e.message); }
}

async function cleanupOldCodes() {
  try {
    await pool.query('DELETE FROM auth_codes WHERE used=true');
    await pool.query('DELETE FROM auth_codes WHERE expires_at<NOW()');
    await pool.query("DELETE FROM auth_codes WHERE created_at < NOW() - INTERVAL '30 minutes'");
  } catch (e) { console.error('cleanup error:', e.message); }
}

client.login(DISCORD_TOKEN);
setInterval(sendPendingCodes, 3000);
setInterval(cleanupOldCodes, 60000);
setTimeout(sendPendingCodes, 2000);
setTimeout(cleanupOldCodes, 5000);
