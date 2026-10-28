-- 084: harvest day (labor, breaks), pallet build time, Live Bonus screen link
-- One harvest_days row per site per day: entered once on the Harvest screen, used by every variety that day.
-- Pallet time = when it was saved (pallets.created_at) unless someone sets built_at by hand.
-- bonus_live(token) is public (anon): the TV screen at /?bonus=<token>. Run after 083.

create table if not exists harvest_days (
  id          bigserial primary key,
  site        text not null,
  day         date not null,
  room_start  time,
  box_start   time,
  people      int,
  buckers     int,
  cutters     int,
  est_hours   numeric not null default 8,
  hurdle      numeric,
  hourly      numeric not null default 18,
  per_lb      numeric not null default 0.25,
  notes       text,
  updated_at  timestamptz not null default now(),
  updated_by  text default current_email(),
  unique (site, day));

create table if not exists harvest_day_breaks (
  id          bigserial primary key,
  day_id      bigint not null references harvest_days(id) on delete cascade,
  kind        text not null default 'break' check (kind in ('break', 'lunch')),
  start_at    time not null,
  end_at      time,
  created_by  text default current_email(),
  created_at  timestamptz not null default now());
create index if not exists harvest_day_breaks_day on harvest_day_breaks (day_id);

create table if not exists bonus_links (
  site        text primary key,
  token       text not null unique default replace(gen_random_uuid()::text, '-', ''),
  created_at  timestamptz not null default now(),
  created_by  text default current_email());

alter table pallets add column if not exists built_at timestamptz;

alter table harvest_days enable row level security;
alter table harvest_day_breaks enable row level security;
alter table bonus_links enable row level security;
drop policy if exists read_harvest_days on harvest_days;
create policy read_harvest_days on harvest_days for select to authenticated using (is_staff());
drop policy if exists read_harvest_day_breaks on harvest_day_breaks;
create policy read_harvest_day_breaks on harvest_day_breaks for select to authenticated using (is_staff());
-- bonus_links: no direct reads (the token is handed out by bonus_link())
grant select on harvest_days, harvest_day_breaks to authenticated;
grant all on harvest_days, harvest_day_breaks, bonus_links to service_role;

create or replace function _local_today() returns date language sql stable as $$ select (now() at time zone 'America/Los_Angeles')::date $$;
create or replace function _local_now_time() returns time language sql stable as $$ select date_trunc('minute', (now() at time zone 'America/Los_Angeles'))::time $$;

-- the day's card; a day not started yet comes back with the last day's numbers at that site (is_new = true)
create or replace function harvest_day_get(p_site text, p_day date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d harvest_days; prev harvest_days;
begin
  if not is_staff() then raise exception 'Not allowed'; end if;
  select * into d from harvest_days where site = p_site and day = p_day;
  if d.id is null then
    select * into prev from harvest_days where site = p_site and day < p_day order by day desc limit 1;
    return jsonb_build_object('is_new', true, 'site', p_site, 'day', p_day,
      'people', prev.people, 'buckers', prev.buckers, 'cutters', prev.cutters, 'est_hours', coalesce(prev.est_hours, 8),
      'hurdle', coalesce(prev.hurdle, 200), 'hourly', coalesce(prev.hourly, 18), 'per_lb', coalesce(prev.per_lb, 0.25), 'breaks', '[]'::jsonb);
  end if;
  return to_jsonb(d) || jsonb_build_object('is_new', false, 'breaks', coalesce((
    select jsonb_agg(jsonb_build_object('id', b.id, 'kind', b.kind, 'start_at', to_char(b.start_at, 'HH24:MI'), 'end_at', to_char(b.end_at, 'HH24:MI')) order by b.start_at)
    from harvest_day_breaks b where b.day_id = d.id), '[]'::jsonb));
end $$;

-- save the card: {"room_start":"05:05","box_start":"05:09","people":89,"buckers":36,"cutters":12,"est_hours":8,"hurdle":200,"hourly":18,"per_lb":0.25,"notes":""}
create or replace function harvest_day_save(p_site text, p_day date, p jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  perform require_module('cultivation');
  insert into harvest_days (site, day) values (p_site, p_day) on conflict (site, day) do nothing;
  update harvest_days set
    room_start = case when p ? 'room_start' then nullif(p ->> 'room_start', '')::time else room_start end,
    box_start  = case when p ? 'box_start'  then nullif(p ->> 'box_start', '')::time else box_start end,
    people     = case when p ? 'people'     then nullif(p ->> 'people', '')::int else people end,
    buckers    = case when p ? 'buckers'    then nullif(p ->> 'buckers', '')::int else buckers end,
    cutters    = case when p ? 'cutters'    then nullif(p ->> 'cutters', '')::int else cutters end,
    est_hours  = case when p ? 'est_hours'  then coalesce(nullif(p ->> 'est_hours', '')::numeric, 8) else est_hours end,
    hurdle     = case when p ? 'hurdle'     then nullif(p ->> 'hurdle', '')::numeric else hurdle end,
    hourly     = case when p ? 'hourly'     then coalesce(nullif(p ->> 'hourly', '')::numeric, 18) else hourly end,
    per_lb     = case when p ? 'per_lb'     then coalesce(nullif(p ->> 'per_lb', '')::numeric, 0.25) else per_lb end,
    notes      = case when p ? 'notes'      then nullif(trim(p ->> 'notes'), '') else notes end,
    updated_at = now(), updated_by = current_email()
  where site = p_site and day = p_day returning id into v_id;
  return v_id;
end $$;

-- break / lunch: start now (or at p_at), end now (or at p_at), fix the times, remove
create or replace function harvest_break_start(p_site text, p_day date, p_kind text, p_at time default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_day bigint; v_id bigint;
begin
  perform require_module('cultivation');
  insert into harvest_days (site, day) values (p_site, p_day) on conflict (site, day) do nothing;
  select id into v_day from harvest_days where site = p_site and day = p_day;
  if exists (select 1 from harvest_day_breaks where day_id = v_day and end_at is null) then raise exception 'A break is still going. End it first.'; end if;
  insert into harvest_day_breaks (day_id, kind, start_at) values (v_day, coalesce(nullif(p_kind, ''), 'break'), coalesce(p_at, _local_now_time())) returning id into v_id;
  return v_id;
end $$;

create or replace function harvest_break_end(p_id bigint, p_at time default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_module('cultivation');
  update harvest_day_breaks set end_at = coalesce(p_at, _local_now_time()) where id = p_id;
end $$;

create or replace function harvest_break_edit(p_id bigint, p_kind text, p_start time, p_end time) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_module('cultivation');
  if p_end is not null and p_end < p_start then raise exception 'The break ends before it starts'; end if;
  update harvest_day_breaks set kind = coalesce(nullif(p_kind, ''), kind), start_at = p_start, end_at = p_end where id = p_id;
end $$;

create or replace function harvest_break_remove(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_module('cultivation');
  delete from harvest_day_breaks where id = p_id;
end $$;

-- pallet time: when it was saved unless fixed by hand. p_time is the local clock time on the pallet's own day (null = back to the save time).
-- Works after push too (it's not METRC data).
create or replace function cult_set_pallet_time(p_pallet bigint, p_time time) returns void
language plpgsql security definer set search_path = public as $$
declare p pallets; v_at timestamptz; tz text := 'America/Los_Angeles';
begin
  perform require_module('cultivation');
  select * into p from pallets where id = p_pallet for update;
  if p.id is null or p.harvest_id is null then raise exception 'Not a harvest pallet'; end if;
  if p_time is not null then v_at := (((coalesce(p.built_at, p.created_at) at time zone tz)::date + p_time) at time zone tz); end if;
  update pallets set built_at = v_at, updated_at = now() where id = p.id;
  insert into events (user_email, type, pallet_id, lbs, note, details)
  values (current_email(), 'harvest_fix', p.id, p.og_weight, 'Pallet time', jsonb_build_object('built_at', v_at, 'was', coalesce(p.built_at, p.created_at)));
end $$;

-- the TV link for a site (made the first time it's asked for)
create or replace function bonus_link(p_site text) returns text
language plpgsql security definer set search_path = public as $$
declare t text;
begin
  if not is_staff() then raise exception 'Not allowed'; end if;
  insert into bonus_links (site) values (p_site) on conflict (site) do nothing;
  select token into t from bonus_links where site = p_site;
  return t;
end $$;

-- a new link (the old one stops working): Production Admins
create or replace function bonus_link_reset(p_site text) returns text
language plpgsql security definer set search_path = public as $$
declare t text;
begin
  if not is_mod_admin('cultivation') then raise exception 'Only a Production Admin can make a new link'; end if;
  insert into bonus_links (site) values (p_site)
  on conflict (site) do update set token = replace(gen_random_uuid()::text, '-', ''), created_at = now(), created_by = current_email();
  select token into t from bonus_links where site = p_site;
  return t;
end $$;

-- the screen's data: the day card, breaks and today's fresh frozen pallets at the site (minutes since local midnight)
create or replace function bonus_live(p_token text, p_day date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_site text; v_day date := coalesce(p_day, _local_today()); d harvest_days; tz text := 'America/Los_Angeles';
begin
  select site into v_site from bonus_links where token = p_token;
  if v_site is null then return null; end if;
  select * into d from harvest_days where site = v_site and day = v_day;
  return jsonb_build_object(
    'site', v_site, 'site_name', (select name from sites where code = v_site), 'day', v_day,
    'now_min', extract(epoch from ((now() at time zone tz) - (now() at time zone tz)::date)) / 60,
    'is_today', v_day = _local_today(),
    'card', case when d.id is null then null else jsonb_build_object(
      'room_start', to_char(d.room_start, 'HH24:MI'), 'box_start', to_char(d.box_start, 'HH24:MI'), 'people', d.people, 'buckers', d.buckers,
      'cutters', d.cutters, 'est_hours', d.est_hours, 'hurdle', d.hurdle, 'hourly', d.hourly, 'per_lb', d.per_lb) end,
    'breaks', coalesce((select jsonb_agg(jsonb_build_object('kind', b.kind, 'start_at', to_char(b.start_at, 'HH24:MI'), 'end_at', to_char(b.end_at, 'HH24:MI')) order by b.start_at)
                        from harvest_day_breaks b where b.day_id = d.id), '[]'::jsonb),
    'pallets', coalesce((
      select jsonb_agg(jsonb_build_object('code', x.code, 'strain', x.strain, 'lbs', x.lbs, 'min', x.m) order by x.m, x.id)
      from (select p.id, p.code, coalesce(h.strain, p.strain) as strain, coalesce(p.og_weight, p.current_weight, 0) as lbs,
                   extract(epoch from ((coalesce(p.built_at, p.created_at) at time zone tz) - (coalesce(p.built_at, p.created_at) at time zone tz)::date)) / 60 as m
            from pallets p join cult_harvests h on h.id = p.harvest_id
            where h.site = v_site and h.kind = 'ff' and p.parent_id is null
              and (coalesce(p.built_at, p.created_at) at time zone tz)::date = v_day
              and not (p.status = 'archived' and coalesce(p.notes, '') like '%(logged by mistake)%')) x), '[]'::jsonb));
end $$;

revoke execute on function harvest_day_get(text, date), harvest_day_save(text, date, jsonb), harvest_break_start(text, date, text, time), harvest_break_end(bigint, time),
  harvest_break_edit(bigint, text, time, time), harvest_break_remove(bigint), cult_set_pallet_time(bigint, time), bonus_link(text), bonus_link_reset(text),
  bonus_live(text, date) from public;
grant execute on function harvest_day_get(text, date), harvest_day_save(text, date, jsonb), harvest_break_start(text, date, text, time), harvest_break_end(bigint, time),
  harvest_break_edit(bigint, text, time, time), harvest_break_remove(bigint), cult_set_pallet_time(bigint, time), bonus_link(text), bonus_link_reset(text) to authenticated;
grant execute on function bonus_live(text, date) to anon, authenticated;

select 'ok' as harvest_days;
