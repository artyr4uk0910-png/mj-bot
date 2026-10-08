const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!DISCORD_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Не заданы переменные окружения: DISCORD_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
    console.log(`🤖 Бот запущен как ${client.user.tag}`);
    console.log('👀 Слежу за новыми кодами в auth_codes...');
});

async function sendPendingCodes() {
    try {
        const { data, error } = await supabase
            .from('auth_codes')
            .select('*')
            .eq('sent', false)
            .eq('used', false)
            .not('discord_id', 'is', null)
            .gt('expires_at', new Date().toISOString());

        if (error) { console.error('DB error:', error.message); return; }
        if (!data || !data.length) return;

        for (const row of data) {
            try {
                const user = await client.users.fetch(row.discord_id);
                await user.send(
                    `🔐 **Код для входа в Space MJ**\n\n` +
                    `\`${row.code}\`\n\n` +
                    `⏱️ Код действителен 5 минут.\n` +
                    `Никому не сообщайте его.`
                );
                await supabase.from('auth_codes').update({ sent: true }).eq('id', row.id);
                console.log(`✅ Отправлен код ${row.code} → ${user.tag} (${row.discord_id})`);
            } catch (err) {
                console.error(`❌ Не смог отправить ${row.discord_id}: ${err.message}`);
                if (err.code === 50007 || (err.message && err.message.includes('50007'))) {
                    await supabase.from('auth_codes').update({ sent: true }).eq('id', row.id);
                    console.log(`   └ Помечен как sent — ЛС закрыты у ${row.discord_id}`);
                }
            }
        }
    } catch (e) {
        console.error('Loop error:', e.message);
    }
}

async function cleanupOldCodes() {
    try {
        const nowIso = new Date().toISOString();
        const r1 = await supabase.from('auth_codes').delete().eq('used', true).select();
        if (r1.data && r1.data.length) console.log(`🧹 Удалено использованных: ${r1.data.length}`);
        const r2 = await supabase.from('auth_codes').delete().lt('expires_at', nowIso).select();
        if (r2.data && r2.data.length) console.log(`🧹 Удалено просроченных: ${r2.data.length}`);
        const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        const r3 = await supabase.from('auth_codes').delete().lt('created_at', thirtyMinAgo).select();
        if (r3.data && r3.data.length) console.log(`🧹 Удалено зависших: ${r3.data.length}`);
    } catch (e) {
        console.error('cleanup error:', e.message);
    }
}

client.login(DISCORD_TOKEN);
setInterval(sendPendingCodes, 3000);
setInterval(cleanupOldCodes, 60 * 1000);
setTimeout(sendPendingCodes, 2000);
setTimeout(cleanupOldCodes, 5000);

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Space MJ bot is running ✅');
}).listen(PORT, () => console.log('HTTP on port ' + PORT));
