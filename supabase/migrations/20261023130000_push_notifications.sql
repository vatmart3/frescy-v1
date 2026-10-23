-- Alertes quotidiennes Frescy (Web Push). Déjà appliqué sur le projet Supabase « frescy ».

-- Abonnements Web Push des téléphones et clés VAPID du serveur.
-- RLS activé sans politique : seule la fonction serveur (clé service) y accède.
create table public.push_subscriptions (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  alert_time text not null default '07:30' check (alert_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  timezone text not null default 'Europe/Paris',
  shop_name text,
  summary text,
  last_sent_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;

create table public.push_config (
  id smallint primary key default 1 check (id = 1),
  public_key text not null,
  private_jwk jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.push_config enable row level security;

revoke all on public.push_subscriptions from anon, authenticated;
revoke all on public.push_config from anon, authenticated;

-- Toutes les 5 minutes, la fonction « push » envoie les alertes dont l'heure est passée (une fois par jour).
create extension if not exists pg_net;
create extension if not exists pg_cron;
select cron.schedule(
  'frescy-alertes-quotidiennes',
  '*/5 * * * *',
  $$ select net.http_post(
       url := 'https://rebtkphcqqiphbocgkvw.supabase.co/functions/v1/push',
       body := '{"action":"send-due"}'::jsonb,
       headers := '{"Content-Type":"application/json"}'::jsonb
     ) $$
);
