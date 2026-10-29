-- 102: fulfill orders from "Needs a spot" packages (received at a site, not in a freezer slot yet).
--  * Assigning a pallet to an order line (pick_pallet) and combining for a line (combine_for_line) take packages that are
--    in a freezer OR waiting for a spot.
--  * Taking part of one (pick_part, through split_pallet): the piece also waits for a spot at the same site.
--  * Combining only "Needs a spot" packages: the new package waits for a spot at the first one's site.
-- Loading them on a truck already worked (045). Mixed pallets still need packages that are in a freezer.
-- Run once in Supabase after 101. Safe to re-run. If it says "tell Claude", nothing was changed.
begin;

do $$
declare d text; n int := 0;
  old_chk text := 'if p.status <> ''in_freezer'' then raise exception ''% isn''''t in a freezer'', p.code; end if;';
  new_chk text := 'if p.status not in (''in_freezer'', ''unslotted'') then raise exception ''% isn''''t in a freezer or waiting for a spot'', p.code; end if;';
begin
  -- pick_pallet
  select pg_get_functiondef('pick_pallet(int, bigint)'::regprocedure) into d;
  if position(new_chk in d) = 0 then
    if position(old_chk in d) = 0 then raise exception 'pick_pallet has changed: tell Claude (nothing was changed)'; end if;
    execute replace(d, old_chk, new_chk); n := n + 1;
  end if;

  -- combine_for_line (the body is combine_for_line_068; combine_for_line checks they're all at one site first)
  select pg_get_functiondef('combine_for_line_068(int, jsonb, text, boolean, int)'::regprocedure) into d;
  if position(new_chk in d) = 0 then
    if position(old_chk in d) = 0
       or position('perform slot_ok(dest, true);' in d) = 0
       or position('tag, ''in_freezer'', dest, tag is null,' in d) = 0
       or position('returning * into n;' in d) = 0 then raise exception 'combine_for_line_068 has changed: tell Claude (nothing was changed)'; end if;
    d := replace(d, old_chk, new_chk);
    d := replace(d, 'perform slot_ok(dest, true);', 'if dest is not null then perform slot_ok(dest, true); end if;');
    d := replace(d, 'tag, ''in_freezer'', dest, tag is null,', 'tag, case when dest is null then ''unslotted'' else ''in_freezer'' end, dest, tag is null,');
    d := replace(d, 'returning * into n;', 'returning * into n;
  if n.slot_id is null then   -- all from "Needs a spot": the new package waits at the first one''s site
    update pallets set received_site = (select x.received_site from pallets x where x.id = (p_sources->0->>''pallet_id'')::bigint)
     where id = n.id returning * into n;
  end if;');
    execute d; n := n + 1;
  end if;

  -- split_pallet (Part... in Fulfillment, and splits on the map): a piece of a "Needs a spot" package waits at the same site
  select pg_get_functiondef('split_pallet(bigint, numeric, text, boolean, int, text, boolean, boolean)'::regprocedure) into d;
  if position('piece of a "Needs a spot"' in d) = 0 then
    if position('if dest is null then raise exception ''Pick the freezer spot the piece goes to''; end if;' in d) = 0
       or position('perform slot_ok(dest, p_share or dest = p.slot_id, array[p.id]);' in d) = 0
       or position('tag, p.id, case when keep then p.status else ''in_freezer'' end, dest, tag is null,' in d) = 0
       or position('returning * into child;' in d) = 0 then raise exception 'split_pallet has changed: tell Claude (nothing was changed)'; end if;
    d := replace(d, 'if dest is null then raise exception ''Pick the freezer spot the piece goes to''; end if;',
                    'if dest is null and p.status <> ''unslotted'' then raise exception ''Pick the freezer spot the piece goes to''; end if;');
    d := replace(d, 'perform slot_ok(dest, p_share or dest = p.slot_id, array[p.id]);',
                    'if dest is not null then perform slot_ok(dest, p_share or dest = p.slot_id, array[p.id]); end if;');
    d := replace(d, 'tag, p.id, case when keep then p.status else ''in_freezer'' end, dest, tag is null,',
                    'tag, p.id, case when keep then p.status when dest is null then ''unslotted'' else ''in_freezer'' end, dest, tag is null,');
    d := replace(d, 'returning * into child;', 'returning * into child;
  if child.status = ''unslotted'' then   -- piece of a "Needs a spot" package: waits at the same site
    update pallets set received_site = p.received_site where id = child.id returning * into child;
  end if;');
    execute d; n := n + 1;
  end if;

  raise notice '% functions updated', n;
end $$;

commit;

select position('waiting for a spot' in pg_get_functiondef('pick_pallet(int, bigint)'::regprocedure)) > 0 as pick_pallet,
       position('waiting for a spot' in pg_get_functiondef('combine_for_line_068(int, jsonb, text, boolean, int)'::regprocedure)) > 0 as combine_for_line,
       position('piece of a "Needs a spot"' in pg_get_functiondef('split_pallet(bigint, numeric, text, boolean, int, text, boolean, boolean)'::regprocedure)) > 0 as split_pallet;
