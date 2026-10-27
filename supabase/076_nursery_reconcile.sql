-- 076_nursery_reconcile.sql: Compliance > METRC > Reconcile > Nursery (1PN).
-- Clone (and seed) packages in METRC against the cutting batches that carry their tag, and mother lots in METRC
-- (immature plant batches) against the mother lots in the app. Read only. Run after 075. Re-runnable.
set client_min_messages = warning;

create or replace function comp_reconcile_nursery() returns table (
  kind text, issue text, tag text, strain text, name text, app_n int, metrc_n numeric, metrc_item text, metrc_location text,
  metrc_state text, ref_id bigint, note text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not comp_can_read() then raise exception 'Only Compliance can see this'; end if;
  return query
  with lic as (select license from nursery_sites where license is not null),
  -- cutting batches: what should still be in each clone package
  b as (
    select x.id, upper(x.tags[1]) as tg, x.strain, coalesce(x.name, 'Batch ' || x.id) as nm, x.stage,
           greatest(0, coalesce(x.cuttings, 0) - coalesce(x.lost, 0)
                       - coalesce((select sum(d.plants) from nursery_deliveries d where d.batch_id = x.id), 0)
                       - coalesce((select sum(m.qty + m.lost) from nursery_mothers m where m.batch_id = x.id), 0))::int as left_n
      from nursery_batches x where coalesce(x.cuttings, 0) > 0),
  -- METRC packages counted in each (clones, seeds) on the nursery licenses
  p as (
    select upper(k.label) as tg, k.qty, k.item, k.location, k.state from metrc_packages k
     where k.license in (select license from lic) and (k.uom ~* '^(ea|each)' or (k.lbs is null and k.qty is not null))),
  pa as (select * from p where state in ('active', 'intransit')),
  -- mother lots
  m as (select x.id, upper(x.plant_tag) as tg, x.strain, x.status, greatest(0, x.qty - x.lost)::int as live_n,
               (select r.name from nursery_rooms r where r.id = x.room_id) as room
          from nursery_mothers x),
  mb as (select upper(coalesce(y.name, '')) as tg, y.untracked, y.strain, y.location, y.type from metrc_plant_batches y
          where y.license in (select license from lic) and y.state = 'active')
  -- clones
  select 'clones', 'count', b.tg, b.strain, b.nm, b.left_n, pa.qty, pa.item, pa.location, pa.state, b.id,
         case when b.left_n = 0 then 'Nothing left in the app (delivered, planted or lost); still in METRC' end
    from b join pa on pa.tg = b.tg where round(pa.qty) <> b.left_n
  union all
  select 'clones', 'not_in_metrc', b.tg, b.strain, b.nm, b.left_n, null, null, null,
         (select p.state from p where p.tg = b.tg limit 1), b.id,
         case when exists (select 1 from p where p.tg = b.tg) then 'METRC has it ' || (select p.state from p where p.tg = b.tg limit 1)
              else 'Never made in METRC (or not pulled yet)' end
    from b where b.tg is not null and b.left_n > 0 and not exists (select 1 from pa where pa.tg = b.tg)
  union all
  select 'clones', 'no_tag', null, b.strain, b.nm, b.left_n, null, null, null, null, b.id, 'The batch has no clone package tag in the app'
    from b where b.tg is null and b.left_n > 0 and b.stage not in ('done', 'cancelled')
  union all
  select 'clones', 'not_in_app', pa.tg, null, null, null, pa.qty, pa.item, pa.location, pa.state, null,
         case when pa.item ~* 'seed' then 'Seed package: not tracked in the app yet' else 'No cutting batch has this tag' end
    from pa where not exists (select 1 from b where b.tg = pa.tg)
  -- mother lots
  union all
  select 'mothers', 'count', m.tg, m.strain, m.room, m.live_n, mb.untracked, mb.type, mb.location, 'active', m.id, null
    from m join mb on mb.tg = m.tg where m.status = 'active' and coalesce(mb.untracked, 0) <> m.live_n
  union all
  select 'mothers', 'not_in_metrc', m.tg, m.strain, m.room, m.live_n, null, null, null, null, m.id, 'No active METRC plant batch with this tag'
    from m where m.status = 'active' and m.tg is not null and m.live_n > 0 and not exists (select 1 from mb where mb.tg = m.tg)
  union all
  select 'mothers', 'no_tag', null, m.strain, m.room, m.live_n, null, null, null, null, m.id, 'The mother lot has no plant tag in the app'
    from m where m.status = 'active' and m.tg is null and m.live_n > 0
  union all
  select 'mothers', 'closed_in_app', m.tg, m.strain, m.room, 0, mb.untracked, mb.type, mb.location, 'active', m.id, 'Lot is ' || m.status || ' in the app, still active in METRC'
    from m join mb on mb.tg = m.tg where m.status <> 'active' and coalesce(mb.untracked, 0) > 0
      and not exists (select 1 from m m2 where m2.tg = m.tg and m2.status = 'active')
  union all
  select 'mothers', 'not_in_app', mb.tg, mb.strain, null, null, mb.untracked, mb.type, mb.location, 'active', null, 'No mother lot in the app has this tag'
    from mb where coalesce(mb.untracked, 0) > 0 and not exists (select 1 from m where m.tg = mb.tg);
end $$;
revoke all on function comp_reconcile_nursery() from public, anon;
grant execute on function comp_reconcile_nursery() to authenticated;

select '076 nursery reconcile' as ok;
