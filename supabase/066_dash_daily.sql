-- 066: daily numbers for the dashboard trend lines (freezer lbs, open spaces, METRC issues, ...).
-- The Distribution dashboard saves today's numbers each time someone opens it (last one of the day wins),
-- so the lines build up from the day this runs. Staff only; nothing here changes inventory. Safe to run twice.

set client_min_messages = warning;

create table if not exists dash_daily (
  day        date not null,
  key        text not null check (key ~ '^[a-z0-9_]{1,40}$'),
  value      numeric not null,
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (day, key)
);
alter table dash_daily enable row level security;   -- no table policies: read and write through the functions below
revoke all on dash_daily from anon, authenticated;

-- today's numbers, {"freezer_lbs": 539707, "open_spaces": 145, ...}. Quietly does nothing for non-staff or View as.
create or replace function dash_record(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare k text; v jsonb; d date := (now() at time zone 'America/Los_Angeles')::date;
begin
  if not is_staff() or impersonating() then return; end if;
  if jsonb_typeof(p) <> 'object' then return; end if;
  for k, v in select * from jsonb_each(p) loop
    continue when k !~ '^[a-z0-9_]{1,40}$' or jsonb_typeof(v) <> 'number';
    insert into dash_daily (day, key, value, updated_at, updated_by)
    values (d, k, (v #>> '{}')::numeric, now(), current_email())
    on conflict (day, key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by;
  end loop;
end $$;

-- the saved numbers for some keys from a date on (ask a year further back to get last year's line)
create or replace function dash_series(p_keys text[], p_from date)
returns table (day date, key text, value numeric)
language sql stable security definer set search_path = public as $$
  select d.day, d.key, d.value from dash_daily d
   where is_staff() and d.key = any(p_keys) and d.day >= greatest(p_from, current_date - 800)
   order by d.day, d.key
$$;

revoke execute on function dash_record(jsonb) from public, anon;
revoke execute on function dash_series(text[], date) from public, anon;
grant execute on function dash_record(jsonb) to authenticated;
grant execute on function dash_series(text[], date) to authenticated;

select 'ok' as dash_daily_066;
