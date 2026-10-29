-- 107: put "Needs a spot" packages on a mixed pallet (Fulfillment > Pack for the truck).
--  * Adding them to a mixed pallet already in a freezer: they go into its slot with it.
--  * Building a new mixed pallet: it goes in the slot of the first ticked package that has one. If none of them is in a
--    slot, the mixed pallet waits on the Needs a spot card at their site (same as the packages).
--  * Adding to a mixed pallet that's waiting for a spot works too.
-- Run once in Supabase after 106. Safe to re-run. If it says "tell Claude", nothing was changed.
begin;

do $$
declare d text;
  a1 text := 'select slot_id into dest from pallets where pallets.id = p_pallets[1];';
  b1 text := 'select slot_id into dest from pallets where pallets.id = any(p_pallets) and slot_id is not null order by array_position(p_pallets, pallets.id) limit 1;';
  a2 text := 'perform slot_ok(dest, true);';
  b2 text := 'if dest is not null then perform slot_ok(dest, true); end if;';
  a3 text := 'insert into pallets (code, kind, label, status, slot_id)
    values (''M'' || nextval(''mixed_pallet_seq''), ''mixed'', ''Mixed pallet'', ''in_freezer'', dest)';
  b3 text := 'insert into pallets (code, kind, label, status, slot_id, received_site)
    values (''M'' || nextval(''mixed_pallet_seq''), ''mixed'', ''Mixed pallet'', case when dest is null then ''unslotted'' else ''in_freezer'' end, dest,
            case when dest is null then (select x.received_site from pallets x where x.id = p_pallets[1]) end)';
  a4 text := 'if m.status <> ''in_freezer'' then raise exception ''% isn''''t in a freezer'', m.code; end if;';
  b4 text := 'if m.status not in (''in_freezer'', ''unslotted'') then raise exception ''% isn''''t in a freezer or waiting for a spot'', m.code; end if;';
begin
  select pg_get_functiondef('order_mixed_pallet_068(int, bigint[], bigint, int)'::regprocedure) into d;
  if position(b1 in d) > 0 then raise notice 'order_mixed_pallet already takes Needs a spot packages'; return; end if;
  if position(a1 in d) = 0 or position(a2 in d) = 0 or position(a3 in d) = 0 or position(a4 in d) = 0 then
    raise exception 'order_mixed_pallet_068 has changed: tell Claude (nothing was changed)';
  end if;
  d := replace(replace(replace(replace(d, a1, b1), a2, b2), a3, b3), a4, b4);
  execute d;
  raise notice 'order_mixed_pallet now takes Needs a spot packages';
end $$;

commit;

select position('array_position(p_pallets' in pg_get_functiondef('order_mixed_pallet_068(int, bigint[], bigint, int)'::regprocedure)) > 0 as updated;
