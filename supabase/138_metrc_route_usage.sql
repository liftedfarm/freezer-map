-- 138_metrc_route_usage.sql: METRC sending through T3 or the METRC API (Metrc Connect), per kind, plus usage meters.
--   * Per kind: Route (T3 or METRC API, T3 by default) and If it fails (Off / Safe only / Safe + check).
--   * Usage meters for T3 and the METRC API: every call the server makes is counted per day, by source
--     (worker, overnight, nightly pull, app). Monthly limit 50,000 each (editable). Warnings at 70% and 90%.
--     Nothing is paused at any level yet: we're measuring first.
--   * METRC API connection test results (keys go in Vercel: METRC_VENDOR_KEY, METRC_USER_KEY).
-- Re-runnable. Run after 137.

-- =====================================================================================================
-- 1. route and fallback per kind
-- =====================================================================================================
alter table metrc_push_kinds add column if not exists route text not null default 't3';
alter table metrc_push_kinds add column if not exists fallback text not null default 'safe';
alter table metrc_push_kinds add column if not exists api_ready boolean not null default false;   -- the server has a tested METRC API sender for this kind
alter table metrc_push_kinds add column if not exists can_verify boolean not null default false;  -- the sender checks METRC first, so "Safe + check" can retry an unknown outcome
alter table metrc_push_kinds drop constraint if exists metrc_push_kinds_route_check;
alter table metrc_push_kinds add constraint metrc_push_kinds_route_check check (route in ('t3', 'api'));
alter table metrc_push_kinds drop constraint if exists metrc_push_kinds_fallback_check;
alter table metrc_push_kinds add constraint metrc_push_kinds_fallback_check check (fallback in ('off', 'safe', 'check'));

alter table comp_metrc_actions add column if not exists push_route text;   -- which route the last send went through (t3 / api)

create or replace function metrc_set_route(p_kind text, p_route text, p_fallback text) returns void
language plpgsql security definer set search_path = public as $$
declare k metrc_push_kinds;
begin
  if not comp_is_admin() then raise exception 'Only a Compliance Admin can change how the app sends to METRC'; end if;
  select * into k from metrc_push_kinds where kind = p_kind for update;
  if not found then raise exception 'Unknown kind'; end if;
  p_route := coalesce(p_route, k.route); p_fallback := coalesce(p_fallback, k.fallback);
  if p_route not in ('t3', 'api') then raise exception 'Route is T3 or METRC API'; end if;
  if p_fallback not in ('off', 'safe', 'check') then raise exception 'If it fails: Off, Safe only or Safe + check'; end if;
  if p_route = 'api' and not k.api_ready then raise exception '"%" can''t go through the METRC API yet (no tested API sender). It stays on T3.', k.label; end if;
  if p_fallback = 'check' and not k.can_verify then raise exception '"%" can''t use Safe + check yet: its sender doesn''t check METRC first', k.label; end if;
  update metrc_push_kinds set route = p_route, fallback = p_fallback, updated_by = current_email(), updated_at = now() where kind = p_kind;
  perform _comp_event('metrc_route', p_kind, jsonb_build_object('kind', p_kind, 'route', p_route, 'fallback', p_fallback, 'was_route', k.route, 'was_fallback', k.fallback));
end $$;
revoke all on function metrc_set_route(text, text, text) from public, anon;
grant execute on function metrc_set_route(text, text, text) to authenticated;

-- =====================================================================================================
-- 2. METRC API connection test (written by the server)
-- =====================================================================================================
alter table metrc_connection add column if not exists api_ok boolean;
alter table metrc_connection add column if not exists api_tested_at timestamptz;
alter table metrc_connection add column if not exists api_tested_by text;
alter table metrc_connection add column if not exists api_base text;
alter table metrc_connection add column if not exists api_sandbox text;
alter table metrc_connection add column if not exists api_licenses jsonb;   -- [{ license, name, in_api, in_app, site }]
alter table metrc_connection add column if not exists api_error text;

-- =====================================================================================================
-- 3. usage meters
-- =====================================================================================================
create table if not exists metrc_usage (
  service  text not null check (service in ('t3', 'api')),
  day      date not null,                 -- California day
  source   text not null default 'app',   -- worker / overnight / nightly / app
  reads    int not null default 0,
  writes   int not null default 0,
  errors   int not null default 0,        -- calls that came back with an error (still counted in reads/writes)
  last_at  timestamptz not null default now(),
  primary key (service, day, source)
);
alter table metrc_usage enable row level security;
drop policy if exists read_metrc_usage on metrc_usage;
create policy read_metrc_usage on metrc_usage for select to authenticated using (comp_can_read());
grant select on metrc_usage to authenticated;

-- one row per warning level reached per month (so each warning shows once and is logged once)
create table if not exists metrc_usage_warnings (
  service  text not null,
  period   date not null,      -- first day of the month
  level    int not null,       -- 70, 90, 100
  calls    int not null,
  at       timestamptz not null default now(),
  primary key (service, period, level)
);
alter table metrc_usage_warnings enable row level security;
drop policy if exists read_metrc_usage_warn on metrc_usage_warnings;
create policy read_metrc_usage_warn on metrc_usage_warnings for select to authenticated using (comp_can_read());
grant select on metrc_usage_warnings to authenticated;

insert into app_settings (key, value) values
  ('comp.usage_limit_t3', '50000'),
  ('comp.usage_limit_api', '50000'),
  ('comp.usage_warn', '70,90')
on conflict (key) do nothing;

create or replace function _metrc_period(p_day date default null) returns date
language sql stable as $$ select date_trunc('month', coalesce(p_day, (now() at time zone 'America/Los_Angeles')::date))::date $$;

create or replace function _metrc_usage_limit(p_service text) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(regexp_replace(coalesce((select value from app_settings where key = 'comp.usage_limit_' || p_service), ''), '[^0-9]', '', 'g'), '')::int, 50000)
$$;

/** server only: add calls. p_rows = [{ service, source, reads, writes, errors }] */
create or replace function metrc_count_calls(p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r jsonb; d date := (now() at time zone 'America/Los_Angeles')::date; p date := _metrc_period(); s text; used int; lim int; lvl int;
  levels int[];
  out jsonb := '{}'::jsonb;
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    if (r ->> 'service') not in ('t3', 'api') then continue; end if;
    insert into metrc_usage (service, day, source, reads, writes, errors, last_at)
    values (r ->> 'service', d, coalesce(nullif(r ->> 'source', ''), 'app'), coalesce((r ->> 'reads')::int, 0), coalesce((r ->> 'writes')::int, 0), coalesce((r ->> 'errors')::int, 0), now())
    on conflict (service, day, source) do update set reads = metrc_usage.reads + excluded.reads, writes = metrc_usage.writes + excluded.writes,
      errors = metrc_usage.errors + excluded.errors, last_at = now();
  end loop;
  select array_agg(x::int order by x::int) into levels
    from unnest(string_to_array(coalesce((select value from app_settings where key = 'comp.usage_warn'), '70,90'), ',')) x where trim(x) ~ '^[0-9]+$';
  levels := coalesce(levels, array[70, 90]) || 100;
  for s in select distinct r2 ->> 'service' from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r2 where (r2 ->> 'service') in ('t3', 'api') loop
    select coalesce(sum(reads + writes), 0) into used from metrc_usage where service = s and day >= p;
    lim := _metrc_usage_limit(s);
    foreach lvl in array levels loop
      if lim > 0 and used * 100 >= lim * lvl then
        insert into metrc_usage_warnings (service, period, level, calls) values (s, p, lvl, used) on conflict do nothing;
        if found then
          perform _comp_event('metrc_usage', s, jsonb_build_object('service', s, 'level', lvl, 'calls', used, 'limit', lim, 'period', p));
        end if;
      end if;
    end loop;
    out := out || jsonb_build_object(s, jsonb_build_object('calls', used, 'limit', lim));
  end loop;
  return out;
end $$;
revoke all on function metrc_count_calls(jsonb) from public, anon, authenticated;
grant execute on function metrc_count_calls(jsonb) to service_role;

/** the meters for the app: this month per service, with a projection to month end, sources and the last 31 days */
create or replace function metrc_usage_now() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  today date := (now() at time zone 'America/Los_Angeles')::date; p date := _metrc_period(); days_in int; elapsed numeric;
  out jsonb := '[]'::jsonb; s text; lim int; used int; rd int; wr int; er int; td int; proj int; lvl int; since date; left_days numeric;
begin
  if not comp_can_read() then raise exception 'Compliance only'; end if;
  days_in := extract(day from (p + interval '1 month' - interval '1 day'))::int;
  foreach s in array array['t3', 'api'] loop
    lim := _metrc_usage_limit(s);
    -- the projection runs from when counting started (the first month is partial), counting today as partly done
    since := greatest(p, coalesce((select min(day) from metrc_usage where service = s), today));
    elapsed := greatest(0.25, (today - since) + extract(epoch from ((now() at time zone 'America/Los_Angeles') - today::timestamp)) / 86400.0);
    left_days := greatest(0, days_in - ((today - p) + extract(epoch from ((now() at time zone 'America/Los_Angeles') - today::timestamp)) / 86400.0));
    select coalesce(sum(reads), 0), coalesce(sum(writes), 0), coalesce(sum(errors), 0), coalesce(sum(reads + writes) filter (where day = today), 0)
      into rd, wr, er, td from metrc_usage where service = s and day >= p;
    used := rd + wr;
    proj := round(used + used / elapsed * left_days);
    select coalesce(max(level), 0) into lvl from metrc_usage_warnings where service = s and period = p;
    out := out || jsonb_build_array(jsonb_build_object(
      'service', s, 'label', case s when 't3' then 'T3' else 'METRC API' end,
      'period', p, 'days_in_month', days_in, 'counting_since', since, 'days_counted', round(elapsed, 2),
      'limit', lim, 'calls', used, 'reads', rd, 'writes', wr, 'errors', er, 'today', td,
      'pct', case when lim > 0 then round(used * 100.0 / lim, 1) else 0 end,
      'avg_per_day', round(used / elapsed), 'projected', proj,
      'projected_pct', case when lim > 0 then round(proj * 100.0 / lim, 1) else 0 end,
      'level', lvl,
      'by_source', coalesce((select jsonb_object_agg(source, n) from (select source, sum(reads + writes) n from metrc_usage where service = s and day >= p group by source) x), '{}'::jsonb),
      'days', coalesce((select jsonb_agg(jsonb_build_object('day', day, 'calls', n, 'errors', e) order by day)
                         from (select day, sum(reads + writes) n, sum(errors) e from metrc_usage where service = s and day > today - 31 group by day) x), '[]'::jsonb),
      'last_at', (select max(last_at) from metrc_usage where service = s)
    ));
  end loop;
  return jsonb_build_object('warn', (select value from app_settings where key = 'comp.usage_warn'), 'services', out);
end $$;
revoke all on function metrc_usage_now() from public, anon;
grant execute on function metrc_usage_now() to authenticated;

create or replace function metrc_set_usage(p_service text, p_limit int, p_warn text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not comp_is_admin() then raise exception 'Only a Compliance Admin can change the usage limits'; end if;
  if p_service is not null then
    if p_service not in ('t3', 'api') then raise exception 'T3 or METRC API'; end if;
    if p_limit is null or p_limit < 0 then raise exception 'Monthly limit is a number of calls'; end if;
    insert into app_settings (key, value) values ('comp.usage_limit_' || p_service, p_limit::text) on conflict (key) do update set value = excluded.value;
  end if;
  if p_warn is not null then
    if p_warn !~ '^\s*[0-9]{1,2}(\s*,\s*[0-9]{1,2})*\s*$' then raise exception 'Warnings are percents like 70,90'; end if;
    insert into app_settings (key, value) values ('comp.usage_warn', regexp_replace(p_warn, '\s', '', 'g')) on conflict (key) do update set value = excluded.value;
  end if;
  perform _comp_event('metrc_usage_setting', coalesce(p_service, 'warn'), jsonb_build_object('service', p_service, 'limit', p_limit, 'warn', p_warn));
end $$;
revoke all on function metrc_set_usage(text, int, text) from public, anon;
grant execute on function metrc_set_usage(text, int, text) to authenticated;

notify pgrst, 'reload schema';
