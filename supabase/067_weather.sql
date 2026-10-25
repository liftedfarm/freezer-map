-- Migration 067 (Aziz 10/24): Weather in the top bar, phases 1 + 2.
-- Two forecast points: OHR (Paicines) and Watsonville (GVR + the 1PN nursery on Webb Rd).
-- Vercel cron /api/weather/refresh (hourly) pulls NWS + Open-Meteo models, blends them, works out VPD and the
-- risk flags, and writes the tables below with the service key. Staff read them. Owners and Production
-- (cultivation) Admins edit the flag thresholds per site. Run after 066. Safe to re-run.

set client_min_messages = warning;

create table if not exists weather_sites (
  id            text primary key,                 -- 'ohr' | 'wat'
  name          text not null,
  address       text,
  lat           numeric not null,
  lon           numeric not null,
  app_sites     text[] not null default '{}',     -- app site codes this forecast covers (harvest schedule)
  nws_office    text,
  nws_x         int,
  nws_y         int,
  obs_station   text,                             -- airport station used to score forecasts until ours is in
  rules         jsonb not null default '{}',      -- flag thresholds; blank keys fall back to the defaults in the refresh job
  sort          int not null default 0,
  active        boolean not null default true,
  updated_by    text,
  updated_at    timestamptz not null default now()
);

insert into weather_sites (id, name, address, lat, lon, app_sites, nws_office, nws_x, nws_y, obs_station, rules, sort) values
  ('ohr', 'OHR', '2038 Old Airline Hwy, Paicines, CA 95043', 36.6648, -121.2541, '{OHR}', 'MTR', 116, 48, 'KCVH',
     '{"botrytis": {"on": false}}', 1),
  ('wat', 'Watsonville', '1363 Green Valley Rd, Watsonville, CA 95076 (also 1PN, 361 Webb Rd)', 36.9891, -121.7770, '{GVR,1PN}', 'MTR', 100, 66, 'KWVI',
     '{}', 2)
on conflict (id) do nothing;

-- one row per refresh
create table if not exists weather_runs (
  id        bigserial primary key,
  ran_at    timestamptz not null default now(),
  ok        boolean not null default true,
  sources   jsonb,          -- per site, per source: ok / error
  error     text,
  ms        int
);
create index if not exists weather_runs_at on weather_runs (ran_at desc);

-- the blended "most likely" forecast, hourly (latest run wins)
create table if not exists weather_hourly (
  site_id    text not null references weather_sites(id) on delete cascade,
  t          timestamptz not null,
  temp_f     numeric, rh numeric, dew_f numeric, vpd numeric,
  pop        numeric, precip_in numeric,
  wind_mph   numeric, gust_mph numeric, wind_dir numeric,
  cloud      numeric, aqi numeric, inversion boolean,
  icon       text,
  spread_f   numeric,         -- how far apart the models are on temperature
  n_models   int,
  issued_at  timestamptz not null default now(),
  primary key (site_id, t)
);

-- daily summary (local day, America/Los_Angeles)
create table if not exists weather_daily (
  site_id    text not null references weather_sites(id) on delete cascade,
  day        date not null,
  hi_f numeric, lo_f numeric, pop numeric, precip_in numeric,
  wind_mph numeric, gust_mph numeric, rh_max numeric, rh_min numeric,
  vpd_max numeric, vpd_min numeric, aqi_max numeric,
  icon       text,
  confidence int,             -- 0-100
  n_models   int,
  issued_at  timestamptz not null default now(),
  primary key (site_id, day)
);

-- active NWS alerts
create table if not exists weather_alerts (
  site_id    text not null references weather_sites(id) on delete cascade,
  id         text not null,
  event      text, severity text, headline text, description text, instruction text,
  starts     timestamptz, ends timestamptz,
  primary key (site_id, id)
);

-- risk flags (replaced every run)
create table if not exists weather_flags (
  id         bigserial primary key,
  site_id    text not null references weather_sites(id) on delete cascade,
  day        date not null,
  kind       text not null,   -- botrytis, mildew, rain, frost, heat_crew, heat_plant, wind, smoke, fire, spray
  level      text not null check (level in ('watch','warning','good')),
  starts     timestamptz,
  ends       timestamptz,
  why        text,
  detail     jsonb
);
create index if not exists weather_flags_site on weather_flags (site_id, day);

-- raw source forecasts, about every 6 hours, for scoring which source is right at each site (phase 3)
create table if not exists weather_snapshots (
  site_id    text not null references weather_sites(id) on delete cascade,
  source     text not null,
  issued_at  timestamptz not null,
  data       jsonb not null,  -- { t0, step: 3600, temp_f: [], rh: [], pop: [], precip_in: [], gust_mph: [] }
  primary key (site_id, source, issued_at)
);

-- observed weather (airport stations now, our stations later)
create table if not exists weather_obs (
  station    text not null,
  site_id    text references weather_sites(id) on delete cascade,
  t          timestamptz not null,
  temp_f numeric, rh numeric, dew_f numeric, precip_in numeric, wind_mph numeric, gust_mph numeric,
  primary key (station, t)
);

-- ---------- access ----------
alter table weather_sites     enable row level security;
alter table weather_runs      enable row level security;
alter table weather_hourly    enable row level security;
alter table weather_daily     enable row level security;
alter table weather_alerts    enable row level security;
alter table weather_flags     enable row level security;
alter table weather_snapshots enable row level security;
alter table weather_obs       enable row level security;

drop policy if exists wx_read on weather_sites;     create policy wx_read on weather_sites     for select to authenticated using (is_staff());
drop policy if exists wx_read on weather_runs;      create policy wx_read on weather_runs      for select to authenticated using (is_staff());
drop policy if exists wx_read on weather_hourly;    create policy wx_read on weather_hourly    for select to authenticated using (is_staff());
drop policy if exists wx_read on weather_daily;     create policy wx_read on weather_daily     for select to authenticated using (is_staff());
drop policy if exists wx_read on weather_alerts;    create policy wx_read on weather_alerts    for select to authenticated using (is_staff());
drop policy if exists wx_read on weather_flags;     create policy wx_read on weather_flags     for select to authenticated using (is_staff());
drop policy if exists wx_read on weather_snapshots; create policy wx_read on weather_snapshots for select to authenticated using (is_staff());
drop policy if exists wx_read on weather_obs;       create policy wx_read on weather_obs       for select to authenticated using (is_staff());
-- no insert/update/delete policies: only the refresh job (service key) writes, plus weather_save_rules below

revoke all on weather_sites, weather_runs, weather_hourly, weather_daily, weather_alerts, weather_flags, weather_snapshots, weather_obs from anon;

-- can this person edit the flag thresholds?
create or replace function weather_can_edit() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(is_owner(), false) or coalesce(is_mod_admin('cultivation'), false)
$$;

create or replace function weather_save_rules(p_site text, p_rules jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform no_view_as();
  if not weather_can_edit() then raise exception 'Only Owners and Production Admins can change weather flag settings.'; end if;
  if p_rules is null or jsonb_typeof(p_rules) <> 'object' then raise exception 'Bad settings'; end if;
  update weather_sites set rules = p_rules, updated_by = current_email(), updated_at = now() where id = p_site;
  if not found then raise exception 'Unknown weather site %', p_site; end if;
end $$;

revoke execute on function weather_can_edit(), weather_save_rules(text, jsonb) from public, anon;
grant execute on function weather_can_edit(), weather_save_rules(text, jsonb) to authenticated;
