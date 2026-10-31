-- 141_harvest_names.sql  (Msg TAG-7, 2026-10-30)
-- Strain codes + new METRC harvest names (Aziz, Msgs TAG-5 / TAG-6):
--   * Strain code = first letter of the strain name (first A-Z in it, so "#1 LZ48 x P" = L, "4K" = K)
--     + the app's strain number, at least 3 digits: Jelly Cake x Oreoz (143) = J143. Stored on strains.code,
--     set once and never changed by a rename (like strain_no). Replaces the 4-digit 0143 code (STR-4); no strain was coded yet.
--     Used for coded nursery names: 1PN (FL27WB) - J143 - Clone.
--   * Harvest name = SITE-CODE-FIELD-MMDDYYYY-N-KIND, e.g. OHR-J143-1C-10232026-1-FF
--       FIELD = the app's block/field code (Block 3 = 3), DATE = the app's harvest date,
--       N = harvest number for that planting, KIND = FF fresh frozen, D dry, BM biomass (combine / strip header).
--   * A name typed on the harvest still wins. The name is saved on the harvest the first time its plants go to METRC
--     (trigger from 115), so it never changes after. Harvests already in METRC keep their names.
--   * Continue tomorrow: the new harvest gets its own name (its own harvest number), not parent name + -2.
-- Re-runnable.
begin;

-- 0. freeze names already in use (runs with the old cult_batch_name, before it is replaced) --------------------
-- harvests with anything in METRC (or a to-do for it) keep the name they went under
update cult_harvests h set metrc_name = cult_batch_name(h)
 where nullif(trim(h.metrc_name), '') is null
   and (exists (select 1 from comp_metrc_actions a where a.harvest_id = h.id)
        or exists (select 1 from events e where e.type in ('harvest_plants', 'pushed') and e.details ->> 'harvest_id' = h.id::text));

-- 1. strain codes ----------------------------------------------------------------------------------------------
alter table strains add column if not exists code text;

create or replace function strain_code_for(p_name text, p_no int) returns text
language sql immutable set search_path = public as $$
  select case when p_no is null then null
              else coalesce(upper(substring(coalesce(p_name, '') from '[A-Za-z]')), 'X') || lpad(p_no::text, 3, '0') end
$$;

update strains set code = strain_code_for(name, strain_no) where code is null and strain_no is not null;
create unique index if not exists strains_code on strains (code);

-- new strains get their code when their number is set; a code never changes after that
create or replace function strain_set_code() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.code is not null then new.code := old.code; return new; end if;
  if new.code is null then new.code := strain_code_for(new.name, new.strain_no); end if;
  return new;
end $$;
drop trigger if exists strain_set_code on strains;
-- named so it fires after strain_no_set (triggers run in name order)
create trigger strain_set_code before insert or update on strains for each row execute function strain_set_code();

create or replace function strain_code(p_strain int) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(code, strain_code_for(name, strain_no)) from strains where id = p_strain
$$;

-- a strain by any name it goes by (name, aliases, METRC spelling)
create or replace function strain_id_by_name(p_name text) returns int
language sql stable security definer set search_path = public as $$
  select s.id from strains s
   where lower(trim(s.name)) = lower(trim(p_name))
      or lower(trim(p_name)) = any (select lower(trim(a)) from unnest(coalesce(s.aliases, '{}')) a)
      or lower(trim(s.roshi_name)) = lower(trim(p_name))
   order by (lower(trim(s.name)) = lower(trim(p_name))) desc, s.active desc, s.id
   limit 1
$$;

-- 2. harvest names ---------------------------------------------------------------------------------------------
create or replace function cult_harvest_no(h cult_harvests) returns int
language sql stable security definer set search_path = public as $$
  select case when h.planting_id is null then 1 else
    1 + (select count(*)::int from cult_harvests o
          where o.planting_id = h.planting_id and o.id <> h.id and o.status <> 'cancelled'
            and (coalesce(o.harvested_on, o.planned_on), coalesce(o.day_no, 1), o.id)
              < (coalesce(h.harvested_on, h.planned_on), coalesce(h.day_no, 1), h.id)) end
$$;

create or replace function harvest_name(h cult_harvests) returns text
language sql stable security definer set search_path = public as $$
  select h.site
      || '-' || strain_code(sid)
      || '-' || coalesce((select f.code from fields f where f.id = coalesce(h.field_id, (select p.field_id from cult_plantings p where p.id = h.planting_id))), 'X')
      || '-' || to_char(coalesce(h.harvested_on, h.planned_on, current_date), 'MMDDYYYY')
      || '-' || cult_harvest_no(h)
      || '-' || case h.kind when 'ff' then 'FF' when 'dry' then 'D' else 'BM' end
    from (select strain_id_by_name(h.strain) as sid) x
   where strain_code(sid) is not null
$$;

create or replace function cult_batch_name(h cult_harvests) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(trim(h.metrc_name), ''),
                  (select l.metrc_name from harvest_lots l where l.id = h.lot_id),
                  harvest_name(h),
                  -- strain not in the strain list: the old style name
                  h.strain || ' Field ' || coalesce((select f.code from fields f where f.id = h.field_id), '?')
                    || ' ' || to_char(coalesce(h.harvested_on, h.planned_on, current_date), 'MM/DD'))
$$;

-- continue tomorrow: the new harvest gets its own name, not the first day's name + -2 (same as 057 otherwise)
create or replace function cult_continue(p_harvest bigint, p_plants int, p_on date default null, p_notes text default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare h cult_harvests; root cult_harvests; nid bigint; dn int; left_ int; base text;
begin
  perform require_module('cultivation'); perform no_view_as();
  select * into h from cult_harvests where id = p_harvest for update;
  if h.id is null then raise exception 'Harvest not found'; end if;
  if h.kind not in ('ff','dry') then raise exception 'Continue tomorrow is for flower harvests'; end if;
  perform cult_finish(h.id, p_plants, p_notes);
  select * into h from cult_harvests where id = p_harvest;
  select * into root from cult_harvests where id = coalesce(h.parent_id, h.id);
  select coalesce(max(day_no), 1) + 1 into dn from cult_harvests where id = root.id or parent_id = root.id;
  -- plants still standing in that planting
  left_ := greatest(coalesce((select pl.plants - coalesce(pl.plant_loss, 0) from cult_plantings pl where pl.id = h.planting_id), root.plants, 0)
                    - coalesce((select sum(coalesce(x.plants_harvested, 0)) from cult_harvests x where x.planting_id = h.planting_id and x.status = 'done' and x.kind = h.kind), 0), 0);
  if h.planting_id is null then left_ := greatest(coalesce(root.plants, 0) - coalesce((select sum(coalesce(x.plants_harvested, 0)) from cult_harvests x where (x.id = root.id or x.parent_id = root.id) and x.status = 'done'), 0), 0); end if;
  base := coalesce(nullif(trim(root.metrc_name), ''), (select l.metrc_name from harvest_lots l where l.id = root.lot_id));
  insert into cult_harvests (crop_year, site, field_id, strain, planting_id, kind, status, planned_on, plants, est_lbs_per_plant, est_raw_per_plant,
                             deleaf_rate, buck_rate, dry_conversion, acres, est_yield_per_acre, metrc_name, parent_id, day_no, notes, created_by, planted_strain)
  values (h.crop_year, h.site, h.field_id, h.strain, h.planting_id, h.kind, 'planned', coalesce(p_on, current_date + 1), nullif(left_, 0),
          h.est_lbs_per_plant, h.est_raw_per_plant, h.deleaf_rate, h.buck_rate, h.dry_conversion, null, h.est_yield_per_acre,
          null /* 141: own METRC name (next harvest number for the planting) */, root.id, dn, 'Day ' || dn || ' of ' || h.strain, current_email(), h.planted_strain)
  returning id into nid;
  if root.id = h.id and base is not null and h.metrc_name is null then null; end if;
  insert into events (user_email, type, note, details) values (current_email(), 'harvest_continued', h.strain,
         jsonb_build_object('harvest_id', h.id, 'next_id', nid, 'day', dn, 'plants_left', left_));
  return nid;
end $$;


-- the Harvest log shows each harvest's name (saved, or what it will be)
create or replace function cult_batch_name_of(p_harvest bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('name', cult_batch_name(h), 'saved', nullif(trim(h.metrc_name), '') is not null,
                            'generated', harvest_name(h), 'in_metrc',
                            exists (select 1 from events e where e.type = 'harvest_plants' and e.details ->> 'harvest_id' = h.id::text))
    from cult_harvests h where h.id = p_harvest and has_module('cultivation')
$$;
revoke all on function cult_batch_name_of(bigint) from public, anon;
grant execute on function cult_batch_name_of(bigint) to authenticated;
revoke all on function strain_code_for(text, int), strain_id_by_name(text), cult_harvest_no(cult_harvests), harvest_name(cult_harvests) from public, anon;
grant execute on function strain_code_for(text, int), strain_id_by_name(text), cult_harvest_no(cult_harvests), harvest_name(cult_harvests) to authenticated;

insert into events (user_email, type, note, details)
values (coalesce(current_email(), 'aziz@lifted-organics.com'), 'harvest_names', '141 strain codes + harvest names',
        jsonb_build_object('strains_coded', (select count(*) from strains where code is not null)));

commit;

select (select count(*) from strains where code is not null) as strains_with_code,
       (select count(*) from strains where code is null) as strains_without_code,
       (select code from strains where strain_no = 143) as strain_143;
