-- 085: Live Bonus counts only pallets from harvests harvested that day.
-- Pallets back-filled or imported today for older harvests (catch-up work) no longer show up as today's packing. Run after 084.

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
            where h.site = v_site and h.kind = 'ff' and p.parent_id is null and h.harvested_on = v_day
              and (coalesce(p.built_at, p.created_at) at time zone tz)::date = v_day
              and not (p.status = 'archived' and coalesce(p.notes, '') like '%(logged by mistake)%')) x), '[]'::jsonb));
end $$;

grant execute on function bonus_live(text, date) to anon, authenticated;

select 'ok' as bonus_today_only;
