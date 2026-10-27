-- 072_reconcile_spot.sql: fix for 071 (freezers have no name column; the slot code has the freezer number). Re-runnable.

create or replace function comp_reconcile_live(p_license text) returns table (
  issue text, tag text, pallet_id bigint, code text, strain text, app_lbs numeric, metrc_lbs numeric, app_item text, metrc_item text,
  app_license text, metrc_location text, app_spot text, metrc_changed timestamptz, explain text, trail jsonb, note text)
language plpgsql stable security definer set search_path = public as $$
declare tol numeric; stale int;
begin
  if not comp_can_read() then raise exception 'Not allowed'; end if;
  tol := coalesce((select nullif(value, '')::numeric from app_settings where key = 'comp.weight_tol'), 1);
  stale := coalesce((select nullif(value, '')::int from app_settings where key = 'comp.stale_days'), 90);
  return query
  with live as (
    select p.*, comp_pallet_license(p.id) as lic from pallets p
     where p.status in ('in_freezer','unslotted') and coalesce(p.kind, '') <> 'mixed'
  ), m as (select * from metrc_packages x where x.license = p_license and x.state in ('active', 'intransit')),
  bytag as (select distinct on (upper(p.package_tag)) p.* from pallets p join m on upper(p.package_tag) = m.label
             order by upper(p.package_tag), (p.status in ('in_freezer','unslotted')) desc, p.id desc),
  spot as (select p.id, concat_ws(' ', f.site, s.code) as where_ from pallets p left join slots s on s.id = p.slot_id left join freezers f on f.id = s.freezer_id),
  rows_ as (
    select 'not_in_app'::text as issue, m.label as tag, null::bigint as pallet_id, null::text as code, m.item as strain, null::numeric as app_lbs, m.lbs as metrc_lbs,
           null::text as app_item, m.item as metrc_item, null::text as app_license, m.location as metrc_location, m.last_modified, m.source_harvests as note
      from m where not exists (select 1 from bytag b where upper(b.package_tag) = m.label)
    union all
    select 'closed_in_app', m.label, b.id, b.code, b.strain, b.current_weight, m.lbs, i.metrc_name, m.item, null, m.location, m.last_modified, 'App says ' || b.status
      from m join bytag b on upper(b.package_tag) = m.label left join items i on i.id = b.item_id
     where b.status not in ('in_freezer','unslotted','in_transit')
    union all
    select 'not_in_metrc', upper(l.package_tag), l.id, l.code, l.strain, l.current_weight, null, i.metrc_name, null, l.lic, null, null, null
      from live l left join items i on i.id = l.item_id
     where l.lic = p_license and l.package_tag is not null and not coalesce(l.tag_pending, false)
       and not exists (select 1 from m where m.label = upper(l.package_tag))
    union all
    select 'other_license', m.label, l.id, l.code, l.strain, l.current_weight, m.lbs, null, m.item, l.lic, m.location, m.last_modified, 'METRC: ' || p_license
      from m join live l on upper(l.package_tag) = m.label where l.lic is distinct from p_license
    union all
    select 'weight', m.label, l.id, l.code, l.strain, l.current_weight, m.lbs, null, null, l.lic, m.location, m.last_modified,
           case when l.current_weight > m.lbs then 'METRC is ' || round(l.current_weight - m.lbs, 2) || ' lb lower' else 'METRC is ' || round(m.lbs - l.current_weight, 2) || ' lb higher' end
      from m join live l on upper(l.package_tag) = m.label where m.lbs is not null and abs(coalesce(l.current_weight, 0) - m.lbs) > tol
    union all
    select 'item', m.label, l.id, l.code, l.strain, null, null, i.metrc_name, m.item, l.lic, m.location, m.last_modified, null
      from m join live l on upper(l.package_tag) = m.label join items i on i.id = l.item_id
     where i.metrc_name is not null and m.item is not null and lower(trim(i.metrc_name)) <> lower(trim(m.item))
    union all
    select 'on_hold', m.label, b.id, b.code, b.strain, null, m.lbs, null, m.item, null, m.location, m.last_modified, concat_ws(' · ', case when m.on_hold then 'On hold' end, m.lab_state)
      from m left join bytag b on upper(b.package_tag) = m.label
     where m.on_hold or coalesce(m.lab_state, '') ~* 'fail'
    union all
    select 'tag_pending', null, l.id, l.code, l.strain, l.current_weight, null, null, null, l.lic, null, null, null
      from live l where l.lic = p_license and (coalesce(l.tag_pending, false) or l.package_tag is null)
    union all
    select 'stale', upper(l.package_tag), l.id, l.code, l.strain, l.current_weight, null, null, null, l.lic, null, null,
           'No change in ' || (current_date - coalesce((select max(e.at) from events e where e.pallet_id = l.id), l.created_at)::date) || ' days'
      from live l where l.lic = p_license
       and coalesce((select max(e.at) from events e where e.pallet_id = l.id), l.created_at) < now() - make_interval(days => stale)
  )
  select r.issue, r.tag, r.pallet_id, r.code, r.strain, r.app_lbs, r.metrc_lbs, r.app_item, r.metrc_item, r.app_license, r.metrc_location,
         (select sp.where_ from spot sp where sp.id = r.pallet_id), r.last_modified,
         case when r.tag is not null and r.issue in ('weight', 'not_in_metrc', 'closed_in_app') then metrc_trail_text(metrc_trail(r.tag)) end,
         case when r.tag is not null and r.issue in ('weight', 'not_in_metrc', 'closed_in_app') then metrc_trail(r.tag) end,
         r.note
    from rows_ r;
end $$;
revoke all on function comp_reconcile_live(text) from public, anon;
grant execute on function comp_reconcile_live(text) to authenticated;

select '072 reconcile spot' as ok;
