-- 087: harvest day Pause (line down / technical issue) and End the day. Run after 086.
-- Pause is a break of kind 'pause': its time doesn't count toward pallet times, speed or the projection.
-- End the day stamps harvest_days.end_at (ends anything still running); the Live Bonus screen stops projecting and shows the final numbers.
-- A day that's never ended just stays as it was; the next day starts its own card at midnight.

alter table harvest_day_breaks drop constraint if exists harvest_day_breaks_kind_check;
alter table harvest_day_breaks add constraint harvest_day_breaks_kind_check check (kind in ('break', 'lunch', 'pause'));
alter table harvest_days add column if not exists end_at time;

create or replace function harvest_day_end(p_site text, p_day date, p_at time default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_at time := coalesce(p_at, _local_now_time());
begin
  perform require_module('cultivation');
  select id into v_id from harvest_days where site = p_site and day = p_day;
  if v_id is null then raise exception 'The day hasn''t started'; end if;
  update harvest_day_breaks set end_at = greatest(start_at, v_at) where day_id = v_id and end_at is null;
  update harvest_days set end_at = v_at, updated_at = now(), updated_by = current_email() where id = v_id;
end $$;

create or replace function harvest_day_reopen(p_site text, p_day date) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_module('cultivation');
  update harvest_days set end_at = null, updated_at = now(), updated_by = current_email() where site = p_site and day = p_day;
end $$;

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
      'cutters', d.cutters, 'est_hours', d.est_hours, 'hurdle', d.hurdle, 'hourly', d.hourly, 'per_lb', d.per_lb, 'end_at', to_char(d.end_at, 'HH24:MI')) end,
    'breaks', coalesce((select jsonb_agg(jsonb_build_object('kind', b.kind, 'start_at', to_char(b.start_at, 'HH24:MI'), 'end_at', to_char(b.end_at, 'HH24:MI')) order by b.start_at)
                        from harvest_day_breaks b where b.day_id = d.id), '[]'::jsonb),
    'pallets', coalesce((
      select jsonb_agg(jsonb_build_object('code', x.code, 'strain', x.strain, 'lbs', x.lbs, 'min', x.m) order by x.m, x.id)
      from (select p.id, p.code, coalesce(h.strain, p.strain) as strain, coalesce(p.og_weight, p.current_weight, 0) as lbs,
                   extract(epoch from ((coalesce(p.built_at, p.created_at) at time zone tz) - (coalesce(p.built_at, p.created_at) at time zone tz)::date)) / 60 as m
            from pallets p join cult_harvests h on h.id = p.harvest_id
            where h.site = v_site and h.kind = 'ff' and p.parent_id is null and h.harvested_on = v_day
              and (coalesce(p.built_at, p.created_at) at time zone tz)::date = v_day
              and not (p.status = 'archived' and coalesce(p.notes, '') like '%(logged by mistake)%')) x), '[]'::jsonb));
end $$;

revoke execute on function harvest_day_end(text, date, time), harvest_day_reopen(text, date) from public;
grant execute on function harvest_day_end(text, date, time), harvest_day_reopen(text, date) to authenticated;
grant execute on function bonus_live(text, date) to anon, authenticated;

select 'ok' as harvest_pause_end;
