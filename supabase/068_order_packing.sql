-- 068: packing orders for shipping
--  1. Mixed pallets for orders: packages held for an order can ride on a mixed pallet (M#) and stay held.
--     A mixed pallet carries one customer's packages only (any of their open orders), never held + unheld.
--     The whole M# goes on the truck as one position.
--  2. Combine into one tag: pull from several pallets of the same strain, product and crop year
--     (whole or part of each) into one new package, held for the order line. METRC to-do: Combine packages.
--  3. Stacking on the truck: positions hold layers (1 = bottom). When the truck runs out of positions,
--     planning stacks two high, putting the earlier stop on top.
-- Safe to run more than once.

-- ---------- who a package is held for ----------
create or replace function held_customer(p_pallet bigint) returns int
language sql stable security definer set search_path = public as $$
  select o.customer_id from order_picks x join orders o on o.id = x.order_id
   where x.pallet_id = p_pallet and o.status = 'pending' limit 1
$$;

-- a mixed pallet's packages must all be held for the same customer, or all unheld
create or replace function mixed_hold_ok(p_container bigint, p_pallet bigint, p_customer int) returns void
language plpgsql stable security definer set search_path = public as $$
declare bad record; m text;
begin
  if p_container is null then return; end if;
  select x.code, held_customer(x.id) as cust into bad from pallets x
   where x.container_id = p_container and x.id <> p_pallet
     and held_customer(x.id) is distinct from p_customer
   limit 1;
  if bad.code is null then return; end if;
  select code into m from pallets where id = p_container;
  if p_customer is null then
    raise exception '% carries packages held for %. Only their packages can go on it.', m, (select name from customers where id = bad.cust);
  elsif bad.cust is null then
    raise exception '% also has % on it, which isn''t on an order. A mixed pallet for an order only carries that customer''s packages.', m, bad.code;
  else
    raise exception '% carries packages held for %. One customer per mixed pallet.', m, (select name from customers where id = bad.cust);
  end if;
end $$;

-- guard: putting a package on a mixed pallet (freezer map or Fulfillment)
create or replace function mixed_hold_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.container_id is not null and new.container_id is distinct from old.container_id then
    perform mixed_hold_ok(new.container_id, new.id, held_customer(new.id));
  end if;
  return new;
end $$;
drop trigger if exists mixed_hold_guard on pallets;
create trigger mixed_hold_guard before update of container_id on pallets for each row execute function mixed_hold_guard();

-- picks follow the package: going on a mixed pallet no longer drops it from the order
create or replace function pick_follow_pallet() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('merged','depleted','archived') then
    delete from order_picks where pallet_id = new.id and order_id in (select id from orders where status = 'pending');
  elsif new.current_weight is distinct from old.current_weight and new.status = 'in_freezer' then
    update order_picks set lbs = coalesce(new.current_weight, 0) where pallet_id = new.id;
  end if;
  return new;
end $$;

-- ---------- assign: a package already on a mixed pallet can be assigned if the pallet stays one customer's ----------
create or replace function pick_pallet(p_line int, p_pallet bigint) returns order_picks
language plpgsql security definer set search_path = public as $$
declare ln order_lines; o orders; p pallets; pk order_picks; other text;
begin
  perform require_distribution();
  select * into ln from order_lines where id = p_line;
  if ln.id is null then raise exception 'Order line not found'; end if;
  select * into o from orders where id = ln.order_id for update;
  if o.status <> 'pending' then raise exception 'Only confirmed, open orders can be fulfilled'; end if;
  if o.stop_id is not null then raise exception 'This order is on a load. Take it off the load to change its pallets.'; end if;
  select * into p from pallets where id = p_pallet for update;
  if p.id is null then raise exception 'Pallet not found'; end if;
  if p.status <> 'in_freezer' then raise exception '% isn''t in a freezer', p.code; end if;
  if p.kind = 'mixed' then raise exception '% is a mixed pallet. Assign its packages instead.', p.code; end if;
  if p.container_id is not null then
    perform mixed_hold_ok(p.container_id, p.id, o.customer_id);
    other := pallet_open_load(p.container_id);
    if other is not null then raise exception '% is on a mixed pallet that''s on load %', p.code, other; end if;
  end if;
  if lower(coalesce(canonical_strain(p.strain), p.strain, '')) <> lower(coalesce(canonical_strain(ln.strain), ln.strain)) then
    raise exception '% is %, this line is %', p.code, coalesce(p.strain, 'no strain'), ln.strain;
  end if;
  if p.product <> ln.product then raise exception '% is %, this line is %', p.code, product_label(p.product), product_label(ln.product); end if;
  select coalesce(o2.so_number, c.name) into other from order_picks x join orders o2 on o2.id = x.order_id join customers c on c.id = o2.customer_id where x.pallet_id = p.id;
  if other is not null then raise exception '% is already held for %', p.code, other; end if;
  other := pallet_open_load(p.id);
  if other is not null then raise exception '% is already on load %', p.code, other; end if;
  insert into order_picks (order_id, order_line_id, pallet_id, lbs, created_by)
  values (o.id, ln.id, p.id, coalesce(p.current_weight, 0), current_email()) returning * into pk;
  perform pick_event('fulfill_assigned', o.id, p.id, pk.lbs, jsonb_build_object('strain', ln.strain));
  return pk;
end $$;

-- unassigning a package on a mixed pallet would leave an unheld package among held ones
create or replace function unpick(p_pick int) returns void
language plpgsql security definer set search_path = public as $$
declare pk order_picks; o orders; p pallets; m text;
begin
  perform require_distribution();
  select * into pk from order_picks where id = p_pick;
  if pk.id is null then return; end if;
  select * into o from orders where id = pk.order_id;
  if o.stop_id is not null then raise exception 'This order is on a load. Take it off the load first.'; end if;
  select * into p from pallets where id = pk.pallet_id;
  if p.container_id is not null and exists (select 1 from pallets x where x.container_id = p.container_id and x.id <> p.id) then
    select code into m from pallets where id = p.container_id;
    raise exception '% is on mixed pallet % with other packages for this customer. Take it off % on the freezer map first.', p.code, m, m;
  end if;
  delete from order_picks where id = pk.id;
  perform pick_event('fulfill_unassigned', o.id, pk.pallet_id, pk.lbs);
end $$;

-- ---------- 1. mixed pallet for an order ----------
-- p_pallets: packages held for this customer (this order or their other open orders).
-- p_into: an existing mixed pallet to add to; else a new M# in p_slot (default: where the first package is, stacked).
create or replace function order_mixed_pallet(p_order int, p_pallets bigint[], p_into bigint default null, p_slot int default null)
returns pallets
language plpgsql security definer set search_path = public as $$
declare o orders; m pallets; p pallets; dest int; codes text[] := '{}'; pid bigint; other text;
begin
  perform require_distribution();
  select * into o from orders where id = p_order;
  if o.id is null then raise exception 'Order not found'; end if;
  if coalesce(array_length(p_pallets, 1), 0) = 0 then raise exception 'Pick the packages to put on the mixed pallet'; end if;
  foreach pid in array p_pallets loop
    select * into p from pallets where pallets.id = pid;
    if p.id is null then raise exception 'Package not found'; end if;
    if held_customer(p.id) is distinct from o.customer_id then raise exception '% isn''t held for %', p.code, (select name from customers where customers.id = o.customer_id); end if;
    if exists (select 1 from order_picks x join orders o2 on o2.id = x.order_id where x.pallet_id = p.id and o2.stop_id is not null) then
      raise exception '%''s order is on a load. Take it off the load first.', p.code;
    end if;
    if p.container_id is not null and p.container_id is not distinct from p_into then continue; end if;
    if p.container_id is not null then raise exception '% is already on mixed pallet %', p.code, (select code from pallets where pallets.id = p.container_id); end if;
  end loop;
  if p_into is not null then
    select * into m from pallets where pallets.id = p_into for update;
    if m.id is null or m.kind <> 'mixed' then raise exception 'That isn''t a mixed pallet'; end if;
    if m.status <> 'in_freezer' then raise exception '% isn''t in a freezer', m.code; end if;
    other := pallet_open_load(m.id);
    if other is not null then raise exception '% is on load %. Take it off the load first.', m.code, other; end if;
  else
    select slot_id into dest from pallets where pallets.id = p_pallets[1];
    dest := coalesce(p_slot, dest);
    perform slot_ok(dest, true);
    insert into pallets (code, kind, label, status, slot_id)
    values ('M' || nextval('mixed_pallet_seq'), 'mixed', 'Mixed pallet', 'in_freezer', dest)
    returning * into m;
    insert into events(user_email, type, pallet_id, to_slot_id, note, details)
    values (current_email(), 'mixed_created', m.id, dest, 'for an order', jsonb_build_object('order_id', o.id, 'so', o.so_number));
  end if;
  foreach pid in array p_pallets loop
    select * into p from pallets where pallets.id = pid;
    if p.container_id = m.id then continue; end if;
    codes := codes || mix_line(m, jsonb_build_object('pallet_id', pid), 'for ' || coalesce(o.so_number, 'an order'));
  end loop;
  perform pick_event('fulfill_mixed', o.id, m.id, null, jsonb_build_object('mixed', m.code, 'packages', to_jsonb(codes)));
  return m;
end $$;

-- ---------- 2. combine into one tag ----------
-- p_sources: [{"pallet_id": 12, "lbs": null}, {"pallet_id": 40, "lbs": 350}]  (lbs null or >= weight = the whole pallet)
create or replace function combine_for_line(p_line int, p_sources jsonb, p_tag text default null, p_tag_pending boolean default false, p_slot int default null)
returns order_picks
language plpgsql security definer set search_path = public as $$
declare ln order_lines; o orders; src jsonb; p pallets; n pallets; lbs numeric; total numeric := 0; parts text[] := '{}'; whole bigint[] := '{}';
        tag text := nullif(upper(trim(p_tag)), ''); used text; other text; dest int; yr int; yrs int; prod text; origins text; first_slot int;
begin
  perform require_distribution();
  select * into ln from order_lines where id = p_line;
  if ln.id is null then raise exception 'Order line not found'; end if;
  select * into o from orders where id = ln.order_id for update;
  if o.status <> 'pending' then raise exception 'Only confirmed, open orders can be fulfilled'; end if;
  if o.stop_id is not null then raise exception 'This order is on a load. Take it off the load first.'; end if;
  if jsonb_array_length(coalesce(p_sources, '[]')) < 2 then raise exception 'Pick at least two pallets to combine'; end if;
  if tag is null and not p_tag_pending then raise exception 'Enter the new METRC tag, or mark it pending'; end if;
  if tag is not null then
    used := tag_in_use(tag, null);
    if used is not null then raise exception 'Tag % is already on %', tag, used; end if;
  end if;

  -- check every source first
  for src in select * from jsonb_array_elements(p_sources) loop
    select * into p from pallets where id = (src->>'pallet_id')::bigint for update;
    if p.id is null then raise exception 'Pallet not found'; end if;
    perform assert_loose(p, 'merged');
    if p.status <> 'in_freezer' then raise exception '% isn''t in a freezer', p.code; end if;
    if p.kind = 'mixed' then raise exception '% is a mixed pallet', p.code; end if;
    if not p.pushed then raise exception '% isn''t a METRC package yet (still in the Harvest log)', p.code; end if;
    if lower(coalesce(canonical_strain(p.strain), p.strain, '')) <> lower(coalesce(canonical_strain(ln.strain), ln.strain)) then
      raise exception '% is %, this line is %', p.code, coalesce(p.strain, 'no strain'), ln.strain;
    end if;
    if p.product <> ln.product then raise exception '% is %, this line is %', p.code, product_label(p.product), product_label(ln.product); end if;
    if not (coalesce(p.current_weight, 0) > 0) then raise exception '% has no weight', p.code; end if;
    select coalesce(o2.so_number, c.name) into other from order_picks x join orders o2 on o2.id = x.order_id join customers c on c.id = o2.customer_id
     where x.pallet_id = p.id and x.order_id <> o.id;
    if other is not null then raise exception '% is held for %', p.code, other; end if;
    if proc_open_run_of(p.id) is not null then raise exception '% is in a processing run', p.code; end if;
    lbs := nullif(src->>'lbs', '')::numeric;
    if lbs is not null and lbs <= 0 then raise exception 'Enter lbs for %', p.code; end if;
    if lbs is null or lbs >= p.current_weight then lbs := p.current_weight; end if;
    total := total + lbs;
    first_slot := coalesce(first_slot, p.slot_id);
  end loop;
  select count(distinct coalesce(x.crop_year, 0)), max(x.crop_year), max(x.product),
         string_agg(distinct nullif(x.origin_site, ''), '+')
    into yrs, yr, prod, origins
    from pallets x where x.id in (select (e->>'pallet_id')::bigint from jsonb_array_elements(p_sources) e);
  if yrs > 1 then raise exception 'Only one crop year can go in one package'; end if;
  if yr is not null and yr <> ln.crop_year then raise exception 'These are % product, this line is %', yr, ln.crop_year; end if;

  -- these pallets were assigned to this order before: they're replaced by the new package
  delete from order_picks where order_id = o.id and pallet_id in (select (e->>'pallet_id')::bigint from jsonb_array_elements(p_sources) e);

  dest := coalesce(p_slot, first_slot);
  perform slot_ok(dest, true);
  insert into pallets (code, strain, zone, harvest_date, planting_date, og_weight, current_weight, package_tag, status, slot_id, tag_pending,
                       product, crop_year, origin_site)
  select 'C' || nextval('combined_pallet_seq'), (select x.strain from pallets x where x.id = (p_sources->0->>'pallet_id')::bigint),
         case when count(distinct x.zone) = 1 then max(x.zone) else 'Mixed' end,
         min(x.harvest_date), min(x.planting_date), total, total, tag, 'in_freezer', dest, tag is null,
         prod, yr, (select string_agg(distinct v, '+' order by v) from unnest(string_to_array(coalesce(origins, ''), '+')) v where v <> '')
    from pallets x where x.id in (select (e->>'pallet_id')::bigint from jsonb_array_elements(p_sources) e)
  returning * into n;

  for src in select * from jsonb_array_elements(p_sources) loop
    select * into p from pallets where id = (src->>'pallet_id')::bigint;
    lbs := nullif(src->>'lbs', '')::numeric;
    if lbs is null or lbs >= p.current_weight then
      parts := parts || (p.code || ' (all ' || trim(to_char(p.current_weight, 'FM999999990.##')) || ' lbs)');
      whole := whole || p.id;
      update pallets set status = 'merged', slot_id = null, merged_into = n.id, updated_at = now() where id = p.id;
      insert into events(user_email, type, pallet_id, from_slot_id, lbs, note, details)
      values (current_email(), 'merged_into', p.id, p.slot_id, p.current_weight, 'combined for ' || coalesce(o.so_number, 'an order'), jsonb_build_object('into', n.code, 'into_id', n.id));
    else
      parts := parts || (p.code || ' (' || trim(to_char(lbs, 'FM999999990.##')) || ' lbs)');
      update pallets set current_weight = current_weight - lbs, updated_at = now() where id = p.id;
      insert into events(user_email, type, pallet_id, from_slot_id, lbs, note, details)
      values (current_email(), 'combine_part', p.id, p.slot_id, lbs, 'combined for ' || coalesce(o.so_number, 'an order'),
              jsonb_build_object('into', n.code, 'into_id', n.id, 'remaining', p.current_weight - lbs));
    end if;
  end loop;
  insert into events(user_email, type, pallet_id, to_slot_id, lbs, note, details)
  values (current_email(), 'merge', n.id, dest, total, 'combined for ' || coalesce(o.so_number, 'an order'),
          jsonb_build_object('sources', to_jsonb(parts), 'tag', tag, 'order_id', o.id, 'so', o.so_number, 'strain', ln.strain));
  return pick_pallet(ln.id, n.id);
end $$;

-- ---------- 3. truck stacking: layers ----------
alter table load_items add column if not exists layer smallint not null default 1;

-- new on a position, or moved to one: goes on top
create or replace function load_item_layer() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.position is distinct from old.position then
    select coalesce(max(layer), 0) + 1 into new.layer from load_items
     where load_id = new.load_id and position = new.position and id is distinct from new.id;
  end if;
  return new;
end $$;
drop trigger if exists load_item_layer on load_items;
create trigger load_item_layer before insert or update of position on load_items for each row execute function load_item_layer();

-- existing stacks: number them in the order they were planned
update load_items i set layer = x.n from (
  select id, row_number() over (partition by load_id, position order by id) as n from load_items) x
 where x.id = i.id and i.layer is distinct from x.n;

-- put a pallet on top of its stack
create or replace function stack_top(p_item int) returns void
language plpgsql security definer set search_path = public as $$
declare it load_items; l loads;
begin
  perform require_staff();
  select * into it from load_items where id = p_item for update;
  if not found then raise exception 'Not found'; end if;
  select * into l from loads where id = it.load_id;
  perform load_open(l);
  update load_items set layer = (select coalesce(max(layer), 0) + 1 from load_items where load_id = it.load_id and position = it.position and id <> it.id)
   where id = it.id;
end $$;

-- planning with no position given: first open position; when the truck is full, stack two high
-- (on a pallet for the same or a later stop, so the top one comes off first)
create or replace function plan_pallet(p_load int, p_stop int, p_pallet bigint, p_position int default null, p_share boolean default false) returns load_items
language plpgsql security definer set search_path = public as $$
declare l loads; p pallets; it load_items; other text; pos int; cap int; my_seq int;
begin
  select * into l from loads where id = p_load for update;
  if not found then raise exception 'Load not found'; end if;
  if l.status not in ('planning','loading') then raise exception 'Load % has already left', l.code; end if;
  select s.seq into my_seq from load_stops s where s.id = p_stop and s.load_id = l.id and s.status = 'pending';
  if my_seq is null then raise exception 'Pick a stop on this load'; end if;
  select * into p from pallets where id = p_pallet for update;
  if not found then raise exception 'Pallet not found'; end if;
  perform assert_loose(p, 'loaded');
  if p.status <> 'in_freezer' then raise exception '% isn''t in a freezer', p.code; end if;
  other := pallet_open_load(p.id);
  if other is not null then raise exception '% is already on load %', p.code, other; end if;
  select spaces into cap from vehicles where id = l.vehicle_id;
  pos := p_position;
  if pos is null then
    select min(g) into pos from generate_series(1, cap) g where not exists (select 1 from load_items where load_id = l.id and position = g);
    if pos is null then
      select i.position into pos
        from load_items i join load_stops s on s.id = i.stop_id
       where i.load_id = l.id
       group by i.position
      having count(*) = 1
       order by (max(s.seq) < my_seq), abs(max(s.seq) - my_seq), i.position
       limit 1;
      if pos is null then raise exception 'The truck is full (% spaces, stacked two high). Use a bigger vehicle or another load.', cap; end if;
    end if;
  else
    perform position_check(l.id, pos, p_share);
  end if;
  insert into load_items (load_id, stop_id, pallet_id, position) values (l.id, p_stop, p.id, pos) returning * into it;
  insert into events (user_email, type, pallet_id, load_id, lbs, details)
  values (current_email(), 'load_planned', p.id, l.id, p.current_weight, jsonb_build_object('load', l.code, 'position', pos, 'layer', it.layer));
  return it;
end $$;

-- ---------- loads carry whole mixed pallets ----------
-- a held pallet, or a mixed pallet carrying held packages, only goes to that customer or to OHR/GVR
create or replace function check_hold() returns trigger
language plpgsql security definer set search_path = public as $$
declare h record; c customers;
begin
  select o.customer_id, o.so_number, cu.name into h
    from order_picks x join orders o on o.id = x.order_id join customers cu on cu.id = o.customer_id
   where (x.pallet_id = new.pallet_id or x.pallet_id in (select id from pallets where container_id = new.pallet_id))
     and o.status = 'pending'
   limit 1;
  if h.customer_id is null then return new; end if;
  select cu.* into c from load_stops s join customers cu on cu.id = s.customer_id where s.id = new.stop_id;
  if c.id = h.customer_id or (c.kind = 'internal' and upper(c.name) in ('OHR', 'GVR')) then return new; end if;
  raise exception 'That pallet is held for % (%). It can only go to them or to OHR/GVR. Unassign it in Fulfillment first.', h.name, coalesce(h.so_number, 'order');
end $$;

-- orders that share a mixed pallet go on and off a load together
create or replace function order_group(p_order int) returns int[]
language plpgsql stable security definer set search_path = public as $$
declare g int[] := array[p_order]; n int := 0;
begin
  while coalesce(array_length(g, 1), 0) <> n loop
    n := array_length(g, 1);
    select array_agg(distinct x.order_id) into g from order_picks x join pallets p on p.id = x.pallet_id
     where x.order_id = any(g)
        or (p.container_id is not null and p.container_id in (
             select p2.container_id from order_picks x2 join pallets p2 on p2.id = x2.pallet_id where x2.order_id = any(g) and p2.container_id is not null));
    g := (select array_agg(distinct v) from unnest(g || array[p_order]) v);
  end loop;
  return g;
end $$;

create or replace function order_to_load(p_order int, p_load int) returns void
language plpgsql security definer set search_path = public as $$
declare o orders; l loads; sid int; pk record; st text; grp int[]; gid int; g orders;
begin
  perform require_distribution();
  select * into o from orders where id = p_order for update;
  st := order_state(o.id);
  if st = 'loaded' then raise exception 'This order is already on a load'; end if;
  if st = 'needs_ok' then raise exception 'Some lines don''t match what was ordered. Sales has to OK them first.'; end if;
  if st <> 'ready' then raise exception 'Assign pallets to every line first'; end if;
  grp := order_group(o.id);
  foreach gid in array grp loop
    if gid = o.id then continue; end if;
    select * into g from orders where id = gid for update;
    st := order_state(gid);
    if st <> 'ready' then
      raise exception '% shares a mixed pallet with % (%), which isn''t ready to load. Finish it, or take its packages off the mixed pallet.',
        coalesce(o.so_number, 'This order'), coalesce(g.so_number, 'order #' || g.id), lower(replace(st, '_', ' '));
    end if;
  end loop;
  select * into l from loads where id = p_load for update;
  if l.id is null then raise exception 'Load not found'; end if;
  if l.status not in ('planning','loading') then raise exception 'Load % has already left', l.code; end if;
  select id into sid from load_stops where load_id = l.id and customer_id = o.customer_id and status = 'pending' order by seq limit 1;
  if sid is null then
    insert into load_stops (load_id, seq, customer_id)
    values (l.id, coalesce((select max(seq) from load_stops where load_id = l.id), 0) + 1, o.customer_id) returning id into sid;
  end if;
  update orders set stop_id = sid, updated_at = now() where id = any(grp);
  -- whole mixed pallets, then loose packages; one truck position each
  for pk in select distinct on (coalesce(p.container_id, p.id)) coalesce(p.container_id, p.id) as top, x.id
              from order_picks x join pallets p on p.id = x.pallet_id
             where x.order_id = any(grp)
             order by coalesce(p.container_id, p.id), x.id loop
    if not exists (select 1 from load_items where load_id = l.id and pallet_id = pk.top) then
      perform plan_pallet(l.id, sid, pk.top);
    end if;
  end loop;
  foreach gid in array grp loop
    insert into events (user_email, type, load_id, details)
    values (current_email(), 'fulfill_loaded', l.id, jsonb_build_object('load', l.code, 'order_id', gid, 'so', (select so_number from orders where id = gid),
            'customer', (select name from customers where id = o.customer_id), 'with', case when gid <> o.id then o.so_number end));
  end loop;
end $$;

create or replace function order_off_load(p_order int) returns void
language plpgsql security definer set search_path = public as $$
declare o orders; s load_stops; l loads; grp int[]; gid int;
begin
  perform require_distribution();
  select * into o from orders where id = p_order for update;
  if o.stop_id is null then return; end if;
  select * into s from load_stops where id = o.stop_id;
  select * into l from loads where id = s.load_id;
  if l.status not in ('planning','loading') then raise exception 'Load % has already left', l.code; end if;
  grp := (select array_agg(id) from orders where id = any(order_group(o.id)) and stop_id = s.id);
  if exists (select 1 from load_items i where i.stop_id = s.id and i.loaded and i.pallet_id in (
               select coalesce(p.container_id, p.id) from order_picks x join pallets p on p.id = x.pallet_id where x.order_id = any(grp))) then
    raise exception 'Some of its pallets are already on the truck. Put them back first.';
  end if;
  delete from load_items i where i.stop_id = s.id and i.pallet_id in (
    select coalesce(p.container_id, p.id) from order_picks x join pallets p on p.id = x.pallet_id where x.order_id = any(grp));
  update orders set stop_id = null, updated_at = now() where id = any(grp);
  if not exists (select 1 from load_items where stop_id = s.id) and not exists (select 1 from orders where stop_id = s.id)
     and (select count(*) from load_stops where load_id = l.id) > 1 then
    delete from load_stops where id = s.id;
  end if;
  foreach gid in array grp loop
    insert into events (user_email, type, load_id, details)
    values (current_email(), 'fulfill_unloaded', l.id, jsonb_build_object('load', l.code, 'order_id', gid, 'so', (select so_number from orders where id = gid)));
  end loop;
end $$;
