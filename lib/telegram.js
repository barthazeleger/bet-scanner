'use strict';

const webpush = require('web-push');
const { supabase, TG_URL, CHAT } = require('./config');

// ── PUSH SUBSCRIPTIONS ────────────────────────────────────────────────────────
let _pushSubsCache = null;

async function loadPushSubs() {
  if (_pushSubsCache) return _pushSubsCache;
  try {
    const { data, error } = await supabase.from('push_subscriptions').select('*');
    if (error) throw new Error(error.message);
    _pushSubsCache = (data || []).map(r => r.subscription);
    return _pushSubsCache;
  } catch { return []; }
}

async function savePushSub(sub) {
  if (!sub?.endpoint) return;
  await supabase.from('push_subscriptions').upsert(
    { endpoint: sub.endpoint, subscription: sub, created_at: new Date().toISOString() },
    { onConflict: 'endpoint' }
  );
  _pushSubsCache = null;
}

async function deletePushSub(endpoint) {
  await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
  _pushSubsCache = null;
}

async function sendPushToAll(payload) {
  const subs = await loadPushSubs();
  const dead = [];
  for (const sub of subs) {
    try { await webpush.sendNotification(sub, JSON.stringify(payload)); }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) dead.push(sub.endpoint); }
  }
  if (dead.length) {
    for (const ep of dead) await deletePushSub(ep);
  }
}

// ── EMAIL (Resend) ─────────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  const RESEND_KEY = process.env.RESEND_KEY;
  if (!RESEND_KEY) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'EdgePickr <noreply@edgepickr.com>',
      to, subject, html
    })
  }).catch(() => {});
}

// ── TELEGRAM ──────────────────────────────────────────────────────────────────
const tgRaw  = async (text) => fetch(TG_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ chat_id: CHAT, text }) }).catch(() => {});

// Stuur naar Telegram EN sla op in Supabase notifications tabel
const tg = async (text, type = 'info', userId = null) => {
  tgRaw(text).catch(() => {});
  const lines = text.split('\n');
  const title = lines[0].replace(/[^\w\s€%·:→←↑↓+\-.,!?()]/g, '').trim().slice(0, 100);
  supabase.from('notifications').insert({
    type, title, body: text, read: false, user_id: userId
  }).then(() => {}).catch(() => {});
};

module.exports = {
  tg, tgRaw, sendEmail, sendPushToAll,
  loadPushSubs, savePushSub, deletePushSub,
};
