-- 110: merge (combine into one new tag) packages that are waiting on the Needs a spot card.
-- Before: merging needed a freezer slot for the new package, so two packages received at GVR couldn't be combined until
-- someone slotted them. Now, if none of them is in a slot (and none is on the truck), the new package waits on the
-- Needs a spot card at their site too. Merging in a freezer or on a load works as before.
-- Run once in Supabase after 109. Safe to re-run. If it says "tell Claude", nothing was changed.
begin;

do $$
declare d text;
  a1 text := 'if dest is null then raise exception ''Pick the freezer spot for the new package''; end if;
    if not exists (select 1 from unnest(src) x where x.slot_id = dest) then perform slot_ok(dest, false, p_ids); end if;';
  b1 text := '-- all waiting for a spot (110): the new package waits too
    if dest is null and exists (select 1 from unnest(src) x where x.status <> ''unslotted'') then raise exception ''Pick the freezer spot for the new package''; end if;
    if dest is not null and not exists (select 1 from unnest(src) x where x.slot_id = dest) then perform slot_ok(dest, false, p_ids); end if;';
  a2 text := 'tag, case when on_truck then ''in_transit'' else ''in_freezer'' end, dest, tag is null';
  b2 text := 'tag, case when on_truck then ''in_transit'' when dest is null then ''unslotted'' else ''in_freezer'' end, dest, tag is null';
  a3 text := 'update pallets set status = ''merged'', slot_id = null, merged_into = m.id, updated_at = now() where id = any(p_ids);';
  b3 text := 'if m.status = ''unslotted'' then
    update pallets set received_site = (select x.received_site from unnest(src) x where x.received_site is not null limit 1) where id = m.id returning * into m;
  end if;
  ' || a3;
begin
  select pg_get_functiondef('merge_pallets(bigint[], text, boolean, int, text)'::regprocedure) into d;
  if position('all waiting for a spot (110)' in d) > 0 then raise notice 'merge_pallets already takes Needs a spot packages'; return; end if;
  if position(a1 in d) = 0 or position(a2 in d) = 0 or position(a3 in d) = 0 then
    raise exception 'merge_pallets has changed: tell Claude (nothing was changed)';
  end if;
  execute replace(replace(replace(d, a1, b1), a2, b2), a3, b3);
  raise notice 'merge_pallets now takes Needs a spot packages';
end $$;

commit;

select position('all waiting for a spot (110)' in pg_get_functiondef('merge_pallets(bigint[], text, boolean, int, text)'::regprocedure)) > 0 as updated;
