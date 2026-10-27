-- 080_farm_plant_reconcile.sql: farm plants reconcile (Compliance > METRC > Reconcile > Farm plants).
-- Per strain on a farm license: plants the app says are in the field (planted, less harvested) next to what METRC has
-- (immature in plant batches + flowering), and harvested plants in each. Per harvest: the app harvest next to its METRC harvest.
-- Also: Plants in field is already net of plant loss (the workbook works it out that way), so the flip and its tag run use it as is.
-- Run after 079. Re-runnable.
set client_min_messages = warning;

-- farm (cultivation) licenses, for the reconcile picker
create or replace function comp_farm_licenses() returns table (license text, site text)
language sql stable security definer set search_path = public as $$
  select l.license_no, l.site from licenses l where l.active and l.kind = 'cultivation' and comp_can_read() order by l.site, l.license_no
$$;
revoke all on function comp_farm_licenses() from public, anon;
grant execute on function comp_farm_licenses() to authenticated;

-- the farm license a planting / harvest belongs to
create or replace function farm_license_of(p_site text, p_license text default null) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(trim(p_license), ''), comp_site_cult_license(p_site))
$$;

create or replace function comp_reconcile_plants(p_license text, p_year int default null) returns table (
  strain text, metrc_strain text, fields text, metrc_locations text, plantings int,
  planted int, app_harvested int, app_live int,
  metrc_immature int, metrc_flowering int, metrc_live int, metrc_harvested int, metrc_counted timestamptz,
  diff int, issue text, note text)
language plpgsql stable security definer set search_path = public as $$
declare y int := coalesce(p_year, crop_year()); since date := make_date(coalesce(p_year, crop_year()), 1, 1); by_strain boolean;
begin
  if not comp_can_read() then raise exception 'Only Compliance can see this'; end if;
  by_strain := exists (select 1 from metrc_plant_counts c where c.license = p_license and c.phase = 'flowering' and c.run = 'live' and c.strain <> '');
  return query
  with pl as (
    select p.id, p.strain as app_strain, coalesce(metrc_strain_for(p.strain, p_license) ->> 'name', p.strain) as ms,
           coalesce(p.plants, 0) as plants, (select f.name from fields f where f.id = p.field_id) as field
      from cult_plantings p
     where p.crop_year = y and farm_license_of(p.site, p.license) = p_license and coalesce(p.plants, 0) > 0),
  hv as (
    select lower(coalesce(pl.ms, coalesce(metrc_strain_for(coalesce(h.planted_strain, h.strain), p_license) ->> 'name', h.strain))) as k,
           sum(coalesce(h.plants_harvested, h.plants, 0))::int as n
      from cult_harvests h left join pl on pl.id = h.planting_id
     where h.crop_year = y and h.status = 'done' and farm_license_of(h.site) = p_license
     group by 1),
  app as (
    select lower(pl.ms) as k, min(pl.ms) as ms, string_agg(distinct pl.app_strain, ', ') as app_strain, string_agg(distinct pl.field, ', ') as fields,
           count(*)::int as plantings, sum(pl.plants)::int as planted
      from pl group by 1),
  imm as (
    select lower(b.strain) as k, min(b.strain) as ms, sum(coalesce(b.untracked, 0))::int as n, string_agg(distinct b.location, ', ') as locs
      from metrc_plant_batches b where b.license = p_license and b.state = 'active' and coalesce(b.untracked, 0) > 0 group by 1),
  flw as (
    select lower(c.strain) as k, min(c.strain) as ms, sum(c.plants)::int as n, string_agg(distinct c.location, ', ') as locs, max(c.seen_at) as at
      from metrc_plant_counts c where c.license = p_license and c.phase in ('flowering', 'vegetative') and c.run = 'live' and c.strain <> '' group by 1),
  mh as (
    select lower(trim(s)) as k, min(trim(s)) as ms, sum(h.plant_count)::int as n
      from metrc_harvests h, unnest(string_to_array(coalesce(h.strains, ''), ',')) s
     where h.license = p_license and h.started >= since and trim(s) <> '' group by 1),
  ks as (select k from app union select k from imm union select k from flw union select k from mh union select k from hv),
  j as (
    select coalesce(app.app_strain, imm.ms, flw.ms, mh.ms) as strain, coalesce(app.ms, imm.ms, flw.ms, mh.ms) as ms, app.fields,
           nullif(concat_ws(', ', imm.locs, flw.locs), '') as locs, coalesce(app.plantings, 0) as plantings, coalesce(app.planted, 0) as planted,
           coalesce((select hv.n from hv where hv.k = ks.k), 0) as ah,
           coalesce(imm.n, 0) as mi, case when by_strain then coalesce(flw.n, 0) end as mf, coalesce(mh.n, 0) as mhn, flw.at
      from ks left join app on app.k = ks.k left join imm on imm.k = ks.k left join flw on flw.k = ks.k left join mh on mh.k = ks.k)
  select j.strain, j.ms, j.fields, j.locs, j.plantings, j.planted, j.ah, greatest(j.planted - j.ah, 0),
         j.mi, j.mf, j.mi + coalesce(j.mf, 0), j.mhn, j.at,
         greatest(j.planted - j.ah, 0) - (j.mi + coalesce(j.mf, 0)),
         case
           when j.mf is null then 'not_counted'
           when j.planted = 0 then 'not_in_app'
           when j.mi + j.mf + j.mhn = 0 then 'not_in_metrc'
           when abs(greatest(j.planted - j.ah, 0) - (j.mi + j.mf)) <= greatest(5, round(j.planted * 0.01)) and abs(j.ah - j.mhn) <= greatest(5, round(j.planted * 0.01)) then 'ok'
           when abs(greatest(j.planted - j.ah, 0) - (j.mi + j.mf)) <= greatest(5, round(j.planted * 0.01)) then 'harvest_count'
           when j.ah > j.mhn and (j.mi + j.mf) > greatest(j.planted - j.ah, 0) then 'harvest_behind'
           when j.mi > 0 and j.mi >= (j.mi + j.mf) - greatest(5, round(j.planted * 0.01)) and j.planted - j.ah > 0 and j.mf = 0 then 'not_flipped'
           when (j.mi + j.mf + j.mhn) < j.planted then 'short'
           else 'over' end,
         case
           when j.mf is null then 'Flowering plants not counted by strain yet: Count plants now'
           when j.planted = 0 then 'METRC has this strain, no planting in the app this season'
           when j.mi + j.mf + j.mhn = 0 then 'Planted in the app, nothing in METRC'
           when abs(greatest(j.planted - j.ah, 0) - (j.mi + j.mf)) <= greatest(5, round(j.planted * 0.01))
             then 'Standing plants match; harvested plants differ: app ' || j.ah || ', METRC ' || j.mhn
           when j.ah > j.mhn and (j.mi + j.mf) > greatest(j.planted - j.ah, 0)
             then (j.ah - j.mhn) || ' plants harvested in the app are still standing in METRC'
           when (j.mi + j.mf + j.mhn) < j.planted then 'METRC has ' || (j.planted - (j.mi + j.mf + j.mhn)) || ' fewer plants than the app planted'
           when (j.mi + j.mf + j.mhn) > j.planted then 'METRC has ' || ((j.mi + j.mf + j.mhn) - j.planted) || ' more plants than the app planted' end
    from j
   order by abs(greatest(j.planted - j.ah, 0) - (j.mi + coalesce(j.mf, 0))) desc, j.strain;
end $$;
revoke all on function comp_reconcile_plants(text, int) from public, anon;
grant execute on function comp_reconcile_plants(text, int) to authenticated;

-- each harvest: the app next to METRC (matched on the METRC harvest name the app keeps)
create or replace function comp_reconcile_farm_harvests(p_license text, p_year int default null) returns table (
  harvest_id bigint, metrc_id bigint, name text, strain text, field text, harvested_on date, kind text,
  app_plants int, metrc_plants int, app_wet numeric, metrc_wet numeric, metrc_left numeric, metrc_packaged numeric, metrc_finished boolean,
  issue text, note text)
language plpgsql stable security definer set search_path = public as $$
declare y int := coalesce(p_year, crop_year()); since date := make_date(coalesce(p_year, crop_year()), 1, 1);
begin
  if not comp_can_read() then raise exception 'Only Compliance can see this'; end if;
  return query
  with ah as (
    select h.id, upper(trim(h.metrc_name)) as nm, h.metrc_name, coalesce(h.planted_strain, h.strain) as strain, (select f.name from fields f where f.id = h.field_id) as field,
           h.harvested_on, h.kind, coalesce(h.plants_harvested, h.plants)::int as plants, coalesce(h.metrc_wet_lbs, h.raw_lbs, h.ff_lbs) as wet
      from cult_harvests h where h.crop_year = y and h.status = 'done' and farm_license_of(h.site) = p_license),
  mh as (select m.*, upper(trim(m.name)) as nm from metrc_harvests m where m.license = p_license and m.started >= since)
  select ah.id, mh.id, coalesce(ah.metrc_name, mh.name), coalesce(ah.strain, mh.strains), ah.field, coalesce(ah.harvested_on, mh.started), ah.kind,
         ah.plants, mh.plant_count, round(ah.wet, 1), round(mh.wet, 1), round(mh.current, 1), round(mh.packaged, 1), mh.finished,
         case when ah.id is null then 'not_in_app'
              when ah.nm is null then 'no_name'
              when mh.id is null then 'not_in_metrc'
              when coalesce(ah.plants, 0) <> coalesce(mh.plant_count, 0) then 'plants'
              when ah.wet is not null and abs(ah.wet - coalesce(mh.wet, 0)) > greatest(1, ah.wet * 0.005) then 'weight'
              when not coalesce(mh.finished, false) and coalesce(mh.current, 0) > 0.5 then 'open'
              else 'ok' end,
         case when ah.id is null then 'METRC harvest no app harvest points to'
              when ah.nm is null then 'The app harvest has no METRC harvest name'
              when mh.id is null then 'No METRC harvest named ' || ah.metrc_name || ' on ' || p_license
              when coalesce(ah.plants, 0) <> coalesce(mh.plant_count, 0) then 'App ' || coalesce(ah.plants, 0) || ' plants, METRC ' || coalesce(mh.plant_count, 0)
              when ah.wet is not null and abs(ah.wet - coalesce(mh.wet, 0)) > greatest(1, ah.wet * 0.005) then 'App ' || round(ah.wet, 1) || ' lb wet, METRC ' || round(coalesce(mh.wet, 0), 1)
              when not coalesce(mh.finished, false) and coalesce(mh.current, 0) > 0.5 then round(mh.current, 1) || ' lb still unpackaged in METRC (not finished)' end
    from ah full join mh on mh.nm = ah.nm
   order by coalesce(ah.harvested_on, mh.started) desc nulls last;
end $$;
revoke all on function comp_reconcile_farm_harvests(text, int) from public, anon;
grant execute on function comp_reconcile_farm_harvests(text, int) to authenticated;

-- the flip: Plants in field is already net of loss
create or replace function cult_flip(p_planting bigint, p_on date default null) returns cult_plantings
language plpgsql security definer set search_path = public as $$
declare pl cult_plantings; n int; a tag_assignments;
begin
  perform require_module('cultivation'); perform no_view_as();
  if not can_edit('cultivation') then raise exception 'You can''t change plantings'; end if;
  select * into pl from cult_plantings where id = p_planting for update;
  if pl.id is null then raise exception 'Planting not found'; end if;
  if pl.flipped_on is not null then raise exception 'Already flipped to flowering on %', pl.flipped_on; end if;
  n := coalesce(pl.plants, 0);
  if n <= 0 then raise exception 'No plants in this planting'; end if;
  select * into a from tag_assignments where planting_id = pl.id and purpose = 'flower' and active;
  if a.id is null then raise exception 'Pick the flowering tag run first (one tag per plant)'; end if;
  if a.tags <> n then raise exception 'The flowering tag run has % tags and the planting has % plants. Pick the run again.', a.tags, n; end if;
  update cult_plantings set flipped_on = coalesce(p_on, current_date), flipped_by = current_email(), updated_by = current_email(), updated_at = now()
   where id = pl.id returning * into pl;
  insert into events (user_email, type, note, details)
  values (current_email(), 'planting_flip', pl.strain,
          jsonb_strip_nulls(jsonb_build_object('planting_id', pl.id, 'site', pl.site, 'field_id', pl.field_id, 'field', (select name from fields where id = pl.field_id),
                             'strain', pl.strain, 'plants', n, 'on', pl.flipped_on, 'first_tag', a.first_label, 'last_tag', a.last_label)));
  return pl;
end $$;
revoke all on function cult_flip(bigint, date) from public, anon;
grant execute on function cult_flip(bigint, date) to authenticated;

select '080 farm plant reconcile' as ok;
