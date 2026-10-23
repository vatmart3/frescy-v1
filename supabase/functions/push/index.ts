// Fonction « push » de Frescy : abonnements des téléphones et envoi des alertes quotidiennes.
// Actions : key (GET), subscribe, unsubscribe, test, send-due (appelée toutes les 5 minutes par pg_cron).
// Sans compte utilisateur pour la maquette : envoyer les alertes dues est sans effet si on rappelle la fonction.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { generateVapidKeys, sendPush, type PushSubscription, type VapidKeys } from './webpush.ts';

const SUBJECT = 'mailto:contact@frescy.fr';
// Seuls les vrais services de notification sont acceptés (évite d'envoyer des requêtes ailleurs)
const PUSH_HOSTS = [/\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /\.push\.apple\.com$/, /\.notify\.windows\.com$/];

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

// Clés VAPID créées au premier appel et gardées en base : aucun secret à manipuler à la main
let cachedKeys: VapidKeys | null = null;
async function vapidKeys(): Promise<VapidKeys> {
  if (cachedKeys) return cachedKeys;
  const { data } = await db.from('push_config').select('public_key, private_jwk').eq('id', 1).maybeSingle();
  if (data) return (cachedKeys = { publicKey: data.public_key, privateJwk: data.private_jwk });
  const keys = await generateVapidKeys();
  await db.from('push_config').upsert({ id: 1, public_key: keys.publicKey, private_jwk: keys.privateJwk }, { onConflict: 'id', ignoreDuplicates: true });
  const { data: saved } = await db.from('push_config').select('public_key, private_jwk').eq('id', 1).single();
  return (cachedKeys = { publicKey: saved!.public_key, privateJwk: saved!.private_jwk });
}

function validTimeZone(tz: unknown): string {
  try { if (typeof tz === 'string') { new Intl.DateTimeFormat('fr-FR', { timeZone: tz }); return tz; } } catch (_) { /* fuseau inconnu */ }
  return 'Europe/Paris';
}
// Date (AAAA-MM-JJ) et heure (HH:MM) actuelles dans le fuseau du commerce
function nowIn(tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}

function parseSubscription(s: any): PushSubscription | null {
  try {
    const url = new URL(s.endpoint);
    if (url.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(url.hostname))) return null;
    if (typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string') return null;
    return { endpoint: url.href, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
  } catch (_) { return null; }
}

const message = (row: any) => ({
  title: 'Frescy',
  body: row.summary || 'Vos produits à date courte vous attendent.',
  url: '/',
});

async function deliver(row: any) {
  const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
  const res = await sendPush(sub, message(row), await vapidKeys(), SUBJECT);
  // 404 / 410 : le téléphone s'est désabonné, on oublie l'abonnement
  if (res.status === 404 || res.status === 410) await db.from('push_subscriptions').delete().eq('endpoint', row.endpoint);
  return res;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);
  const input = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const action = input.action || url.searchParams.get('action');

  try {
    if (action === 'key') return json({ publicKey: (await vapidKeys()).publicKey });

    if (action === 'subscribe') {
      const sub = parseSubscription(input.subscription);
      if (!sub) return json({ error: 'Abonnement invalide' }, 400);
      const timezone = validTimeZone(input.timezone);
      const alertTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(input.alertTime) ? input.alertTime : '07:30';
      const now = nowIn(timezone);
      const { error } = await db.from('push_subscriptions').upsert({
        endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth,
        alert_time: alertTime, timezone,
        shop_name: String(input.shopName || '').slice(0, 80) || null,
        summary: String(input.summary || '').slice(0, 180) || null,
        // Heure déjà passée aujourd'hui : première alerte demain
        last_sent_on: now.hm >= alertTime ? now.date : null,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      return json({ ok: true, alertTime, timezone });
    }

    if (action === 'unsubscribe') {
      if (typeof input.endpoint === 'string') await db.from('push_subscriptions').delete().eq('endpoint', input.endpoint);
      return json({ ok: true });
    }

    if (action === 'test') {
      const { data: row } = await db.from('push_subscriptions').select('*').eq('endpoint', String(input.endpoint || '')).maybeSingle();
      if (!row) return json({ error: 'Abonnement introuvable' }, 404);
      const delay = Math.min(Math.max(Number(input.delay) || 0, 0), 20);
      const job = (async () => {
        if (delay) await new Promise((r) => setTimeout(r, delay * 1000));
        return deliver({ ...row, summary: row.summary ? `Test · ${row.summary}` : null });
      })();
      // Avec un délai, on répond tout de suite et l'envoi continue en arrière-plan
      if (delay && typeof (globalThis as any).EdgeRuntime !== 'undefined') {
        (globalThis as any).EdgeRuntime.waitUntil(job);
        return json({ ok: true, scheduledIn: delay });
      }
      const res = await job;
      return json({ ok: res.ok, status: res.status, detail: res.detail }, res.ok ? 200 : 502);
    }

    if (action === 'send-due') {
      const { data: rows, error } = await db.from('push_subscriptions').select('*');
      if (error) throw error;
      let sent = 0, failed = 0;
      for (const row of rows ?? []) {
        const now = nowIn(row.timezone);
        if (now.hm < row.alert_time || row.last_sent_on === now.date) continue;
        // On marque l'envoi avant de l'effectuer : un second appel simultané n'enverra pas de doublon
        const { data: claimed } = await db.from('push_subscriptions').update({ last_sent_on: now.date })
          .eq('endpoint', row.endpoint).or(`last_sent_on.is.null,last_sent_on.neq.${now.date}`).select('endpoint');
        if (!claimed?.length) continue;
        const res = await deliver(row);
        res.ok ? sent++ : failed++;
      }
      return json({ ok: true, checked: rows?.length ?? 0, sent, failed });
    }

    return json({ error: 'Action inconnue' }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: 'Erreur serveur' }, 500);
  }
});
