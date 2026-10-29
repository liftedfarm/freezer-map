-- 108: Depart without the extra steps.
--  1. No more "Pulled onto truck" step: Depart puts everything planned on the load onto the truck itself (each pallet is
--     logged as loaded, from the spot it was in). "Not on the truck yet" no longer stops a load. Tapping "Pulled onto truck"
--     or scanning while loading still works if you want it.
--  2. Shipping zones aren't required. A customer with no zone (on a van or box truck run) gets no shipping charge instead
--     of blocking Depart; customers on the same run that do have a zone share the run as before (without the zoneless ones). Contract customers still show FREE contract shipping. A typed shipping charge or a quoted one
--     still wins. A carrier run still needs the carrier's cost (or a typed charge).
-- Run once in Supabase after 107. Safe to re-run. If it says "tell Claude", nothing was changed.
begin;

do $$
declare d text; n int := 0;
  -- 1a. depart_prepare loads whatever isn't on the truck yet
  a1 text := 'b := load_blockers(l.id);';
  b1 text := '-- everything planned goes on the truck now (no separate "Pulled onto truck" step)
    perform load_pallet(x.id) from load_items x where x.load_id = l.id and not x.loaded;
    b := load_blockers(l.id);';
  -- 1b. not a blocker any more
  a2 text := 'if t is not null then r := r || jsonb_build_object(''stop_id'', s.id, ''seq'', s.seq, ''text'', ''Not on the truck yet: '' || t); end if;';
  b2 text := '-- not on the truck yet: Depart loads it (108)';
  -- 2. no zone: no charge
  a3 text := 'problem := case when cls = ''carrier'' then ''Enter the carrier''''s cost on the load (or type the shipping charge for '' || c.name || '')''
                      else ''No shipping zone for '' || missing || ''. Set the zone, or type the shipping charge.'' end;';
  a4 text := 'sh := case when missing is null then round(total / n + case when n > 1 then fee else 0 end, 2) end;';
  b4 text := 'sh := case when missing is null then round(total / n + case when n > 1 then fee else 0 end, 2)
               -- some customers have no zone (108): the run is shared by the ones that do
               when total is not null then round(total / greatest(n - (select count(*) from unnest(p_customers) y(id) join customers cy on cy.id = y.id
                                                                    where zone_price(cy.ship_zone_id, cls) is null), 1)
                                                 + case when n > 1 then fee else 0 end, 2) end;';
  a5 text := 'elsif sh is null then';
  b5 text := 'elsif cls in (''van'', ''box'') and zone_price((select cz.ship_zone_id from customers cz where cz.id = c.id), cls) is null then
      charge := 0; descr := ''Free shipping''; value := null;   -- no zone set (108): no charge, doesn''''t block
    elsif sh is null then';
  b3 text := 'if cls = ''carrier'' then
        problem := ''Enter the carrier''''s cost on the load (or type the shipping charge for '' || c.name || '')'';
      else   -- no zone set (108): no shipping charge, doesn''t block
        charge := 0; descr := ''Free shipping''; value := null;
      end if;';
begin
  select pg_get_functiondef('depart_prepare(int)'::regprocedure) into d;
  if position('perform load_pallet(x.id)' in d) = 0 then
    if position(a1 in d) = 0 then raise exception 'depart_prepare has changed: tell Claude (nothing was changed)'; end if;
    execute replace(d, a1, b1); n := n + 1;
  end if;

  select pg_get_functiondef('load_blockers(int)'::regprocedure) into d;
  if position(b2 in d) = 0 then
    if position(a2 in d) = 0 then raise exception 'load_blockers has changed: tell Claude (nothing was changed)'; end if;
    execute replace(d, a2, b2); n := n + 1;
  end if;

  select pg_get_functiondef('ship_calc(int[], text, numeric)'::regprocedure) into d;
  if position('no zone set (108)' in d) = 0 then
    if position(a3 in d) = 0 or position(a4 in d) = 0 or position(a5 in d) = 0 then raise exception 'ship_calc has changed: tell Claude (nothing was changed)'; end if;
    execute replace(replace(replace(d, a3, b3), a4, b4), a5, b5); n := n + 1;
  end if;
  raise notice '% functions updated', n;
end $$;

commit;

select position('perform load_pallet(x.id)' in pg_get_functiondef('depart_prepare(int)'::regprocedure)) > 0 as depart_loads_all,
       position('Depart loads it (108)' in pg_get_functiondef('load_blockers(int)'::regprocedure)) > 0 as no_truck_blocker,
       position('no zone set (108)' in pg_get_functiondef('ship_calc(int[], text, numeric)'::regprocedure)) > 0 as zones_optional;
