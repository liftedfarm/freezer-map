-- Migration 059: dry material gets the freezer map's pallet actions (Move, Split, Merge, Pull for mixed pallet,
-- Put on a load, Adjust weight, Edit tag, Remove) from the Processing package card, each with its METRC step.
-- Run once in Supabase after 058_access.sql: SQL Editor > New query > paste > Run. Safe to re-run.
--
--  * adjust_weight takes a METRC adjustment reason (drying / scale / waste / entry); it shows on the
--    Compliance > METRC to-do as "Adjust package weight (Drying)" etc.
--  * Remove now queues its METRC step: Used up = adjust to 0 and finish; Shipped outside the app = check the manifest.
--  * Splits keep "machine trimmed" (internal only); merges of dry product keep it if any piece had it.
--  * Splits and merges already keep product, crop year and harvest (047), and merges only take one product.
set client_min_messages = warning;

-- ---------- adjust weight with a METRC reason ----------
drop function if exists adjust_weight(bigint, numeric, text);
create or replace function adjust_weight(p_pallet_id bigint, p_weight numeric, p_note text default null, p_reason text default null) returns pallets
language plpgsql security definer set search_path = public as $$
declare p pallets; r text := nullif(trim(lower(coalesce(p_reason, ''))), '');
begin
  perform require_staff();
  select * into p from pallets where id = p_pallet_id for update;
  if not found then raise exception 'Pallet not found'; end if;
  if p_weight is null or p_weight < 0 then raise exception 'Enter a weight of 0 or more'; end if;
  if r is not null and r not in ('drying','scale','waste','entry') then raise exception 'Pick a reason'; end if;
  insert into events(user_email, type, pallet_id, lbs, note, details)
  values (current_email(), 'weight_adjust', p.id, p_weight, p_note,
          jsonb_strip_nulls(jsonb_build_object('from', p.current_weight, 'to', p_weight, 'reason', r,
                                               'diff', case when p.current_weight is not null then p_weight - p.current_weight end, 'product', p.product)));
  update pallets set current_weight = p_weight, og_weight = coalesce(og_weight, p_weight), updated_at = now()
   where id = p.id returning * into p;
  return p;
end $$;
revoke all on function adjust_weight(bigint, numeric, text, text) from public, anon;
grant execute on function adjust_weight(bigint, numeric, text, text) to authenticated;

-- ---------- splits / merges keep machine trimmed ----------
create or replace function pallet_child_product() returns trigger
language plpgsql security definer set search_path = public as $$
declare par pallets;
begin
  if new.parent_id is not null and new.run_id is null then
    select * into par from pallets where id = new.parent_id;
    if par.id is not null then
      new.product := par.product; new.crop_year := coalesce(new.crop_year, par.crop_year);
      new.from_harvest := coalesce(new.from_harvest, par.from_harvest); new.processor_id := coalesce(new.processor_id, par.processor_id);
      new.machine_trimmed := coalesce(par.machine_trimmed, false);
    end if;
  end if;
  return new;
end $$;

create or replace function pallet_merge_product() returns trigger
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if new.merged_into is not null and old.merged_into is distinct from new.merged_into then
    select count(distinct product) into n from pallets where merged_into = new.merged_into;
    if n > 1 then raise exception 'Only the same product can be merged (fresh frozen, bucked, standards...)'; end if;
    update pallets set product = new.product, crop_year = coalesce(crop_year, new.crop_year), from_harvest = coalesce(from_harvest, new.from_harvest),
                       machine_trimmed = machine_trimmed or coalesce(new.machine_trimmed, false)
     where id = new.merged_into and (product is distinct from new.product or crop_year is null or (coalesce(new.machine_trimmed, false) and not machine_trimmed));
  end if;
  return new;
end $$;

-- dry merges: one crop year only (METRC item is per crop)
create or replace function pallet_merge_crop() returns trigger
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if new.merged_into is not null and old.merged_into is distinct from new.merged_into and coalesce(new.product, 'fresh_frozen') <> 'fresh_frozen' then
    select count(distinct crop_year) into n from pallets where merged_into = new.merged_into and crop_year is not null;
    if n > 1 then raise exception 'Only one crop year can be merged for dry product'; end if;
  end if;
  return new;
end $$;
drop trigger if exists pallet_merge_crop on pallets;
create trigger pallet_merge_crop after update of merged_into on pallets for each row execute function pallet_merge_crop();

-- ---------- METRC to-do: weight reasons and Remove ----------
create or replace function _comp_queue_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare a text; lic text; p pallets; s text; fs text; ts text; due timestamptz;
begin
  if new.pallet_id is not null then select * into p from pallets where id = new.pallet_id; end if;
  if new.type = 'move' and p.id is not null then
    select f.site into fs from slots x join freezers f on f.id = x.freezer_id where x.id = new.from_slot_id;
    select f.site into ts from slots x join freezers f on f.id = x.freezer_id where x.id = new.to_slot_id;
  end if;
  a := case new.type
    when 'harvested' then case when coalesce((new.details ->> 'pushed')::boolean, true) and coalesce(p.pushed, true) then 'Create package from harvest' end
    when 'pushed' then 'Create package from harvest'
    when 'harvest_plants' then case when coalesce((new.details ->> 'dry')::boolean, false) then 'Harvest plants (dry, wet weight)' else 'Harvest plants into batch (wet weight)' end
    when 'harvest_waste' then 'Record harvest waste'
    when 'harvest_finish' then 'Finish harvest'
    when 'proc_wet' then 'Create wet package from harvest'
    when 'created' then 'New package entered by hand'
    when 'split_from' then 'New package (split)'
    when 'merge' then 'Combine packages'
    when 'weight_adjust' then case when coalesce(p.pushed, true) then 'Adjust package weight' ||
           coalesce(' (' || case new.details ->> 'reason' when 'drying' then 'Drying' when 'scale' then 'Scale variance' when 'waste' then 'Waste' when 'entry' then 'Entry error' end || ')', '') end
    when 'removed' then case when not coalesce(p.pushed, true) then null
           when new.details ->> 'reason' = 'used' then 'Adjust to 0 and finish package'
           when new.details ->> 'reason' = 'shipped' then 'Check it left on a METRC manifest (shipped outside the app)' end
    when 'tag_set' then case when not coalesce(p.pushed, true) then null when new.details ->> 'from' is null then 'Tag a pending package' else 'Change package tag' end
    when 'proc_output' then 'Create package from processing run'
    when 'proc_used' then 'Use package in processing run'
    when 'proc_run_done' then 'Record run waste / moisture loss'
    when 'proc_sent' then 'Transfer to drying processor (manifest)'
    when 'proc_received' then 'Receive back from drying processor'
    when 'shipped' then 'Ship to customer (transfer manifest)'
    when 'received' then 'Transfer between licenses'
    when 'move' then case when fs is not null and ts is not null and fs <> ts and coalesce(p.pushed, true) then 'Transfer manifest needed (' || fs || ' > ' || ts || ')' end
    else null end;
  if a is null then return new; end if;
  lic := case
    when new.type in ('harvested', 'proc_wet', 'pushed', 'harvest_plants', 'harvest_waste', 'harvest_finish') then coalesce(comp_site_cult_license(new.details ->> 'site'), comp_pallet_license(new.pallet_id))
    when new.type = 'move' then comp_site_cult_license(fs)
    when new.pallet_id is not null then comp_pallet_license(new.pallet_id)
    else null end;
  due := nullif(new.details ->> 'due', '')::timestamptz;
  s := concat_ws(' · ', p.code, coalesce(p.strain, new.details ->> 'strain'), new.details ->> 'batch', coalesce(new.details ->> 'run', null), coalesce(new.details ->> 'processor', null), coalesce(new.details ->> 'load', null),
                 case when new.type = 'merge' then 'from ' || (select string_agg(v, ', ') from jsonb_array_elements_text(coalesce(new.details -> 'sources', '[]')) v) end,
                 case when new.type = 'proc_run_done' then concat_ws(' ', new.details ->> 'kind', new.details ->> 'strain') end,
                 case when new.type = 'harvest_plants' then (new.details ->> 'plants') || ' plants, ' || (new.details ->> 'wet_lbs') || ' lbs wet' end,
                 case when new.type = 'harvest_waste' then 'wet ' || (new.details ->> 'wet_lbs') || ' - packaged ' || (new.details ->> 'packed_lbs') end);
  insert into comp_metrc_actions (event_id, at, license, action, pallet_id, code, tag, lbs, summary, details, due_at, harvest_id)
  values (new.id, new.at, lic, a, new.pallet_id, p.code,
          case when new.type in ('weight_adjust', 'removed') then coalesce(p.package_tag, new.details ->> 'tag') else coalesce(new.details ->> 'tag', case when new.type = 'tag_set' then new.details ->> 'to' end, p.package_tag) end,
          new.lbs, nullif(s, ''),
          jsonb_strip_nulls(new.details || jsonb_build_object('type', new.type, 'by', new.user_email, 'note', new.note)),
          due, nullif(new.details ->> 'harvest_id', '')::bigint)
  on conflict (event_id) do nothing;
  return new;
exception when others then return new;   -- never block the real action
end $$;

select 'adjust_weight with reason' as ok, count(*) from pg_proc where proname = 'adjust_weight' and pronargs = 4;
