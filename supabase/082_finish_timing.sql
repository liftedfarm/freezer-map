-- 082: how long after Finish the harvest waste and the METRC finish wait, set in Compliance > Settings (hours; 0 = right away).
-- Applies to harvests finished after the change; to-dos already waiting keep their time (Send on a to-do still sends it now).

insert into app_settings (key, value) values ('comp.metrc_waste_hours', '48'), ('comp.metrc_finish_hours', '48')
on conflict (key) do nothing;

create or replace function app_setting_hours(p_key text) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select case when trim(value) ~ '^\d+(\.\d+)?$' then trim(value)::numeric end from app_settings where key = p_key), 48)
$$;

create or replace function comp_set_setting(p_key text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not comp_is_admin() then raise exception 'Only a Compliance Admin can change Compliance settings'; end if;
  if p_key not in ('comp.weight_tol', 'comp.stale_days', 'comp.sp_site', 'comp.sp_root',
                   'comp.metrc_live', 'comp.metrc_reason_drying', 'comp.metrc_reason_scale', 'comp.metrc_reason_waste', 'comp.metrc_reason_entry',
                   'comp.metrc_reason_used', 'comp.metrc_ttype_internal', 'comp.metrc_ttype_customer', 'comp.metrc_ttype_processor', 'comp.metrc_ttype_nursery',
                   'comp.metrc_phone', 'comp.metrc_transit_hours', 'comp.metrc_proc_driver', 'comp.metrc_proc_vehicle',
                   'comp.metrc_waste_type', 'comp.metrc_plant_waste_reason', 'comp.metrc_plant_adjust_reason',
                   'comp.metrc_cutover_OHR', 'comp.metrc_cutover_GVR', 'comp.metrc_cutover_1PN', 'comp.tag_autofill',
                   'comp.metrc_waste_hours', 'comp.metrc_finish_hours')
  then raise exception 'Unknown setting'; end if;
  if p_key in ('comp.metrc_live', 'comp.tag_autofill') and coalesce(trim(p_value), '') not in ('true', 'false') then raise exception 'true or false'; end if;
  if p_key like 'comp.metrc_cutover_%' and nullif(trim(p_value), '') is not null and trim(p_value) !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Cutover is a date (YYYY-MM-DD) or blank'; end if;
  if p_key in ('comp.metrc_transit_hours', 'comp.metrc_waste_hours', 'comp.metrc_finish_hours') and (nullif(trim(p_value), '') is null or trim(p_value) !~ '^\d+(\.\d+)?$') then raise exception 'Hours, a number'; end if;
  insert into app_settings (key, value) values (p_key, coalesce(trim(p_value), '')) on conflict (key) do update set value = excluded.value;
  if p_key in ('comp.sp_site', 'comp.sp_root') then update comp_docs set backed_up_at = null, sp_item_id = null, sp_path = null where backed_up_at is not null; end if;
  perform _comp_event('comp_setting', p_key, jsonb_build_object('key', p_key, 'value', p_value));
end $$;
revoke all on function comp_set_setting(text, text) from public, anon;
grant execute on function comp_set_setting(text, text) to authenticated;

create or replace function cult_finish(p_harvest bigint, p_plants int default null, p_notes text default null) returns void
language plpgsql security definer set search_path = public as $$
declare wh numeric := app_setting_hours('comp.metrc_waste_hours'); fh numeric := app_setting_hours('comp.metrc_finish_hours');
        h cult_harvests; packed numeric; waste numeric; d text; new_wet numeric; bad text;
begin
  perform require_module('cultivation'); perform no_view_as();
  select * into h from cult_harvests where id = p_harvest for update;
  if h.id is null then raise exception 'Harvest not found'; end if;
  if h.status = 'done' then raise exception 'This harvest is already finished'; end if;
  if p_plants is not null then update cult_harvests set plants_harvested = p_plants where id = h.id returning * into h; end if;
  if h.kind = 'ff' then
    select string_agg(code, ', ' order by id) into bad from pallets where harvest_id = h.id and not pushed and status <> 'archived';
    if bad is not null then raise exception 'Push every pallet before you finish (not pushed: %)', bad; end if;
    select coalesce(sum(lbs), 0) into new_wet from cult_weights where harvest_id = h.id and kind = 'raw' and not pushed;
    if new_wet > 0 or coalesce(h.plants_harvested, 0) > h.metrc_plants then
      d := cult_batch_name(h);
      insert into events (user_email, type, lbs, note, details)
      values (current_email(), 'harvest_plants', new_wet, d, jsonb_build_object('harvest_id', h.id, 'site', h.site, 'strain', h.strain, 'batch', d,
              'plants', greatest(coalesce(h.plants_harvested, 0) - h.metrc_plants, 0), 'wet_lbs', new_wet, 'day', h.day_no));
      update cult_weights set pushed = true where harvest_id = h.id and kind = 'raw' and not pushed;
      update cult_harvests set metrc_wet_lbs = metrc_wet_lbs + new_wet, metrc_plants = greatest(metrc_plants, coalesce(plants_harvested, 0)) where id = h.id returning * into h;
    end if;
    select coalesce(sum(og_weight), 0) into packed from pallets where harvest_id = h.id and pushed and status <> 'archived';
    waste := greatest(round(h.metrc_wet_lbs - packed, 2), 0);
    d := cult_batch_name(h);
    if h.metrc_wet_lbs > 0 then
      insert into events (user_email, type, lbs, note, details)
      values (current_email(), 'harvest_waste', waste, d, jsonb_build_object('harvest_id', h.id, 'site', h.site, 'strain', h.strain, 'batch', d,
              'wet_lbs', h.metrc_wet_lbs, 'packed_lbs', packed, 'due', now() + make_interval(secs => wh * 3600)));
      insert into events (user_email, type, note, details)
      values (current_email(), 'harvest_finish', d, jsonb_build_object('harvest_id', h.id, 'site', h.site, 'strain', h.strain, 'batch', d, 'due', now() + make_interval(secs => fh * 3600)));
    end if;
  elsif h.kind = 'dry' then
    -- dry flower: the wet weight goes into METRC; the wet package is made in Processing
    select coalesce(sum(lbs), 0) into new_wet from cult_weights where harvest_id = h.id and kind = 'raw' and not pushed;
    if new_wet > 0 then
      d := cult_batch_name(h);
      insert into events (user_email, type, lbs, note, details)
      values (current_email(), 'harvest_plants', new_wet, d, jsonb_build_object('harvest_id', h.id, 'site', h.site, 'strain', h.strain, 'batch', d,
              'plants', greatest(coalesce(h.plants_harvested, h.plants, 0) - h.metrc_plants, 0), 'wet_lbs', new_wet, 'day', h.day_no, 'dry', true));
      update cult_weights set pushed = true where harvest_id = h.id and kind = 'raw' and not pushed;
      update cult_harvests set metrc_wet_lbs = metrc_wet_lbs + new_wet, metrc_plants = coalesce(plants_harvested, plants, 0) where id = h.id returning * into h;
    end if;
  end if;
  update cult_harvests set status = 'done', stage = null, harvested_on = coalesce(harvested_on, current_date),
         plants_harvested = coalesce(plants_harvested, plants), waste_lbs = waste,
         notes = case when nullif(trim(p_notes), '') is null then notes else concat_ws(E'\n', notes, trim(p_notes)) end,
         updated_by = current_email(), updated_at = now()
   where id = h.id;
end $$;

select '082 finish timing' as ok;
