-- 142_app_harvest_name.sql  (Msg TAG-9, 2026-10-30)
--  * harvest_app_name(h): the in-app twin of the METRC harvest name, with the strain name instead of the code:
--      OHR-Jelly Cake x Oreoz-1C-10232026-1-FF  <->  OHR-J143-1C-10232026-1-FF. Never saved; follows renames.
--    (The app works it out on screen the same way: cult/calc.ts appHarvestName.)
--  * harvest_lot(): 2027+ lots no longer get the FL27-OH-047-01 lot code as their METRC name (replaced by the 141 names).
--  * Fields for 5 old harvests that had none (one 2026 OHR planting of that strain each). Pressure (184),
--    Rainbow Guava (185) and Sour Strawberry (188) were in both fields: left blank.
-- Re-runnable.
begin;

create or replace function harvest_app_name(h cult_harvests) returns text
language sql stable security definer set search_path = public as $$
  select h.site
      || '-' || h.strain
      || '-' || coalesce((select f.code from fields f where f.id = coalesce(h.field_id, (select p.field_id from cult_plantings p where p.id = h.planting_id))), 'X')
      || '-' || to_char(coalesce(h.harvested_on, h.planned_on, current_date), 'MMDDYYYY')
      || '-' || cult_harvest_no(h)
      || '-' || case h.kind when 'ff' then 'FF' when 'dry' then 'D' else 'BM' end
$$;
revoke all on function harvest_app_name(cult_harvests) from public, anon;
grant execute on function harvest_app_name(cult_harvests) to authenticated;

create or replace function cult_batch_name_of(p_harvest bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('name', cult_batch_name(h), 'saved', nullif(trim(h.metrc_name), '') is not null,
                            'generated', harvest_name(h), 'app_name', harvest_app_name(h), 'in_metrc',
                            exists (select 1 from events e where e.type = 'harvest_plants' and e.details ->> 'harvest_id' = h.id::text))
    from cult_harvests h where h.id = p_harvest and has_module('cultivation')
$$;

do $$
declare d text;
begin
  select pg_get_functiondef('harvest_lot(bigint,boolean)'::regprocedure) into d;
  if d like '%case when h.crop_year >= 2027 then lot_code(h.crop_year, h.site, sid, n) else nullif(trim(h.metrc_name), '''') end%' then
    execute replace(d, 'case when h.crop_year >= 2027 then lot_code(h.crop_year, h.site, sid, n) else nullif(trim(h.metrc_name), '''') end',
                       'nullif(trim(h.metrc_name), '''')');
  end if;
end $$;

update cult_harvests h set field_id = f.id, updated_at = now()
  from (values (73, '1C'), (170, '7'), (179, '7'), (183, '7'), (191, '7')) v(hid, code)
  join fields f on f.site = 'OHR' and f.code = v.code
 where h.id = v.hid and h.field_id is null;

insert into events (user_email, type, note, details)
values ('aziz@lifted-organics.com', 'harvest_fix', '142 fields for old harvests',
        jsonb_build_object('harvests', jsonb_build_array(73, 170, 179, 183, 191), 'left_blank', jsonb_build_array(184, 185, 188)));

commit;
