-- 146_metrc_date_push_day.sql  (Msg TAG-15, 2026-10-30)
-- TEMPORARY (catch-up): Aziz doesn't want late harvest dates in METRC (they get flagged). While the setting
-- cult.metrc_date_push_day is 'on' (the default), a harvest whose app date is before today goes to METRC with the
-- day its plants are pushed, and the METRC harvest name carries that date too:
--   app date 10/19, pushed 10/31 -> METRC harvest date 10/31, name OHR-M176-3-10312026-1-FF.
-- The app keeps its own harvest date and the in-app name (OHR-Moroccan Peaches x Donny Burger #54-3-10192026-1-FF).
-- A harvest dated today or later is unchanged. Names already saved (in METRC) never change.
-- To turn off: update app_settings set value = 'off' where key = 'cult.metrc_date_push_day';
-- Planned removal: a few weeks (see remove-before-full-production.md).
-- Re-runnable.
begin;

insert into app_settings (key, value) values ('cult.metrc_date_push_day', 'on') on conflict (key) do nothing;

-- the date METRC gets for a harvest (Pacific time)
create or replace function cult_metrc_date(h cult_harvests) returns date
language sql stable security definer set search_path = public as $$
  select case when coalesce((select value from app_settings where key = 'cult.metrc_date_push_day'), 'off') = 'on'
              then greatest(coalesce(h.harvested_on, h.planned_on, (now() at time zone 'America/Los_Angeles')::date), (now() at time zone 'America/Los_Angeles')::date)
              else coalesce(h.harvested_on, h.planned_on, (now() at time zone 'America/Los_Angeles')::date) end
$$;
revoke all on function cult_metrc_date(cult_harvests) from public, anon;
grant execute on function cult_metrc_date(cult_harvests) to authenticated;

create or replace function harvest_name(h cult_harvests) returns text
language sql stable security definer set search_path = public as $$
  select h.site
      || '-' || strain_code(sid)
      || '-' || coalesce((select f.code from fields f where f.id = coalesce(h.field_id, (select p.field_id from cult_plantings p where p.id = h.planting_id))), 'X')
      || '-' || to_char(cult_metrc_date(h), 'MMDDYYYY')
      || '-' || cult_harvest_no(h)
      || '-' || case h.kind when 'ff' then 'FF' when 'dry' then 'D' else 'BM' end
    from (select strain_id_by_name(h.strain) as sid) x
   where strain_code(sid) is not null
$$;

-- every "harvest plants" step carries the date METRC gets (the T3 sender uses details.metrc_date)
create or replace function _cult_metrc_date_on_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare h cult_harvests;
begin
  if new.type = 'harvest_plants' and nullif(new.details ->> 'harvest_id', '') is not null and not (coalesce(new.details, '{}') ? 'metrc_date') then
    select * into h from cult_harvests where id = (new.details ->> 'harvest_id')::bigint;
    if h.id is not null then new.details := coalesce(new.details, '{}') || jsonb_build_object('metrc_date', cult_metrc_date(h)::text); end if;
  end if;
  return new;
exception when others then return new;   -- never block the real action
end $$;
drop trigger if exists cult_metrc_date_on_event on events;
create trigger cult_metrc_date_on_event before insert on events for each row execute function _cult_metrc_date_on_event();

create or replace function cult_batch_name_of(p_harvest bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('name', cult_batch_name(h), 'saved', nullif(trim(h.metrc_name), '') is not null,
                            'generated', harvest_name(h), 'app_name', harvest_app_name(h), 'metrc_date', cult_metrc_date(h),
                            'in_metrc', exists (select 1 from events e where e.type = 'harvest_plants' and e.details ->> 'harvest_id' = h.id::text))
    from cult_harvests h where h.id = p_harvest and has_module('cultivation')
$$;

insert into events (user_email, type, note, details)
values ('aziz@lifted-organics.com', 'harvest_names', '146 METRC date = push day (temporary, catch-up)', jsonb_build_object('setting', 'cult.metrc_date_push_day', 'value', 'on'));

commit;
