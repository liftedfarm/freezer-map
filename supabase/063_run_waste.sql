-- 063: METRC to-do for a finished processing run
-- * "Record run waste / moisture loss" = everything that went in minus everything that came out
--   (moisture loss + mold/refuse). It used to show the output weight.
-- * Run steps ("Use package in processing run", "Record run waste") get the license of the run's output packages
--   (the inputs are already used up when the step is queued, so they had no license).
-- * Fixes the to-dos already queued that are still open.
-- Safe to run twice.

set client_min_messages = warning;

do $$
declare d text;
begin
  select pg_get_functiondef('_comp_queue_event()'::regprocedure) into d;

  if position('063 run waste' in d) = 0 then
    if position('          new.lbs, nullif(s, ''''),' in d) = 0 then raise exception '_comp_queue_event: lbs patch point not found'; end if;
    d := replace(d, '          new.lbs, nullif(s, ''''),',
      '          case when new.type = ''proc_run_done'' then coalesce(nullif(new.details ->> ''in'', '''')::numeric - nullif(new.details ->> ''out'', '''')::numeric, new.lbs) else new.lbs end, nullif(s, ''''),  -- 063 run waste');

    if position('    when new.type = ''move'' then comp_site_cult_license(fs)' in d) = 0 then raise exception '_comp_queue_event: license patch point not found'; end if;
    d := replace(d, '    when new.type = ''move'' then comp_site_cult_license(fs)',
      '    when new.type in (''proc_used'', ''proc_run_done'') then coalesce((select comp_pallet_license(x.id) from pallets x where x.run_id = nullif(new.details ->> ''run_id'', '''')::bigint order by x.id limit 1), comp_pallet_license(new.pallet_id))
    when new.type = ''move'' then comp_site_cult_license(fs)');

    if position('case when new.type = ''proc_run_done'' then concat_ws('' '', new.details ->> ''kind'', new.details ->> ''strain'') end,' in d) = 0 then raise exception '_comp_queue_event: summary patch point not found'; end if;
    d := replace(d, 'case when new.type = ''proc_run_done'' then concat_ws('' '', new.details ->> ''kind'', new.details ->> ''strain'') end,',
      'case when new.type = ''proc_run_done'' then concat_ws('' '', new.details ->> ''kind'', new.details ->> ''strain'') || '': in '' || (new.details ->> ''in'') || '' - out '' || (new.details ->> ''out'') || '' = waste '' || ((new.details ->> ''in'')::numeric - (new.details ->> ''out'')::numeric) || '' lbs (moisture '' || (new.details ->> ''loss'') || '', mold '' || coalesce(new.details ->> ''mold'', ''0'') || '')'' end,');
    execute d;
  end if;
end $$;

-- open run steps already on the to-do list
update comp_metrc_actions a
   set lbs = (e.details ->> 'in')::numeric - (e.details ->> 'out')::numeric,
       summary = concat_ws(' · ', e.details ->> 'run', concat_ws(' ', e.details ->> 'kind', e.details ->> 'strain') || ': in ' || (e.details ->> 'in') || ' - out ' || (e.details ->> 'out')
                 || ' = waste ' || ((e.details ->> 'in')::numeric - (e.details ->> 'out')::numeric) || ' lbs (moisture ' || (e.details ->> 'loss') || ', mold ' || coalesce(e.details ->> 'mold', '0') || ')')
  from events e
 where e.id = a.event_id and e.type = 'proc_run_done' and a.status = 'todo' and e.details ? 'in' and e.details ? 'out';

update comp_metrc_actions a
   set license = (select comp_pallet_license(x.id) from pallets x where x.run_id = (e.details ->> 'run_id')::bigint order by x.id limit 1)
  from events e
 where e.id = a.event_id and e.type in ('proc_used', 'proc_run_done') and a.status = 'todo' and a.license is null;

select 'ok' as run_waste_063;
