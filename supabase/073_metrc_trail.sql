-- 073_metrc_trail.sql: the trail lists each package once (one moved between our licenses is in METRC twice)
-- and shows the lbs shipped, not what is left. Re-runnable.

create or replace function metrc_trail(p_tag text) returns jsonb
language sql stable security definer set search_path = public as $$
  with ships as (
    select distinct on (tp.label, t.manifest) tp.label, tp.shipped_lbs, t.manifest, t.recipient_name, t.recipient_license,
           coalesce(t.departed_at, t.received_at, t.created_at) as shipped_at
      from metrc_transfer_packages tp join metrc_transfers t on t.delivery_id = tp.delivery_id
     where not t.voided
       and (tp.label = upper(p_tag) or tp.label in (select k.label from metrc_packages k where upper(p_tag) = any(k.source_labels)))
     order by tp.label, t.manifest
  ), kids as (
    -- one line per package made from this tag (a package moved between our licenses is in METRC twice)
    select distinct on (k.label) k.label, k.license, k.state, k.lbs, k.packaged_on, k.item from metrc_packages k
     where upper(p_tag) = any(k.source_labels) and k.label <> upper(p_tag)
     order by k.label, (k.state in ('active', 'intransit')) desc, k.last_modified desc nulls last
  )
  select jsonb_build_object(
    'kids', coalesce((select jsonb_agg(jsonb_build_object('tag', k.label, 'license', k.license, 'state', k.state,
              'lbs', coalesce((select s.shipped_lbs from ships s where s.label = k.label order by s.shipped_at limit 1), k.lbs),
              'packaged_on', k.packaged_on,
              'ship', (select jsonb_build_object('manifest', s.manifest, 'to', s.recipient_name, 'to_license', s.recipient_license, 'lbs', s.shipped_lbs, 'on', s.shipped_at::date)
                         from ships s where s.label = k.label order by s.shipped_at desc limit 1)) order by k.packaged_on, k.label) from kids k), '[]'),
    'ship', (select jsonb_build_object('manifest', s.manifest, 'to', s.recipient_name, 'to_license', s.recipient_license, 'lbs', s.shipped_lbs, 'on', s.shipped_at::date)
               from ships s where s.label = upper(p_tag) order by s.shipped_at desc limit 1),
    'self', (select jsonb_build_object('license', m.license, 'state', m.state, 'lbs', m.lbs, 'finished_on', m.finished_on, 'last_modified', m.last_modified, 'location', m.location)
               from metrc_packages m where m.label = upper(p_tag)
              order by (m.state in ('active', 'intransit')) desc, m.last_modified desc nulls last limit 1))
$$;
revoke all on function metrc_trail(text) from public, anon;
grant execute on function metrc_trail(text) to authenticated;

select '073 metrc trail' as ok;
