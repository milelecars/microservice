-- Founder Circle: extend the existing leads table. Version 2. Safe to run more than once.

-- 0. Relax every "required" rule left over from the original table, except the key.
--    The service now inserts the row on /start, before Kommo has a lead id.
do $$
declare r record;
begin
  for r in
    select column_name
    from information_schema.columns
    where table_schema = 'public' and table_name = 'leads'
      and is_nullable = 'NO'
      and column_default is null
      and column_name not in ('id', 'telegram_user_id')
  loop
    execute format('alter table public.leads alter column %I drop not null', r.column_name);
    raise notice 'relaxed not null on %', r.column_name;
  end loop;
end $$;

-- 1. Columns for the six answers and the timeline.
alter table public.leads
  add column if not exists kommo_contact_id    text,
  add column if not exists name                text,
  add column if not exists phone               text,
  add column if not exists email               text,
  add column if not exists country             text,
  add column if not exists age_bracket         text,
  add column if not exists interest            text,
  add column if not exists started_at          timestamptz,
  add column if not exists link_sent_at        timestamptz,
  add column if not exists joined_at           timestamptz,
  add column if not exists left_at             timestamptz,
  add column if not exists lost_at             timestamptz,
  add column if not exists in_channel          boolean not null default false,
  add column if not exists join_check_failures integer not null default 0,
  add column if not exists created_at          timestamptz not null default now(),
  add column if not exists updated_at          timestamptz not null default now();

-- 2. One row per Telegram user. If this fails with "duplicate key", old test rows share
--    a telegram_user_id: delete the older duplicates, then run the script again.
create unique index if not exists leads_telegram_user_id_key
  on public.leads (telegram_user_id);

create index if not exists leads_source_platform_idx on public.leads (source_platform);
create index if not exists leads_kommo_stage_idx     on public.leads (kommo_stage);
create index if not exists leads_joined_at_idx       on public.leads (joined_at);

-- 3. updated_at maintained by the database, not the service.
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists leads_set_updated_at on public.leads;
create trigger leads_set_updated_at
  before update on public.leads
  for each row execute function public.set_updated_at();

-- 4. Daily numbers by source, Dubai time (Helia's 10:30 line).
create or replace view public.founder_circle_daily as
select
  (started_at at time zone 'Asia/Dubai')::date                    as day,
  coalesce(original_source_platform, source_platform, 'unknown')  as source,
  count(*)                                                        as started,
  count(link_sent_at)                                             as link_sent,
  count(joined_at)                                                as joined,
  count(*) filter (where in_channel)                              as still_in_channel,
  count(left_at)                                                  as left_channel
from public.leads
where started_at is not null
group by 1, 2
order by 1 desc, 2;

-- 5. Member list for export and later segmentation.
create or replace view public.founder_circle_members as
select
  telegram_user_id, telegram_username, name, country, age_bracket, interest,
  phone, email,
  coalesce(original_source_platform, source_platform) as source,
  kommo_stage, current_tag, kommo_lead_id, kommo_contact_id,
  started_at, link_sent_at, joined_at, left_at, in_channel
from public.leads
where joined_at is not null
order by joined_at desc;

-- 6. Row level security stays OFF. The service writes with the project key from Railway.
alter table public.leads disable row level security;

-- 7. Show what is still required, for the record. Expect only id and telegram_user_id.
select column_name, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'leads' and is_nullable = 'NO'
order by column_name;