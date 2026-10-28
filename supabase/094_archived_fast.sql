-- 094: Archived screen timed out on the live data (the "tag also on another pallet" check scanned every pallet once per
-- archived pallet). Same result, now one pass over pallets and METRC packages. Run after 093_archived.sql. Safe to re-run.
create or replace function archived_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare rows jsonb; pulled timestamptz;
begin
  if not is_staff() then raise exception 'Staff only'; end if;
  select max(seen_at) into pulled from metrc_packages;
  with m as (
    select distinct on (upper(trim(label))) upper(trim(label)) as tag, license, state, lbs, qty, uom, item
      from metrc_packages where state in ('active', 'intransit')
     order by upper(trim(label)), (state = 'active') desc, seen_at desc
  ), dup as (
    select upper(trim(package_tag)) as tag, array_agg(id order by id) as ids, array_agg(code || ' (' || status || ')' order by id) as labels
      from pallets where nullif(trim(package_tag), '') is not null
     group by 1 having count(*) > 1
  ), a as (
    select p.id, p.code, p.strain, p.label, p.product, p.crop_year, p.harvest_date, p.current_weight, p.og_weight, p.package_tag, p.kind,
           p.notes, p.needs_review, p.updated_at, p.harvest_id, p.received_site, p.origin_site,
           m.license as m_license, m.state as m_state, coalesce(m.lbs, case when m.uom ilike 'pound%' or m.uom ilike 'lb%' then m.qty end) as m_lbs, m.item as m_item,
           (select l from unnest(d.ids, d.labels) x(i, l) where x.i <> p.id limit 1) as tag_on
      from pallets p
      left join m on m.tag = upper(trim(p.package_tag))
      left join dup d on d.tag = upper(trim(p.package_tag))
     where p.status = 'archived'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'code', a.code, 'strain', a.strain, 'label', a.label, 'product', a.product, 'crop_year', a.crop_year,
           'harvest_date', a.harvest_date, 'lbs', a.current_weight, 'og_lbs', a.og_weight, 'tag', a.package_tag, 'kind', a.kind,
           'notes', a.notes, 'needs_review', a.needs_review, 'updated_at', a.updated_at, 'harvest_id', a.harvest_id,
           'site', archived_site(a.code, a.received_site, a.origin_site, a.m_license),
           'metrc_license', a.m_license, 'metrc_state', a.m_state, 'metrc_lbs', a.m_lbs, 'metrc_item', a.m_item, 'tag_on', a.tag_on,
           'last', (select jsonb_build_object('at', e.at, 'by', e.user_email, 'type', e.type, 'note', e.note, 'reason', e.details ->> 'reason')
                      from events e where e.pallet_id = a.id order by e.id desc limit 1)
         ) order by (a.m_state is not null) desc, a.code), '[]') into rows
    from a;
  return jsonb_build_object('rows', rows, 'pulled', pulled,
    'can_restore', can_do('distribution', 'restore_pallet') and coalesce(mod_level('distribution'), '') <> 'view',
    'can_delete', can_do('distribution', 'delete_pallet') and coalesce(mod_level('distribution'), '') <> 'view');
end $$;

select 'archived_overview updated' as done;
