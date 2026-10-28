-- 089: Depart makes the manifests and the invoices; orders go on a load early; every freezer action works on a load;
--      customer pickups; shipping calculator; QuickBooks auto-push (30 min hold) with prices pulled back.
--  1. An order with at least one pallet can go on a planning load. Fulfillment keeps working on it until the load departs:
--     assigning a pallet puts it on the stop, unassigning takes it off (a pallet already on the truck stays on the stop
--     until someone takes it off or assigns it), pick part, combine and Sales OKs all still work.
--  2. Pallets on a load that hasn't left (planned, or already on the truck) can be split, merged, mixed, adjusted, tagged,
--     removed, the same as in the freezers. Pieces can stay on the load or go to a freezer spot.
--  3. Depart (depart_prepare > the METRC manifests > depart_finish): every customer stop needs complete, OK'd orders and
--     every pallet on an order and on the truck; the manifests are made first; then the load leaves, the orders are
--     shipped and the invoices are made (dated the day it left). Manifests Off: Depart still works, the number is typed
--     on the stop later and copied to the invoices.
--  4. Customer pickups: a load with the customer's own driver and truck; "Picked up" makes the manifest (customer as the
--     transporter), the invoice (no shipping) and marks the stop delivered.
--  5. Shipping: zones, a price class per vehicle, a rule per customer (calculated / free contract / split % / pickup).
--  6. QuickBooks: invoices for outside customers are sent 30 minutes after they're made (editing restarts the clock);
--     prices changed in QuickBooks come back to the app; quantity changes and unknown lines are flagged.
-- Run after 088. Safe to run more than once.

-- =====================================================================================================
-- 0. helpers
-- =====================================================================================================
alter table loads drop constraint if exists loads_status_check;
alter table loads add constraint loads_status_check check (status in ('planning','loading','departing','in_transit','delivered','cancelled'));
alter table loads add column if not exists kind text not null default 'delivery';
alter table loads drop constraint if exists loads_kind_check;
alter table loads add constraint loads_kind_check check (kind in ('delivery','pickup'));
alter table loads add column if not exists departing_at timestamptz;
alter table loads add column if not exists departing_by text;
alter table loads add column if not exists depart_error text;
-- customer pickup: their driver and truck (typed in ahead or at the dock)
alter table loads add column if not exists pickup_driver text;
alter table loads add column if not exists pickup_dl text;
alter table loads add column if not exists pickup_make text;
alter table loads add column if not exists pickup_model text;
alter table loads add column if not exists pickup_plate text;
alter table loads add column if not exists pickup_license text;   -- the transporter license on the manifest (theirs)
-- outside carrier: what the carrier charges for the run (split across the billed stops)
alter table loads add column if not exists carrier_cost numeric;

alter table invoices add column if not exists manifest text;

-- the load item a pallet is on (directly, or through its mixed pallet) on a load that hasn't left yet
create or replace function editable_item(p_pallet bigint) returns load_items
language sql stable security definer set search_path = public as $$
  select i.* from load_items i join loads l on l.id = i.load_id
   where i.pallet_id = coalesce((select container_id from pallets where id = p_pallet), p_pallet)
     and l.status in ('planning', 'loading')
   order by i.id desc limit 1
$$;

-- is this pallet live inventory (in a freezer, received at a site, or on a truck that hasn't left)?
create or replace function pallet_workable(p pallets) returns boolean
language sql stable security definer set search_path = public as $$
  select p.status in ('in_freezer', 'unslotted') or (p.status = 'in_transit' and (editable_item(p.id)).id is not null)
$$;

-- an order's load (if any) hasn't left: its pallets can still change
create or replace function order_load_check(o orders) returns void
language plpgsql stable security definer set search_path = public as $$
declare st text; code text;
begin
  if o.stop_id is null then return; end if;
  select l.status, l.code into st, code from load_stops s join loads l on l.id = s.load_id where s.id = o.stop_id;
  if st not in ('planning', 'loading') then raise exception 'Load % has already left (%). Its orders can''t change now.', code, st; end if;
end $$;

-- how complete an order is, whether or not it's on a load: open / needs_ok / ready
create or replace function order_fill(p_order int) returns text
language sql stable security definer set search_path = public as $$
  with l as (select ol.id, ol.lbs, ol.cant_fill, coalesce((select sum(p.lbs) from order_picks p where p.order_line_id = ol.id), 0) as got
               from order_lines ol where ol.order_id = p_order and ol.lbs > 0)
  select case
    when not exists (select 1 from l) then 'open'
    when exists (select 1 from l where got = 0 and not cant_fill) then 'open'
    when exists (select 1 from l where got <> lbs) then 'needs_ok'
    else 'ready' end
$$;

create or replace function stop_is_site(p_stop int) returns text
language sql stable security definer set search_path = public as $$
  select case when c.kind = 'internal' and upper(c.name) in ('OHR', 'GVR') then upper(c.name) end
    from load_stops s join customers c on c.id = s.customer_id where s.id = p_stop
$$;

-- billed stop: an outside customer (not our sites, not our processors / internal accounts)
create or replace function stop_is_billed(p_stop int) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select c.kind = 'external' from load_stops s join customers c on c.id = s.customer_id where s.id = p_stop), false)
$$;

-- the picks on a pallet follow its weight on a truck too
create or replace function pick_follow_pallet() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('merged','depleted','archived') then
    delete from order_picks where pallet_id = new.id and order_id in (select id from orders where status = 'pending');
  elsif new.current_weight is distinct from old.current_weight and new.status in ('in_freezer', 'in_transit', 'unslotted') then
    update order_picks set lbs = coalesce(new.current_weight, 0)
     where pallet_id = new.id and order_id in (select id from orders where status = 'pending');
  end if;
  return new;
end $$;

-- a pallet that's used up, merged or removed comes off any load that hasn't left
create or replace function load_item_drop() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('merged','depleted','archived') or (new.status = 'shipped' and old.status in ('in_freezer','unslotted')) then
    delete from load_items i using loads l
     where l.id = i.load_id and i.pallet_id = new.id and l.status in ('planning','loading');
  end if;
  return new;
end $$;
drop trigger if exists load_item_drop on pallets;
create trigger load_item_drop after update of status on pallets for each row execute function load_item_drop();

-- live check used by split / merge / mix / move: a pallet on a truck that hasn't left counts as live
create or replace function assert_loose(p pallets, verb text) returns void
language plpgsql stable security definer set search_path = public as $$
declare c text;
begin
  if not pallet_workable(p) then raise exception 'Pallet % is %, it cannot be %', p.code, replace(p.status, '_', ' '), verb; end if;
  if p.container_id is not null then
    select code into c from pallets where id = p.container_id;
    raise exception '% is on mixed pallet %. Take it off first.', p.code, c;
  end if;
end $$;

-- put a new pallet on a load next to another one (same stop, same position: stacked), on the truck if that one is
create or replace function load_item_like(p_new bigint, it load_items) returns load_items
language plpgsql security definer set search_path = public as $$
declare r load_items;
begin
  insert into load_items (load_id, stop_id, pallet_id, position, loaded, from_slot, from_site)
  values (it.load_id, it.stop_id, p_new, it.position, it.loaded, it.from_slot, it.from_site) returning * into r;
  return r;
end $$;

-- =====================================================================================================
-- 1. orders on a load early
-- =====================================================================================================
create or replace function order_to_load(p_order int, p_load int) returns void
language plpgsql security definer set search_path = public as $$
declare o orders; l loads; sid int; pk record; grp int[]; gid int;
begin
  perform require_distribution();
  select * into o from orders where id = p_order for update;
  if o.id is null then raise exception 'Order not found'; end if;
  if o.status <> 'pending' then raise exception 'Only open orders can go on a load'; end if;
  if o.stop_id is not null then raise exception 'This order is already on a load'; end if;
  if not exists (select 1 from order_picks where order_id = o.id) then raise exception 'Assign at least one pallet first'; end if;
  grp := order_group(o.id);
  select * into l from loads where id = p_load for update;
  if l.id is null then raise exception 'Load not found'; end if;
  if l.status not in ('planning','loading') then raise exception 'Load % has already left', l.code; end if;
  if l.kind = 'pickup' and exists (select 1 from load_stops where load_id = l.id and customer_id <> o.customer_id) then
    raise exception 'Pickup % is for another customer', l.code;
  end if;
  select id into sid from load_stops where load_id = l.id and customer_id = o.customer_id and status = 'pending' order by seq limit 1;
  if sid is null then
    if l.kind = 'pickup' then raise exception 'Pickup % is for another customer', l.code; end if;
    insert into load_stops (load_id, seq, customer_id)
    values (l.id, coalesce((select max(seq) from load_stops where load_id = l.id), 0) + 1, o.customer_id) returning id into sid;
  end if;
  update orders set stop_id = sid, updated_at = now() where id = any(grp) and stop_id is null;
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
            'customer', (select name from customers where id = o.customer_id), 'with', case when gid <> o.id then o.so_number end,
            'fill', order_fill(gid)));
  end loop;
end $$;

-- plan: from a freezer, or received at a site and not slotted yet
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
  if p.status <> 'in_freezer' and not (p.status = 'unslotted' and p.received_site is not null) then
    raise exception '% isn''t in a freezer or received at a site', p.code;
  end if;
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

-- assign: also while the order is on a load (the pallet goes onto its stop)
create or replace function pick_pallet(p_line int, p_pallet bigint) returns order_picks
language plpgsql security definer set search_path = public as $$
declare ln order_lines; o orders; p pallets; pk order_picks; other text; it load_items; top bigint; s load_stops;
begin
  perform require_distribution();
  select * into ln from order_lines where id = p_line;
  if ln.id is null then raise exception 'Order line not found'; end if;
  select * into o from orders where id = ln.order_id for update;
  if o.status <> 'pending' then raise exception 'Only confirmed, open orders can be fulfilled'; end if;
  perform order_load_check(o);
  select * into p from pallets where id = p_pallet for update;
  if p.id is null then raise exception 'Pallet not found'; end if;
  if p.kind = 'mixed' then raise exception '% is a mixed pallet. Assign its packages instead.', p.code; end if;
  it := editable_item(p.id);
  -- already on a load: only this order's stop
  if it.id is not null and (o.stop_id is null or it.stop_id <> o.stop_id) then
    raise exception '% is on load %. Take it off that load first.', p.code, (select code from loads where id = it.load_id);
  end if;
  if it.id is null then
    if p.status <> 'in_freezer' then raise exception '% isn''t in a freezer', p.code; end if;
    other := pallet_open_load(coalesce(p.container_id, p.id));
    if other is not null then raise exception '% is already on load %', p.code, other; end if;
  elsif not pallet_workable(p) then
    raise exception '% isn''t in inventory', p.code;
  end if;
  if p.container_id is not null then perform mixed_hold_ok(p.container_id, p.id, o.customer_id); end if;
  if lower(coalesce(canonical_strain(p.strain), p.strain, '')) <> lower(coalesce(canonical_strain(ln.strain), ln.strain)) then
    raise exception '% is %, this line is %', p.code, coalesce(p.strain, 'no strain'), ln.strain;
  end if;
  if p.product <> ln.product then raise exception '% is %, this line is %', p.code, product_label(p.product), product_label(ln.product); end if;
  select coalesce(o2.so_number, c.name) into other from order_picks x join orders o2 on o2.id = x.order_id join customers c on c.id = o2.customer_id where x.pallet_id = p.id;
  if other is not null then raise exception '% is already held for %', p.code, other; end if;
  insert into order_picks (order_id, order_line_id, pallet_id, lbs, created_by)
  values (o.id, ln.id, p.id, coalesce(p.current_weight, 0), current_email()) returning * into pk;
  perform pick_event('fulfill_assigned', o.id, p.id, pk.lbs, jsonb_build_object('strain', ln.strain));
  -- the order is on a load: the pallet (or its mixed pallet) goes on the stop
  if o.stop_id is not null and it.id is null then
    select * into s from load_stops where id = o.stop_id;
    top := coalesce(p.container_id, p.id);
    perform plan_pallet(s.load_id, s.id, top);
  end if;
  return pk;
end $$;

-- unassign: while on a load, a pallet that's only planned comes off the stop; one already on the truck stays there
create or replace function unpick(p_pick int) returns void
language plpgsql security definer set search_path = public as $$
declare pk order_picks; o orders; p pallets; m text; it load_items; top bigint;
begin
  perform require_distribution();
  select * into pk from order_picks where id = p_pick;
  if pk.id is null then return; end if;
  select * into o from orders where id = pk.order_id;
  perform order_load_check(o);
  select * into p from pallets where id = pk.pallet_id;
  if p.container_id is not null and exists (select 1 from pallets x where x.container_id = p.container_id and x.id <> p.id) then
    select code into m from pallets where id = p.container_id;
    raise exception '% is on mixed pallet % with other packages for this customer. Take it off % on the freezer map first.', p.code, m, m;
  end if;
  delete from order_picks where id = pk.id;
  perform pick_event('fulfill_unassigned', o.id, pk.pallet_id, pk.lbs);
  if o.stop_id is not null then
    top := coalesce(p.container_id, p.id);
    select i.* into it from load_items i where i.stop_id = o.stop_id and i.pallet_id = top;
    if it.id is not null and not it.loaded
       and not exists (select 1 from order_picks x join pallets q on q.id = x.pallet_id where coalesce(q.container_id, q.id) = top) then
      delete from load_items where id = it.id;
      insert into events (user_email, type, pallet_id, load_id, details)
      values (current_email(), 'load_removed', top, it.load_id, jsonb_build_object('load', (select code from loads where id = it.load_id), 'why', 'unassigned'));
    end if;
  end if;
end $$;

create or replace function cant_fill(p_line int, p_on boolean default true) returns void
language plpgsql security definer set search_path = public as $$
declare ln order_lines; o orders;
begin
  perform require_distribution();
  select * into ln from order_lines where id = p_line;
  select * into o from orders where id = ln.order_id;
  if o.status <> 'pending' then raise exception 'Only open orders'; end if;
  perform order_load_check(o);
  if p_on and exists (select 1 from order_picks where order_line_id = ln.id) then raise exception 'Unassign its pallets first'; end if;
  update order_lines set cant_fill = p_on, updated_at = now() where id = ln.id;
  perform pick_event(case when p_on then 'fulfill_cant_fill' else 'fulfill_can_fill' end, o.id, null, ln.lbs, jsonb_build_object('strain', ln.strain));
end $$;

-- combine for a line: also while the order is on a load (sources from freezers; the new package goes on the stop)
do $$
declare d text;
begin
  select pg_get_functiondef('combine_for_line_068(int,jsonb,text,boolean,int)'::regprocedure) into d;
  if d like '%This order is on a load. Take it off the load first.%' then
    d := replace(d, 'if o.stop_id is not null then raise exception ''This order is on a load. Take it off the load first.''; end if;',
                    'perform order_load_check(o);');
    d := replace(d, 'if p.kind = ''mixed'' then raise exception ''% is a mixed pallet'', p.code; end if;',
                    'if p.kind = ''mixed'' then raise exception ''% is a mixed pallet'', p.code; end if;
    if (editable_item(p.id)).id is not null and (editable_item(p.id)).stop_id is distinct from o.stop_id then raise exception ''% is on another load. Take it off first.'', p.code; end if;');
    execute d;
  end if;
end $$;

-- pick part: the piece comes from a pallet in a freezer (or one on this order's stop)
create or replace function pick_part(p_line int, p_pallet bigint, p_lbs numeric, p_tag text default null, p_tag_pending boolean default true) returns order_picks
language plpgsql security definer set search_path = public as $$
declare child pallets; o orders; it load_items;
begin
  perform require_distribution();
  if exists (select 1 from order_picks where pallet_id = p_pallet) then raise exception 'That pallet is held for another order'; end if;
  select o2.* into o from order_lines ol join orders o2 on o2.id = ol.order_id where ol.id = p_line;
  it := editable_item(p_pallet);
  if it.id is not null and it.stop_id is distinct from o.stop_id then raise exception 'That pallet is on another load. Take it off first.'; end if;
  -- on this order's stop already: the piece stays on the load next to it
  child := split_pallet(p_pallet, p_lbs, p_tag, p_tag is null or p_tag_pending, null, 'for an order', true, it.id is not null);
  return pick_pallet(p_line, child.id);
end $$;

-- =====================================================================================================
-- 2. freezer actions on a load
-- =====================================================================================================
-- split: p_keep_on_load = the piece stays on the load (same stop, stacked with it, on the truck if it is).
-- A pallet already on the truck: no spot given = the piece stays on the truck.
-- The piece of a pallet held for an order stays held for the same line when it stays on the load.
drop function if exists split_pallet(bigint, numeric, text, boolean, int, text, boolean);
create or replace function split_pallet(
  p_pallet_id bigint, p_lbs numeric, p_new_tag text, p_tag_pending boolean default false,
  p_dest_slot int default null, p_note text default null, p_share boolean default true, p_keep_on_load boolean default false
) returns pallets
language plpgsql security definer set search_path = public as $$
declare p pallets; child pallets; n int; dest int; used text; tag text := nullif(trim(p_new_tag), ''); it load_items; keep boolean; pk order_picks;
begin
  perform require_staff();
  select * into p from pallets where id = p_pallet_id for update;
  if not found then raise exception 'Pallet not found'; end if;
  perform assert_loose(p, 'split');
  if p.kind = 'mixed' then raise exception '% is a mixed pallet. Split one of the packages on it instead.', p.code; end if;
  if p.current_weight is null then raise exception 'Pallet % has no weight. Adjust its weight first.', p.code; end if;
  if p_lbs is null or p_lbs <= 0 then raise exception 'Enter how many lbs to split off'; end if;
  if p_lbs >= p.current_weight then raise exception 'Split must be less than the pallet weight (% lbs)', p.current_weight; end if;
  if tag is null and not p_tag_pending then raise exception 'Enter the new METRC tag, or mark it pending'; end if;
  if tag is not null then
    used := tag_in_use(tag, null);
    if used is not null then raise exception 'Tag % is already on pallet %', tag, used; end if;
  end if;
  it := editable_item(p.id);
  keep := it.id is not null and (coalesce(p_keep_on_load, false) or (p.status = 'in_transit' and p_dest_slot is null));
  if coalesce(p_keep_on_load, false) and it.id is null then raise exception '% isn''t on a load', p.code; end if;
  if keep then
    dest := p.slot_id;    -- planned: same spot; on the truck: none
  else
    dest := coalesce(p_dest_slot, p.slot_id);
    if dest is null then raise exception 'Pick the freezer spot the piece goes to'; end if;
    perform slot_ok(dest, p_share or dest = p.slot_id, array[p.id]);
  end if;

  select coalesce(max(substring(code from length(p.code) + 2)::int), 0) + 1 into n
    from pallets where left(code, length(p.code) + 1) = p.code || '-' and substring(code from length(p.code) + 2) ~ '^[0-9]+$';
  insert into pallets (code, strain, zone, harvest_date, planting_date, og_weight, current_weight,
                       package_tag, parent_id, status, slot_id, tag_pending, container_id)
  values (p.code || '-' || n, p.strain, p.zone, p.harvest_date, p.planting_date, p_lbs, p_lbs,
          tag, p.id, case when keep then p.status else 'in_freezer' end, dest, tag is null,
          case when keep then p.container_id end)
  returning * into child;
  update pallets set current_weight = current_weight - p_lbs, updated_at = now() where id = p.id;
  if keep then
    if p.container_id is null then perform load_item_like(child.id, it); end if;
    select * into pk from order_picks where pallet_id = p.id;
    if pk.id is not null then
      insert into order_picks (order_id, order_line_id, pallet_id, lbs, created_by) values (pk.order_id, pk.order_line_id, child.id, p_lbs, current_email());
    end if;
  end if;

  insert into events(user_email, type, pallet_id, from_slot_id, lbs, note, details)
  values (current_email(), 'split', p.id, p.slot_id, p_lbs, p_note,
          jsonb_strip_nulls(jsonb_build_object('child', child.code, 'child_id', child.id, 'remaining', p.current_weight - p_lbs,
            'load', case when it.id is not null then (select code from loads where id = it.load_id) end, 'stays_on_load', keep)));
  insert into events(user_email, type, pallet_id, to_slot_id, lbs, note, details)
  values (current_email(), 'split_from', child.id, dest, p_lbs, p_note,
          jsonb_build_object('parent', p.code, 'parent_id', p.id, 'tag', tag));
  return child;
end $$;
revoke all on function split_pallet(bigint,numeric,text,boolean,int,text,boolean,boolean) from public, anon;
grant execute on function split_pallet(bigint,numeric,text,boolean,int,text,boolean,boolean) to authenticated;

-- merge: pallets on a load (one stop) and pallets from freezers. The new package takes the load spot of the first one on
-- the load (on the truck if any of them was). Held packages must all be for the same order line; the new one stays held.
create or replace function merge_pallets(
  p_ids bigint[], p_new_tag text, p_tag_pending boolean default false, p_dest int default null, p_note text default null
) returns pallets
language plpgsql security definer set search_path = public as $$
declare
  src pallets[]; s pallets; m pallets; strains int; total numeric := 0; codes text[] := '{}';
  tag text := nullif(trim(p_new_tag), ''); used text; dest int; its load_items[] := '{}'; it load_items; first_it load_items;
  on_truck boolean := false; lines int; line_id int; ord_id int; n_held int;
begin
  perform require_staff();
  if coalesce(array_length(p_ids, 1), 0) < 2 then raise exception 'Pick at least two pallets to merge'; end if;
  select array_agg(x order by x.code) into src from (select * from pallets where id = any(p_ids) for update) x;
  if coalesce(array_length(src, 1), 0) <> array_length(p_ids, 1) then raise exception 'Some pallets were not found'; end if;
  foreach s in array src loop
    perform assert_loose(s, 'merged');
    if s.kind = 'mixed' then raise exception '% is a mixed pallet and can''t be merged', s.code; end if;
    if s.strain is null then raise exception 'Pallet % has no strain', s.code; end if;
    if s.current_weight is null then raise exception 'Pallet % has no weight', s.code; end if;
    total := total + s.current_weight; codes := codes || s.code;
    it := editable_item(s.id);
    if it.id is not null then
      its := its || it;
      if first_it.id is null then first_it := it; end if;
      if it.stop_id <> first_it.stop_id then raise exception 'Those pallets are on different stops or loads. Merge pallets from one stop at a time.'; end if;
      if it.loaded then on_truck := true; end if;
    elsif s.status <> 'in_freezer' and s.status <> 'unslotted' then
      raise exception '% isn''t in a freezer', s.code;
    end if;
  end loop;
  select count(distinct lower(x.strain)) into strains from unnest(src) x;
  if strains > 1 then raise exception 'Only the same strain can be merged. Use a mixed pallet for different strains.'; end if;
  -- holds: one order line at most
  select count(distinct x.order_line_id), min(x.order_line_id), min(x.order_id), count(*) into lines, line_id, ord_id, n_held
    from order_picks x where x.pallet_id = any(p_ids);
  if lines > 1 then raise exception 'Those pallets are held for different order lines. Merge only pallets for one line.'; end if;
  if tag is null and not p_tag_pending then raise exception 'Enter the new METRC tag, or mark it pending'; end if;
  if tag is not null then
    used := tag_in_use(tag, null);
    if used is not null and not (used = any(codes)) then raise exception 'Tag % is already on pallet %', tag, used; end if;
  end if;
  if on_truck then
    dest := null;
  else
    dest := coalesce(p_dest, (select x.slot_id from unnest(src) x where x.slot_id is not null limit 1));
    if dest is null then raise exception 'Pick the freezer spot for the new package'; end if;
    if not exists (select 1 from unnest(src) x where x.slot_id = dest) then perform slot_ok(dest, false, p_ids); end if;
  end if;

  insert into pallets (code, strain, zone, harvest_date, planting_date, og_weight, current_weight, package_tag, status, slot_id, tag_pending)
  select 'C' || nextval('combined_pallet_seq'), src[1].strain,
         case when count(distinct x.zone) = 1 then max(x.zone) else 'Mixed' end,
         min(x.harvest_date), min(x.planting_date), total, total, tag, case when on_truck then 'in_transit' else 'in_freezer' end, dest, tag is null
    from unnest(src) x
  returning * into m;
  update pallets set status = 'merged', slot_id = null, merged_into = m.id, updated_at = now() where id = any(p_ids);
  -- the sources came off the load (load_item_drop); the new package takes the first one's place
  if first_it.id is not null then
    first_it.loaded := on_truck;
    perform load_item_like(m.id, first_it);
  end if;
  if line_id is not null then
    insert into order_picks (order_id, order_line_id, pallet_id, lbs, created_by) values (ord_id, line_id, m.id, total, current_email());
  end if;

  insert into events(user_email, type, pallet_id, to_slot_id, lbs, note, details)
  values (current_email(), 'merge', m.id, dest, total, p_note, jsonb_strip_nulls(jsonb_build_object('sources', to_jsonb(codes), 'tag', tag,
          'load', case when first_it.id is not null then (select code from loads where id = first_it.load_id) end)));
  foreach s in array src loop
    insert into events(user_email, type, pallet_id, from_slot_id, lbs, note, details)
    values (current_email(), 'merged_into', s.id, s.slot_id, s.current_weight, p_note, jsonb_build_object('into', m.code, 'into_id', m.id));
  end loop;
  return m;
end $$;

-- mixed pallets: a package from a freezer or from the same load can go on a mixed pallet that's on a load
create or replace function mix_line(m pallets, line jsonb, p_note text) returns text
language plpgsql security definer set search_path = public as $$
declare p pallets; lbs numeric := (line->>'lbs')::numeric; tag text := nullif(trim(line->>'tag'), '');
        pending boolean := coalesce((line->>'tag_pending')::boolean, false); child pallets; n int; used text;
        mit load_items := editable_item(m.id); pit load_items;
begin
  select * into p from pallets where id = (line->>'pallet_id')::bigint for update;
  if not found then raise exception 'Pallet not found'; end if;
  perform assert_loose(p, 'added');
  if p.kind = 'mixed' then raise exception '% is already a mixed pallet', p.code; end if;
  pit := editable_item(p.id);
  if pit.id is not null and (mit.id is null or pit.load_id <> mit.load_id) then
    raise exception '% is on load %. Take it off the load first.', p.code, (select code from loads where id = pit.load_id);
  end if;
  if lbs is null or lbs >= coalesce(p.current_weight, 0) then
    insert into events(user_email, type, pallet_id, from_slot_id, to_slot_id, lbs, note, details)
    values (current_email(), 'mixed_on', p.id, p.slot_id, m.slot_id, p.current_weight, p_note,
            jsonb_build_object('mixed', m.code, 'mixed_id', m.id, 'whole', true));
    if pit.id is not null then delete from load_items where id = pit.id; end if;
    update pallets set container_id = m.id, slot_id = m.slot_id, status = m.status, updated_at = now() where id = p.id;
    return p.code;
  end if;
  if lbs <= 0 then raise exception 'Enter lbs for %', p.code; end if;
  if tag is null and not pending then raise exception 'Enter the new METRC tag for the % lbs from %, or mark it pending', lbs, p.code; end if;
  if tag is not null then
    used := tag_in_use(tag, null);
    if used is not null then raise exception 'Tag % is already on pallet %', tag, used; end if;
  end if;
  select coalesce(max(substring(code from length(p.code) + 2)::int), 0) + 1 into n
    from pallets where left(code, length(p.code) + 1) = p.code || '-' and substring(code from length(p.code) + 2) ~ '^[0-9]+$';
  insert into pallets (code, strain, zone, harvest_date, planting_date, og_weight, current_weight,
                       package_tag, parent_id, status, slot_id, tag_pending, container_id)
  values (p.code || '-' || n, p.strain, p.zone, p.harvest_date, p.planting_date, lbs, lbs,
          tag, p.id, m.status, m.slot_id, tag is null, m.id)
  returning * into child;
  update pallets set current_weight = current_weight - lbs, updated_at = now() where id = p.id;
  insert into events(user_email, type, pallet_id, from_slot_id, lbs, note, details)
  values (current_email(), 'split', p.id, p.slot_id, lbs, p_note,
          jsonb_build_object('child', child.code, 'child_id', child.id, 'remaining', p.current_weight - lbs, 'mixed', m.code));
  insert into events(user_email, type, pallet_id, to_slot_id, lbs, note, details)
  values (current_email(), 'split_from', child.id, m.slot_id, lbs, p_note,
          jsonb_build_object('parent', p.code, 'parent_id', p.id, 'tag', tag, 'mixed', m.code));
  return child.code;
end $$;

create or replace function add_to_mixed(p_mixed_id bigint, p_lines jsonb, p_note text default null) returns pallets
language plpgsql security definer set search_path = public as $$
declare m pallets; l jsonb; codes text[] := '{}';
begin
  perform require_staff();
  select * into m from pallets where id = p_mixed_id and kind = 'mixed' for update;
  if not found then raise exception 'Mixed pallet not found'; end if;
  if not pallet_workable(m) then raise exception '% is %', m.code, replace(m.status, '_', ' '); end if;
  for l in select * from jsonb_array_elements(p_lines) loop codes := codes || mix_line(m, l, p_note); end loop;
  insert into events(user_email, type, pallet_id, note, details)
  values (current_email(), 'mixed_added', m.id, p_note, jsonb_build_object('packages', to_jsonb(codes)));
  return m;
end $$;

-- a new mixed pallet right on a load stop (on the truck or planned), built from packages on that load or from freezers
create or replace function create_mixed_on_stop(p_stop int, p_lines jsonb, p_on_truck boolean default true, p_note text default null) returns pallets
language plpgsql security definer set search_path = public as $$
declare s load_stops; l loads; m pallets; ln jsonb; codes text[] := '{}'; it load_items; pos int; cap int;
begin
  perform require_staff();
  select * into s from load_stops where id = p_stop;
  if s.id is null then raise exception 'Stop not found'; end if;
  select * into l from loads where id = s.load_id for update;
  if l.status not in ('planning','loading') then raise exception 'Load % has already left', l.code; end if;
  if jsonb_array_length(coalesce(p_lines, '[]')) = 0 then raise exception 'Add at least one package'; end if;
  insert into pallets (code, kind, label, status, slot_id)
  values ('M' || nextval('mixed_pallet_seq'), 'mixed', 'Mixed pallet', case when p_on_truck then 'in_transit' else 'in_freezer' end, null)
  returning * into m;
  -- the spot of the first package from this load, else the next free one
  select i.position into pos from load_items i where i.stop_id = s.id
     and i.pallet_id in (select (x->>'pallet_id')::bigint from jsonb_array_elements(p_lines) x) order by i.id limit 1;
  if pos is null then
    select spaces into cap from vehicles where id = l.vehicle_id;
    select min(g) into pos from generate_series(1, cap) g where not exists (select 1 from load_items where load_id = l.id and position = g);
    pos := coalesce(pos, 1);
  end if;
  insert into load_items (load_id, stop_id, pallet_id, position, loaded) values (l.id, s.id, m.id, pos, p_on_truck) returning * into it;
  if p_on_truck and l.status = 'planning' then update loads set status = 'loading' where id = l.id; end if;
  for ln in select * from jsonb_array_elements(p_lines) loop codes := codes || mix_line(m, ln, p_note); end loop;
  insert into events(user_email, type, pallet_id, load_id, note, details)
  values (current_email(), 'mixed_created', m.id, l.id, p_note, jsonb_build_object('packages', to_jsonb(codes), 'load', l.code, 'on_truck', p_on_truck));
  return m;
end $$;
revoke all on function create_mixed_on_stop(int, jsonb, boolean, text) from public, anon;
grant execute on function create_mixed_on_stop(int, jsonb, boolean, text) to authenticated;

-- take a package off a mixed pallet: to a freezer spot, or (no spot, mixed pallet on a load) onto the load on its own
create or replace function take_off_mixed(p_pallet_id bigint, p_slot int, p_share boolean default false, p_note text default null) returns pallets
language plpgsql security definer set search_path = public as $$
declare p pallets; m pallets; it load_items;
begin
  perform require_staff();
  select * into p from pallets where id = p_pallet_id for update;
  if not found or p.container_id is null then raise exception 'That package is not on a mixed pallet'; end if;
  select * into m from pallets where id = p.container_id for update;
  it := editable_item(m.id);
  if p_slot is null then
    if it.id is null then raise exception 'Pick the freezer spot it goes to'; end if;
    insert into events(user_email, type, pallet_id, from_slot_id, lbs, note, details)
    values (current_email(), 'mixed_off', p.id, m.slot_id, p.current_weight, p_note, jsonb_build_object('mixed', m.code, 'mixed_id', m.id, 'stays_on_load', true));
    update pallets set container_id = null, updated_at = now() where id = p.id returning * into p;
    perform load_item_like(p.id, it);
    return p;
  end if;
  perform slot_ok(p_slot, p_share or p_slot = m.slot_id, array[p.id]);
  insert into events(user_email, type, pallet_id, from_slot_id, to_slot_id, lbs, note, details)
  values (current_email(), 'mixed_off', p.id, m.slot_id, p_slot, p.current_weight, p_note, jsonb_build_object('mixed', m.code, 'mixed_id', m.id));
  update pallets set container_id = null, slot_id = p_slot, status = 'in_freezer', updated_at = now() where id = p.id returning * into p;
  return p;
end $$;

-- break apart: the packages stay where the mixed pallet was (its freezer spot, or its place on the load)
create or replace function break_mixed(p_mixed_id bigint, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare m pallets; codes text[]; it load_items; c record;
begin
  perform require_staff();
  select * into m from pallets where id = p_mixed_id and kind = 'mixed' for update;
  if not found then raise exception 'Mixed pallet not found'; end if;
  it := editable_item(m.id);
  if m.status = 'in_transit' and it.id is null then raise exception '% has already left', m.code; end if;
  select array_agg(code order by code) into codes from pallets where container_id = m.id;
  insert into events(user_email, type, pallet_id, from_slot_id, lbs, note, details)
  select current_email(), 'mixed_off', id, m.slot_id, current_weight, p_note, jsonb_build_object('mixed', m.code, 'mixed_id', m.id, 'broken', true)
    from pallets where container_id = m.id;
  for c in select id from pallets where container_id = m.id order by code loop
    update pallets set container_id = null, updated_at = now() where id = c.id;
    if it.id is not null then perform load_item_like(c.id, it); end if;
  end loop;
  insert into events(user_email, type, pallet_id, from_slot_id, note, details)
  values (current_email(), 'mixed_broken', m.id, m.slot_id, p_note, jsonb_build_object('packages', to_jsonb(coalesce(codes, '{}'))));
  update pallets set status = 'depleted', slot_id = null, updated_at = now() where id = m.id;
end $$;

-- move: a pallet on the truck moved to a freezer spot comes off the truck (and off the load)
do $$
declare d text;
begin
  select pg_get_functiondef('move_pallet(bigint,int,boolean,text)'::regprocedure) into d;
  if d not like '%unload_pallet(%' then
    d := replace(d, 'perform assert_loose(p, ''moved'');',
                    'perform assert_loose(p, ''moved'');
  if p.status = ''in_transit'' then
    perform unload_pallet((editable_item(p.id)).id, p_to_slot, p_combine);
    select * into p from pallets where id = p_pallet_id;
    return p;
  end if;');
    execute d;
  end if;
end $$;

-- remove (used up / mistake / left outside the app): also from a load that hasn't left
create or replace function remove_pallet(p_pallet_id bigint, p_reason text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare p pallets;
begin
  perform require_staff();
  select * into p from pallets where id = p_pallet_id for update;
  if p.id is null then raise exception 'Pallet not found'; end if;
  if not pallet_workable(p) then raise exception '% isn''t in inventory', p.code; end if;
  if p.kind = 'mixed' and exists (select 1 from pallets where container_id = p.id and status in ('in_freezer','unslotted','in_transit')) then
    raise exception '% still has packages on it. Remove those first, or break it apart.', p.code;
  end if;
  if p_reason not in ('used','shipped','mistake') then raise exception 'Pick a reason'; end if;
  if p_reason = 'mistake' and nullif(trim(p_note), '') is null then raise exception 'Say what the mistake was'; end if;
  insert into events (user_email, type, pallet_id, from_slot_id, lbs, note, details)
  values (current_email(), 'removed', p.id, p.slot_id, p.current_weight, p_note,
          jsonb_build_object('reason', p_reason, 'weight', p.current_weight, 'tag', p.package_tag));
  -- off any load first (the trigger only catches statuses it knows)
  delete from load_items i using loads l where l.id = i.load_id and i.pallet_id = p.id and l.status in ('planning','loading');
  delete from order_picks where pallet_id = p.id and order_id in (select id from orders where status = 'pending');
  update pallets set
    status = case p_reason when 'used' then 'depleted' when 'shipped' then 'shipped' else 'archived' end,
    current_weight = case when p_reason = 'used' then 0 else current_weight end,
    slot_id = null, container_id = null,
    needs_review = case when p_reason = 'mistake' then 'Entered by mistake: ' || trim(p_note) else needs_review end,
    updated_at = now()
   where id = p.id;
  if p.package_tag is not null and p_reason = 'shipped' then perform ack_shipped_tag(p.package_tag); end if;
end $$;

-- =====================================================================================================
-- 3. Depart: checks > manifests > invoices
-- =====================================================================================================
-- does this stop's METRC manifest still need making? (kind Off = done by hand, never blocks)
create or replace function stop_needs_manifest(p_stop int) returns boolean
language sql stable security definer set search_path = public as $$
  select metrc_stop_kind_on(stop_is_site(p_stop) is not null)
     and exists (select 1 from load_items where stop_id = p_stop)
$$;

-- made (or checked in a dry run) for every license the stop ships from
create or replace function stop_manifest_ok(p_stop int) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare live boolean := coalesce((select value from app_settings where key = 'comp.metrc_live'), 'false') = 'true';
begin
  if not stop_needs_manifest(p_stop) then return true; end if;
  if exists (select 1 from load_stops where id = p_stop and nullif(trim(manifest), '') is not null) then return true; end if;
  if not exists (select 1 from comp_metrc_actions a where a.details ->> 'type' = 'stop_departed' and (a.details ->> 'stop_id')::int = p_stop) then return false; end if;
  return not exists (
    select 1 from comp_metrc_actions a
     where a.details ->> 'type' = 'stop_departed' and (a.details ->> 'stop_id')::int = p_stop
       and not (a.status = 'done' or (not live and coalesce(a.push_state, '') = 'checked'))
       and a.status <> 'skipped');
end $$;

-- what stops a load from leaving: [{stop_id, seq, text, order_id}]
create or replace function load_blockers(p_load int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare l loads; s record; o record; r jsonb := '[]'; t text; sh jsonb;
begin
  select * into l from loads where id = p_load;
  if l.id is null then return jsonb_build_array(jsonb_build_object('text', 'Load not found')); end if;
  if not exists (select 1 from load_items where load_id = l.id) then r := r || jsonb_build_object('text', 'Nothing is on this load'); end if;
  if l.kind = 'pickup' then
    if nullif(trim(l.pickup_driver), '') is null or nullif(trim(l.pickup_dl), '') is null then
      r := r || jsonb_build_object('text', 'Enter their driver''s name and driver''s license number');
    end if;
    if nullif(trim(l.pickup_make), '') is null or nullif(trim(l.pickup_model), '') is null or nullif(trim(l.pickup_plate), '') is null then
      r := r || jsonb_build_object('text', 'Enter their vehicle make, model and plate');
    end if;
  end if;
  for s in select st.id, st.seq, c.name, c.kind as ckind from load_stops st join customers c on c.id = st.customer_id
            where st.load_id = l.id and st.status = 'pending' order by st.seq loop
    select string_agg(p.code, ', ' order by p.code) into t from load_items i join pallets p on p.id = i.pallet_id where i.stop_id = s.id and not i.loaded;
    if t is not null then r := r || jsonb_build_object('stop_id', s.id, 'seq', s.seq, 'text', 'Not on the truck yet: ' || t); end if;
    if s.ckind <> 'external' then continue; end if;
    for o in select id, coalesce(so_number, 'Order #' || id) as so, order_fill(id) as fill from orders where stop_id = s.id and status = 'pending' order by id loop
      if o.fill = 'open' then r := r || jsonb_build_object('stop_id', s.id, 'seq', s.seq, 'order_id', o.id, 'text', o.so || ' still needs pallets');
      elsif o.fill = 'needs_ok' then r := r || jsonb_build_object('stop_id', s.id, 'seq', s.seq, 'order_id', o.id, 'text', o.so || ' is waiting on Sales to OK the amounts');
      end if;
    end loop;
    select string_agg(distinct k.code, ', ') into t from metrc_stop_packages(s.id) k
     where not exists (select 1 from order_picks x join orders o2 on o2.id = x.order_id where x.pallet_id = k.pallet_id and o2.stop_id = s.id);
    if t is not null then r := r || jsonb_build_object('stop_id', s.id, 'seq', s.seq, 'text', 'Not on an order for ' || s.name || ': ' || t); end if;
    select string_agg(p.code || ' (' || coalesce(o2.so_number, 'order') || ')', ', ' order by p.code) into t
      from order_picks x join orders o2 on o2.id = x.order_id join pallets p on p.id = x.pallet_id
     where o2.stop_id = s.id and o2.status = 'pending'
       and not exists (select 1 from load_items i where i.stop_id = s.id and i.pallet_id = coalesce(p.container_id, p.id));
    if t is not null then r := r || jsonb_build_object('stop_id', s.id, 'seq', s.seq, 'text', 'Assigned but not on this stop: ' || t); end if;
    sh := stop_shipping(s.id);
    if sh ->> 'problem' is not null then r := r || jsonb_build_object('stop_id', s.id, 'seq', s.seq, 'text', sh ->> 'problem'); end if;
  end loop;
  return r;
end $$;

-- step 1: check everything, mark the load Departing and queue its METRC manifests
create or replace function depart_prepare(p_load int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l loads; b jsonb; bad text; s record;
begin
  perform require_staff();
  perform no_view_as();
  select * into l from loads where id = p_load for update;
  if l.id is null then raise exception 'Load not found'; end if;
  if l.status not in ('planning', 'loading', 'departing') then raise exception 'Load % is %', l.code, replace(l.status, '_', ' '); end if;
  if l.status <> 'departing' then
    b := load_blockers(l.id);
    if jsonb_array_length(b) > 0 then
      raise exception 'Not ready to leave. %', (select string_agg(coalesce('Stop ' || (x ->> 'seq') || ': ', '') || (x ->> 'text'), ' · ') from jsonb_array_elements(b) x);
    end if;
    -- the METRC checklist (stops the app makes manifests for)
    select string_agg(distinct 'stop ' || x.seq || ' (' || x.from_license || ')', ', ') into bad
      from (select st.seq, st.id, k.from_license, stop_is_site(st.id) is not null as internal
              from load_stops st cross join lateral (select distinct from_license from metrc_stop_packages(st.id)) k
             where st.load_id = l.id and st.status = 'pending') x
     where metrc_stop_kind_on(x.internal)
       and not exists (select 1 from metrc_stop_checks ck where ck.stop_id = x.id and ck.license = x.from_license and ck.ok and ck.checked_at > now() - interval '60 minutes');
    if bad is not null then raise exception 'The METRC check isn''t green for %. Run Check METRC (and fix what it shows) first.', bad; end if;
    update loads set status = 'departing', departing_at = now(), departing_by = current_email(), depart_error = null where id = l.id;
    -- one METRC manifest per stop and shipping license
    for s in select st.id, st.seq, c.name as customer, stop_is_site(st.id) as to_site, c.license as cust_license,
                    k.from_license, k.from_site, k.tags, k.lbs, k.n
               from load_stops st join customers c on c.id = st.customer_id
               cross join lateral (select from_license, min(from_site) as from_site, array_agg(tag) filter (where tag is not null) as tags,
                                          sum(lbs) as lbs, count(*) as n from metrc_stop_packages(st.id) group by from_license) k
              where st.load_id = l.id and st.status = 'pending'
                and not exists (select 1 from comp_metrc_actions a where a.details ->> 'type' = 'stop_departed'
                                   and (a.details ->> 'stop_id')::int = st.id and a.status <> 'skipped' and a.license is not distinct from k.from_license)
              order by st.seq loop
      insert into events (user_email, type, load_id, lbs, details)
      values (current_email(), 'stop_departed', l.id, s.lbs,
              jsonb_build_object('stop_id', s.id, 'seq', s.seq, 'load', l.code, 'customer', s.customer, 'internal', s.to_site is not null,
                                 'from_site', s.from_site, 'from_license', s.from_license, 'to_site', s.to_site, 'pickup', l.kind = 'pickup',
                                 'to_license', coalesce(site_license(s.to_site), s.cust_license), 'tags', to_jsonb(coalesce(s.tags, '{}')), 'packages', s.n));
    end loop;
  end if;
  return jsonb_build_object('load_id', l.id, 'code', l.code, 'kind', l.kind,
    'stops', (select coalesce(jsonb_agg(jsonb_build_object('stop_id', st.id, 'seq', st.seq, 'internal', stop_is_site(st.id) is not null,
                       'needs_manifest', not stop_manifest_ok(st.id)) order by st.seq), '[]')
                from load_stops st where st.load_id = l.id and st.status = 'pending'),
    'todo', (select coalesce(jsonb_agg(a.id order by a.id), '[]') from comp_metrc_actions a join load_stops st on st.id = (a.details ->> 'stop_id')::int
              where a.details ->> 'type' = 'stop_departed' and st.load_id = l.id and a.status in ('todo', 'error') and not stop_manifest_ok(st.id)));
end $$;

-- step 2 (after the manifests): the load leaves, orders ship, invoices are made
create or replace function depart_finish(p_load int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l loads; s record; bad text; invs jsonb := '[]'; d date := _local_today(); n int;
begin
  perform require_staff();
  perform no_view_as();
  select * into l from loads where id = p_load for update;
  if l.id is null then raise exception 'Load not found'; end if;
  if l.status in ('in_transit', 'delivered') then
    return jsonb_build_object('load_id', l.id, 'code', l.code, 'already', true, 'departed', true);
  end if;
  if l.status <> 'departing' then raise exception 'Load % isn''t departing (%). Press Depart.', l.code, l.status; end if;
  select string_agg('stop ' || st.seq || ' ' || c.name || coalesce(': ' || (select string_agg(distinct a.push_error, '; ') from comp_metrc_actions a
            where a.details ->> 'type' = 'stop_departed' and (a.details ->> 'stop_id')::int = st.id and a.status <> 'skipped' and a.push_error is not null), ''),
         ' · ' order by st.seq) into bad
    from load_stops st join customers c on c.id = st.customer_id
   where st.load_id = l.id and st.status = 'pending' and not stop_manifest_ok(st.id);
  if bad is not null then
    -- nothing leaves; say why on the load (kept: no exception, so it isn't rolled back)
    update loads set depart_error = 'METRC manifest not made yet for ' || bad || '. Nothing has left. Fix it (Compliance to-do / Check METRC), then Depart again, or Back to loading.' where id = l.id;
    return jsonb_build_object('load_id', l.id, 'code', l.code, 'departed', false,
      'error', 'METRC manifest not made yet for ' || bad || '. Nothing has left.');
  end if;
  update loads set status = 'in_transit', departed_at = now(), depart_error = null where id = l.id;
  insert into events (user_email, type, load_id, details) values (current_email(), 'load_departed', l.id, jsonb_build_object('load', l.code, 'kind', l.kind));
  for s in select st.id, st.seq, st.manifest, c.kind as ckind from load_stops st join customers c on c.id = st.customer_id
            where st.load_id = l.id and st.status = 'pending' order by st.seq loop
    if s.ckind = 'external' then
      perform stop_shipping_save(s.id);
      update orders set status = 'shipped', shipped_date = d, updated_at = now() where stop_id = s.id and status = 'pending';
      get diagnostics n = row_count;
      update invoices set manifest = s.manifest where order_id in (select id from orders where stop_id = s.id) and manifest is null and s.manifest is not null;
      invs := invs || coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'inv', i.inv_number, 'total', i.total, 'customer', (select name from customers where id = i.customer_id)))
                                  from invoices i where i.order_id in (select id from orders where stop_id = s.id) and i.status <> 'void'), '[]');
    end if;
  end loop;
  -- a pickup is delivered the moment it leaves our dock
  if l.kind = 'pickup' then
    for s in select id from load_stops where load_id = l.id and status = 'pending' loop perform deliver_stop(s.id); end loop;
  end if;
  return jsonb_build_object('load_id', l.id, 'code', l.code, 'departed', true, 'invoices', invs);
end $$;

-- departing went wrong and no manifest was made: back to loading
create or replace function depart_back(p_load int) returns void
language plpgsql security definer set search_path = public as $$
declare l loads; made text;
begin
  perform require_staff();
  select * into l from loads where id = p_load for update;
  if l.status <> 'departing' then raise exception 'Load % isn''t departing', l.code; end if;
  select string_agg('stop ' || st.seq || ' (' || coalesce(t.manifest, 'number pending') || ')', ', ') into made
    from metrc_app_transfers t join load_stops st on st.id = t.stop_id where st.load_id = l.id and t.state <> 'voided';
  if made is not null then raise exception 'METRC already has a manifest for %. Depart again to finish, or void it in METRC first.', made; end if;
  update comp_metrc_actions a set status = 'skipped', note = 'Depart cancelled (back to loading)', done_by = current_email(), done_at = now()
   where a.details ->> 'type' = 'stop_departed' and a.status in ('todo', 'error') and coalesce(a.push_state, '') <> 'sending'
     and (a.details ->> 'stop_id')::int in (select id from load_stops where load_id = l.id);
  update loads set status = case when exists (select 1 from load_items where load_id = l.id and loaded) then 'loading' else 'planning' end,
                   departing_at = null, departing_by = null, depart_error = null where id = l.id;
  insert into events (user_email, type, load_id, details) values (current_email(), 'load_depart_back', l.id, jsonb_build_object('load', l.code));
end $$;

-- old app tabs: Depart in one go (works when no manifest has to be made first)
create or replace function depart_load(p_load int) returns void
language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  perform depart_prepare(p_load);
  r := depart_finish(p_load);
  if not coalesce((r ->> 'departed')::boolean, false) then raise exception '%', r ->> 'error'; end if;
end $$;

-- the manifest number typed on a stop (manifests done by hand) or saved by the app: onto the stop's invoices
create or replace function set_stop_manifest(p_stop int, p_manifest text) returns void
language plpgsql security definer set search_path = public as $$
declare s load_stops;
begin
  perform require_staff();
  perform no_view_as();
  select * into s from load_stops where id = p_stop for update;
  if s.id is null then raise exception 'Stop not found'; end if;
  update load_stops set manifest = nullif(trim(p_manifest), '') where id = s.id;
  insert into events (user_email, type, load_id, details)
  values (current_email(), 'stop_manifest', s.load_id, jsonb_build_object('stop_id', s.id, 'manifest', nullif(trim(p_manifest), ''), 'was', s.manifest));
end $$;

create or replace function stop_manifest_to_invoices() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.manifest is distinct from old.manifest then
    update invoices set manifest = new.manifest, updated_at = now()
     where order_id in (select id from orders where stop_id = new.id) and (manifest is null or manifest is not distinct from old.manifest);
  end if;
  return new;
end $$;
drop trigger if exists stop_manifest_to_invoices on load_stops;
create trigger stop_manifest_to_invoices after update of manifest on load_stops for each row execute function stop_manifest_to_invoices();

-- invoices: the manifest of the order's stop
do $$
declare d text;
begin
  select pg_get_functiondef('_make_invoice(integer)'::regprocedure) into d;
  if d not like '%manifest = (select%' then
    d := replace(d, '  i := recompute_invoice(i.id);',
      '  update invoices set manifest = (select nullif(trim(s.manifest), '''') from load_stops s where s.id = o.stop_id) where id = i.id and manifest is null;
  i := recompute_invoice(i.id);');
    execute d;
  end if;
end $$;

-- =====================================================================================================
-- 4. customer pickups
-- =====================================================================================================
alter table fleet_assets drop constraint if exists fleet_assets_kind_check;
alter table fleet_assets add constraint fleet_assets_kind_check check (kind in ('vehicle', 'trailer', 'equipment'));
insert into fleet_assets (kind, name, department, body_type, pallet_spaces, pallets_across, notes, status)
select 'vehicle', 'Customer pickup', 'distribution', 'Customer pickup', 40, 4, 'Not a real truck: used for loads the customer picks up with their own driver and truck. Don''t retire it.', 'active'
 where not exists (select 1 from fleet_assets where body_type = 'Customer pickup');

create or replace function pickup_vehicle() returns int
language sql stable security definer set search_path = public as $$
  select id from fleet_assets where body_type = 'Customer pickup' order by id limit 1
$$;

-- a pickup: one customer, a date, their driver and truck (can be filled in later)
create or replace function create_pickup(p_customer int, p_date date, p_notes text default null) returns loads
language plpgsql security definer set search_path = public as $$
declare l loads; c customers;
begin
  perform require_staff();
  perform no_view_as();
  select * into c from customers where id = p_customer;
  if c.id is null then raise exception 'Pick the customer'; end if;
  l := create_load(pickup_vehicle(), p_date, jsonb_build_array(jsonb_build_object('customer_id', c.id)), null, p_notes);
  update loads set kind = 'pickup', code = replace(code, 'L-', 'P-'), pickup_license = c.license where id = l.id returning * into l;
  return l;
end $$;

create or replace function set_pickup_driver(p_load int, p_driver text, p_dl text, p_make text, p_model text, p_plate text, p_license text) returns loads
language plpgsql security definer set search_path = public as $$
declare l loads;
begin
  perform require_staff();
  perform no_view_as();
  select * into l from loads where id = p_load for update;
  if l.kind <> 'pickup' then raise exception 'Not a pickup'; end if;
  if l.status not in ('planning', 'loading') then raise exception 'Pickup % has already left', l.code; end if;
  update loads set pickup_driver = nullif(trim(p_driver), ''), pickup_dl = nullif(trim(p_dl), ''), pickup_make = nullif(trim(p_make), ''),
                   pickup_model = nullif(trim(p_model), ''), pickup_plate = nullif(upper(trim(p_plate)), ''), pickup_license = nullif(upper(trim(p_license)), ''),
                   driver = nullif(trim(p_driver), '')
   where id = l.id returning * into l;
  return l;
end $$;

-- the stop as METRC needs it; a pickup has the customer's driver, truck and transport license
create or replace function metrc_stop_info(p_stop int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s load_stops; l loads; c customers; a fleet_assets; site text; dr fleet_drivers; pk boolean;
begin
  select * into s from load_stops where id = p_stop;
  if s.id is null then return null; end if;
  select * into l from loads where id = s.load_id;
  select * into c from customers where id = s.customer_id;
  select * into a from fleet_assets where id = l.vehicle_id;
  pk := l.kind = 'pickup';
  if not pk then
    select * into dr from fleet_drivers where active and lower(name) = lower(trim(l.driver)) order by carrier_id nulls first limit 1;
  end if;
  site := stop_is_site(s.id);
  return jsonb_build_object(
    'stop_id', s.id, 'seq', s.seq, 'status', s.status, 'manifest', s.manifest,
    'load_id', l.id, 'load', l.code, 'load_date', l.load_date, 'load_status', l.status, 'departed_at', l.departed_at, 'pickup', pk,
    'internal', site is not null, 'to_site', site,
    'to_license', coalesce(site_license(site), c.license), 'to_name', coalesce(c.legal_name, c.name), 'customer', c.name,
    'to_address', coalesce(c.ship_to_address, c.address),
    'driver', case when pk then l.pickup_driver else l.driver end,
    'driver_license', case when pk then l.pickup_dl else dr.license_no end, 'driver_carrier', dr.carrier_id,
    'vehicle', case when pk then 'Customer vehicle' else a.name end,
    'make', case when pk then l.pickup_make else a.make end, 'model', case when pk then l.pickup_model else a.model end,
    'plate', case when pk then l.pickup_plate else a.plate end, 'vehicle_carrier', a.carrier_id,
    'transporter', case when pk then coalesce(l.pickup_license, c.license) else transport_license() end,
    'orders', (select coalesce(jsonb_agg(coalesce(o.so_number, 'Order #' || o.id) order by o.id), '[]'::jsonb) from orders o
                where o.stop_id = s.id or exists (select 1 from order_picks x join load_items i on i.pallet_id = x.pallet_id where x.order_id = o.id and i.stop_id = s.id)),
    'packages', (select coalesce(jsonb_agg(to_jsonb(k) order by k.from_site, k.code), '[]'::jsonb) from metrc_stop_packages(s.id) k));
end $$;
revoke all on function metrc_stop_info(int) from public, anon, authenticated;
grant execute on function metrc_stop_info(int) to service_role;

-- does this customer have a license that can carry product (distributor or Type 13 transport)?
alter table customers add column if not exists can_transport boolean;   -- null = unknown (check with compliance)

-- =====================================================================================================
-- 5. shipping
-- =====================================================================================================
-- zones (from Shipping Calculator 2026-04-06.xlsx): designated round-trip price per vehicle class, from 1363 Green Valley Rd
-- (same prices for loads leaving OHR). Miles x $/mi is shown for reference only.
create table if not exists ship_zones (
  id         serial primary key,
  name       text not null unique,
  miles_rt   numeric,
  rate_van   numeric,
  rate_box   numeric,
  price_van  numeric,
  price_box  numeric,
  active     boolean not null default true,
  sort       int not null default 0,
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table ship_zones enable row level security;
drop policy if exists ship_zones_read on ship_zones;
create policy ship_zones_read on ship_zones for select to authenticated using (is_staff());
grant select on ship_zones to authenticated;

insert into ship_zones (name, miles_rt, rate_van, rate_box, price_van, price_box, sort) values
  ('Arcata', 736, 2.35, 2.7, 1750, 2000, 1), ('Redding', 584, 2.35, 2.7, 1375, 1600, 2), ('Willits', 454, 2.35, 2.7, 1075, 1250, 3),
  ('Ukiah', 410, 2.35, 2.7, 975, 1125, 4), ('Sacramento', 324, 2.05, 2.4, 675, 800, 5), ('Santa Rosa', 290, 2.05, 2.4, 600, 700, 6),
  ('San Francisco', 184, 2.05, 2.4, 400, 450, 7), ('Oakland', 172, 2.05, 2.4, 375, 425, 8), ('Hollister', 62, 2.05, 2.4, 150, 150, 9),
  ('Santa Cruz', 38, 2.05, 2.4, 100, 100, 10), ('Monterey', 68, 2.05, 2.4, 150, 175, 11), ('Woodlake', 382, 2.05, 2.4, 800, 925, 12),
  ('San Luis Obispo', 314, 2.05, 2.4, 650, 775, 13), ('Lompoc', 432, 2.35, 2.7, 1025, 1175, 14), ('Lancaster', 624, 2.35, 2.7, 1475, 1700, 15),
  ('Northern LA', 660, 2.35, 2.7, 1575, 1800, 16), ('Central LA', 680, 2.35, 2.7, 1600, 1850, 17), ('Southern LA', 746, 2.35, 2.7, 1775, 2025, 18),
  ('San Diego', 902, 2.35, 2.7, 2125, 2450, 19)
on conflict (name) do nothing;
insert into app_settings (key, value) values ('ship.multi_stop_fee', '100') on conflict (key) do nothing;

-- vehicle price class: van / box (Reefer Van / Reefer Box Truck), carrier (cost typed on the load), pickup
alter table fleet_assets add column if not exists ship_class text;
alter table fleet_assets drop constraint if exists fleet_assets_ship_class_check;
alter table fleet_assets add constraint fleet_assets_ship_class_check check (ship_class is null or ship_class in ('van', 'box', 'carrier', 'pickup'));
update fleet_assets set ship_class = 'pickup' where body_type = 'Customer pickup' and ship_class is null;
update fleet_assets set ship_class = 'carrier' where carrier_id is not null and ship_class is null;

create or replace function vehicle_ship_class(p_vehicle int) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(a.ship_class, case when a.carrier_id is not null then 'carrier' when a.body_type = 'Customer pickup' then 'pickup' else 'box' end)
    from fleet_assets a where a.id = p_vehicle
$$;

-- customer: zone and shipping rule (blank rule = free for contract customers, else calculated)
alter table customers add column if not exists ship_zone_id int references ship_zones(id);
alter table customers add column if not exists ship_rule text;
alter table customers drop constraint if exists customers_ship_rule_check;
alter table customers add constraint customers_ship_rule_check check (ship_rule is null or ship_rule in ('calc', 'free', 'split', 'pickup'));
alter table customers add column if not exists ship_split_pct numeric;

-- zones from the sheet, matched by name or legal name
update customers c set ship_zone_id = z.id
  from (values
  ('1904 Provisions', 'San Diego', '', 'Happy Travels, LLC'),
  ('Abstrax Labs', 'Southern LA', '', 'Abstrax Labs'),
  ('Alive and Well', 'Arcata', '', 'Alive and Well'),
  ('Bear Labs Humboldt', 'Arcata', '', 'Bear Labs Humboldt'),
  ('Big Pete''s LLC', 'Santa Cruz', '', 'Big Pete''s'),
  ('Bloom Network', 'Santa Cruz', '', 'Bloom Network'),
  ('BTC Ventures', 'San Diego', '', 'BTC Ventures'),
  ('Buddies', 'Redding', '', 'Buddies'),
  ('Bustan Inc.', 'Hollister', '', 'Bustan'),
  ('Cal State 2618', 'Northern LA', '', 'Cal State 2618'),
  ('Cali Stripe', 'Monterey', '', 'Coastal Refinement Solutions'),
  ('California Top Crop', 'Woodlake', '', '457 S. Acacia St. Woodlake, CA 93282'),
  ('California Top Crop', 'Woodlake', '', 'California Top Crop'),
  ('CannaCraft', 'Santa Rosa', '', 'CannaCraft'),
  ('Center Street Investments INC', 'San Diego', '', 'Center Street Investments'),
  ('Centro LLC', 'Central LA', '', '8127 Slauson Ave. Montabello, CA, 90640'),
  ('Club Green', 'Sacramento', '', 'Club Green'),
  ('Cruz Science', 'Santa Cruz', '', 'Cruz Science'),
  ('D9 Society', 'Sacramento', '', 'D9 Society'),
  ('Deeper Dive', 'Northern LA', '', 'Deeper Dive'),
  ('Drops Candies', 'Santa Rosa', '', 'Drops Candies'),
  ('Emerald Labs', 'San Diego', '', 'Emerald Labs'),
  ('Emerald Sun', 'Ukiah', '', 'Emerald Sun'),
  ('Euphoric Life, Inc.', 'Hollister', '', 'Euphoric Life, Inc.'),
  ('Final Bell', 'Northern LA', '', 'Final Bell'),
  ('Fire King Hash', 'San Francisco', '', 'Fire King Hash'),
  ('Friendly Farms', 'Sacramento', '', 'Friendly Farms'),
  ('Green Acre Management', 'Southern LA', '', 'Green Acre Management'),
  ('Jetty Extracts', 'Oakland', '', 'Jetty Extracts'),
  ('KGJMK OPCO Inc', 'Southern LA', '', 'KGJMK OPCO Inc'),
  ('Last Minute Ventures', 'Central LA', '', 'Last Minute'),
  ('Lazer Buddha', 'Central LA', '', 'Lazer Buddha'),
  ('LEEF Labs', 'Willits', '', 'LEEF Labs'),
  ('MAR SR', 'Santa Rosa', '', 'MAR SR'),
  ('Master Makers', 'Central LA', '', 'Master Makers'),
  ('Mendocino Mountain Farms', 'Ukiah', '', 'MMF Kelly'),
  ('Natura', 'Sacramento', '', 'Natura'),
  ('NUG', 'Oakland', '', 'NUG'),
  ('Olympic Extracts', 'Southern LA', '', 'Olympic Extracts'),
  ('Pac West', 'Central LA', '', 'Pac West'),
  ('Punch Edibles and Extracts', 'Northern LA', '', 'Punch Edibles and Extracts'),
  ('QCSC LLC', 'Lancaster', '', 'QCSC'),
  ('Rosin Tech Labs', 'Southern LA', '', 'Rosin Tech Labs'),
  ('SLO Driver', 'San Luis Obispo', '', 'SLO Driver'),
  ('Solas Ventures', 'Southern LA', '', 'Solas Ventures'),
  ('Space Camp Industries', 'Central LA', 'Space Camp Industries', 'Space Camp'),
  ('STIIIZY', 'Lompoc', '', 'Clean and Clear LLC'),
  ('TSL Manufacturing LLC', 'Lancaster', '', 'TSL Manufacturing LLC'),
  ('Type 7 Manufacturing', 'Oakland', '', 'Type 7 Manufacturing'),
  ('Worldwide Service Group, LLC', 'Southern LA', '', '1436 W Cowles St. Suite C, Long Beach, CA 90813'),
  ('ARG Group - Rosinc.', 'Northern LA', '', '')
  ) v(acct, zone, ext, legal)
  join ship_zones z on z.name = v.zone
 where c.ship_zone_id is null
   and (lower(trim(c.name)) in (lower(v.acct), nullif(lower(v.ext), ''), nullif(lower(v.legal), '')) or lower(trim(coalesce(c.legal_name, ''))) in (lower(v.acct), nullif(lower(v.legal), '')));
-- Leef: shares 50% of carrier costs (they never ride our trucks; otherwise they pick up)
update customers set ship_rule = 'split', ship_split_pct = 50 where lower(name) like 'leef%' and ship_rule is null;

-- a stop's shipping: on the order / stop as Sales set it
alter table load_stops add column if not exists ship_override numeric;
alter table load_stops add column if not exists ship_override_reason text;
alter table load_stops add column if not exists ship_charge numeric;
alter table load_stops add column if not exists ship_value numeric;
alter table load_stops add column if not exists ship_rule text;
alter table load_stops add column if not exists ship_desc text;
alter table load_stops add column if not exists ship_saved_at timestamptz;
alter table orders add column if not exists shipping_quoted boolean not null default false;

create or replace function customer_ship_rule(p_customer int) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(c.ship_rule, case when is_contract_customer(c.id) then 'free' else 'calc' end) from customers c where c.id = p_customer
$$;

create or replace function zone_price(p_zone int, p_class text) returns numeric
language sql stable security definer set search_path = public as $$
  select case when p_class = 'van' then price_van else price_box end from ship_zones where id = p_zone and active
$$;

-- the run's cost split: per billed customer (in stop order). Zone prices: sum / stops + the multi-stop fee per stop when
-- more than one; carrier: its cost / stops. Then each customer's rule.
create or replace function ship_calc(p_customers int[], p_class text, p_carrier_cost numeric default null)
returns table (customer_id int, zone text, share numeric, rule text, pct numeric, charge numeric, value numeric, descr text, problem text)
language plpgsql stable security definer set search_path = public as $$
declare n int := coalesce(array_length(p_customers, 1), 0); fee numeric := coalesce(nullif((select a.value from app_settings a where a.key = 'ship.multi_stop_fee'), '')::numeric, 100);
        total numeric := 0; missing text; c record; sh numeric; cls text := coalesce(p_class, 'box');
        lbl text := case cls when 'van' then 'reefer van' when 'carrier' then 'carrier' when 'pickup' then 'pickup' else 'reefer box truck' end;
begin
  if n = 0 then return; end if;
  if cls in ('van', 'box') then
    select string_agg(cu.name, ', '), sum(zone_price(cu.ship_zone_id, cls)) into missing, total from unnest(p_customers) x(id) join customers cu on cu.id = x.id
     where zone_price(cu.ship_zone_id, cls) is null;
    select sum(zone_price(cu.ship_zone_id, cls)) into total from unnest(p_customers) x(id) join customers cu on cu.id = x.id;
    sh := case when missing is null then round(total / n + case when n > 1 then fee else 0 end, 2) end;
  elsif cls = 'carrier' then
    sh := case when p_carrier_cost is not null then round(p_carrier_cost / n, 2) end;
    if p_carrier_cost is null then missing := 'carrier cost'; end if;
  else
    sh := 0;
  end if;
  for c in select cu.id, cu.name, z.name as zname, customer_ship_rule(cu.id) as r, cu.ship_split_pct
             from unnest(p_customers) with ordinality x(id, o) join customers cu on cu.id = x.id left join ship_zones z on z.id = cu.ship_zone_id order by x.o loop
    customer_id := c.id; zone := c.zname; share := sh; rule := case when cls = 'pickup' then 'pickup' else c.r end;
    pct := case when rule = 'split' then coalesce(c.ship_split_pct, 50) end;
    value := sh; problem := null;
    if rule = 'pickup' then
      charge := 0; descr := 'Customer pickup'; value := null;
    elsif rule = 'free' then
      charge := 0;
      descr := 'FREE contract shipping' || case when sh is not null then ' (value $' || to_char(sh, 'FM999,999,990.00') || ')' else '' end;
    elsif sh is null then
      charge := null; descr := null;
      problem := case when cls = 'carrier' then 'Enter the carrier''s cost on the load (or type the shipping charge for ' || c.name || ')'
                      else 'No shipping zone for ' || missing || '. Set the zone, or type the shipping charge.' end;
    elsif rule = 'split' then
      charge := round(sh * (1 - pct / 100), 2);
      descr := 'Shipping (' || lbl || coalesce(', ' || c.zname, '') || '): $' || to_char(sh, 'FM999,999,990.00') || ', Lifted pays ' || trim(to_char(pct, 'FM990.##')) || '%';
    else
      charge := sh;
      descr := 'Shipping (' || lbl || coalesce(', ' || c.zname, '') || case when n > 1 then ', shared run of ' || n || ' stops' else '' end || ')';
    end if;
    return next;
  end loop;
end $$;

-- a stop's shipping now (quoted on the order or typed on the stop wins over the calculation)
create or replace function stop_shipping(p_stop int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s load_stops; l loads; cls text; ids int[]; r record; q numeric; out jsonb;
begin
  select * into s from load_stops where id = p_stop;
  if s.id is null then return null; end if;
  if not stop_is_billed(s.id) then return jsonb_build_object('billed', false); end if;
  if s.ship_saved_at is not null then
    return jsonb_build_object('billed', true, 'saved', true, 'rule', s.ship_rule, 'charge', s.ship_charge, 'value', s.ship_value, 'descr', s.ship_desc,
                              'override', s.ship_override, 'reason', s.ship_override_reason);
  end if;
  select * into l from loads where id = s.load_id;
  cls := case when l.kind = 'pickup' then 'pickup' else vehicle_ship_class(l.vehicle_id) end;
  select array_agg(st.customer_id order by st.seq) into ids from load_stops st where st.load_id = l.id and stop_is_billed(st.id);
  select * into r from ship_calc(ids, cls, l.carrier_cost) x where x.customer_id = s.customer_id limit 1;
  select sum(o.shipping) into q from orders o where o.stop_id = s.id and o.shipping_quoted and o.shipping is not null and o.status = 'pending';
  out := jsonb_build_object('billed', true, 'class', cls, 'zone', r.zone, 'share', r.share, 'rule', r.rule, 'pct', r.pct, 'stops', coalesce(array_length(ids, 1), 0),
                            'calc_charge', r.charge, 'value', r.value, 'descr', r.descr, 'problem', r.problem, 'quoted', q,
                            'override', s.ship_override, 'reason', s.ship_override_reason);
  if r.rule = 'pickup' then
    out := out || jsonb_build_object('charge', 0, 'problem', null);
  elsif s.ship_override is not null then
    out := out || jsonb_build_object('charge', s.ship_override, 'problem', null,
              'descr', case when s.ship_override = 0 then 'Shipping: no charge' else 'Shipping' end || coalesce(' (' || s.ship_override_reason || ')', ''));
  elsif q is not null then
    out := out || jsonb_build_object('charge', q, 'problem', null, 'descr', 'Shipping (as quoted)');
  else
    out := out || jsonb_build_object('charge', r.charge);
  end if;
  return out;
end $$;

create or replace function stop_shipping_save(p_stop int) returns void
language plpgsql security definer set search_path = public as $$
declare sh jsonb := stop_shipping(p_stop);
begin
  if not coalesce((sh ->> 'billed')::boolean, false) or coalesce((sh ->> 'saved')::boolean, false) then return; end if;
  update load_stops set ship_charge = (sh ->> 'charge')::numeric, ship_value = (sh ->> 'value')::numeric, ship_rule = sh ->> 'rule',
                        ship_desc = sh ->> 'descr', ship_saved_at = now()
   where id = p_stop;
end $$;

-- a new order invoice gets its shipping line: from its stop (once per stop) if it went on a load, else from the order
create or replace function invoice_shipping_line() returns trigger
language plpgsql security definer set search_path = public as $$
declare o orders; c customers; s load_stops;
begin
  if new.order_id is null or new.nursery_order_id is not null then return new; end if;
  select * into o from orders where id = new.order_id;
  select * into c from customers where id = new.customer_id;
  if c.kind is distinct from 'external' then return new; end if;
  if o.stop_id is not null then select * into s from load_stops where id = o.stop_id; end if;
  if s.ship_saved_at is not null then
    if s.ship_rule = 'pickup' then return new; end if;
    -- one shipping line per stop: on the first order's invoice
    if o.id <> (select min(id) from orders where stop_id = s.id and status <> 'cancelled') then return new; end if;
    insert into invoice_lines (invoice_id, sort, kind, item, description, qty, uom, price, acct_product)
    values (new.id, 1000, 'charge', 'Customer Shipping', coalesce(s.ship_desc, 'Shipping'), 1, 'ea', coalesce(s.ship_charge, 0), 'SHIPPING');
    return new;
  end if;
  if coalesce(o.shipping, 0) > 0 then
    insert into invoice_lines (invoice_id, sort, kind, item, description, qty, uom, price, acct_product)
    values (new.id, 1000, 'charge', 'Customer Shipping', 'Shipping', 1, 'ea', o.shipping, 'SHIPPING');
  elsif customer_ship_rule(c.id) = 'free' then
    insert into invoice_lines (invoice_id, sort, kind, item, description, qty, uom, price, acct_product)
    values (new.id, 1000, 'charge', 'Customer Shipping', 'FREE contract shipping', 1, 'ea', 0, 'SHIPPING');
  elsif o.shipping = 0 then
    insert into invoice_lines (invoice_id, sort, kind, item, description, qty, uom, price, acct_product)
    values (new.id, 1000, 'charge', 'Customer Shipping', 'Free shipping', 1, 'ea', 0, 'SHIPPING');
  end if;
  return new;
end $$;

-- Sales: type a stop's shipping (blank = calculated again)
create or replace function set_stop_shipping(p_stop int, p_amount numeric, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s load_stops; l loads;
begin
  perform no_view_as();
  if not can_edit('sales') then raise exception 'Only Sales can change shipping'; end if;
  select * into s from load_stops where id = p_stop for update;
  if s.id is null then raise exception 'Stop not found'; end if;
  select * into l from loads where id = s.load_id;
  if l.status not in ('planning', 'loading', 'departing') then raise exception 'Load % has left. Change shipping on the invoice.', l.code; end if;
  if p_amount is not null and p_amount < 0 then raise exception 'Shipping can''t be negative'; end if;
  if p_amount is not null and nullif(trim(p_reason), '') is null then raise exception 'Say why (it shows on the invoice)'; end if;
  update load_stops set ship_override = p_amount, ship_override_reason = case when p_amount is null then null else trim(p_reason) end where id = s.id;
  insert into events (user_email, type, load_id, details)
  values (current_email(), 'stop_shipping', l.id, jsonb_build_object('stop_id', s.id, 'amount', p_amount, 'reason', p_reason, 'was', s.ship_override));
  return stop_shipping(s.id);
end $$;

create or replace function set_load_carrier_cost(p_load int, p_cost numeric) returns void
language plpgsql security definer set search_path = public as $$
declare l loads;
begin
  perform require_staff();
  perform no_view_as();
  if not (can_edit('sales') or mod_level('distribution') = 'admin') then raise exception 'Only Sales or a Distribution Admin'; end if;
  select * into l from loads where id = p_load for update;
  if l.status not in ('planning', 'loading', 'departing') then raise exception 'Load % has left', l.code; end if;
  if p_cost is not null and p_cost < 0 then raise exception 'Cost can''t be negative'; end if;
  update loads set carrier_cost = p_cost where id = l.id;
  insert into events (user_email, type, load_id, details) values (current_email(), 'load_carrier_cost', l.id, jsonb_build_object('cost', p_cost, 'was', l.carrier_cost));
end $$;

-- order: shipping amount, and whether Sales quoted it to the customer (a quote wins over the load's calculation)
drop function if exists set_order_shipping(int, numeric);
create or replace function set_order_shipping(p_order int, p_amount numeric, p_quoted boolean default false) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform no_view_as();
  if not can_edit('sales') then raise exception 'Only Sales can change shipping'; end if;
  if p_amount < 0 then raise exception 'Shipping can''t be negative'; end if;
  update orders set shipping = p_amount, shipping_quoted = coalesce(p_quoted, false) and p_amount is not null, updated_at = now() where id = p_order;
  if not found then raise exception 'Order not found'; end if;
end $$;

-- estimate for one customer (order screen, quick quote): a single stop
create or replace function ship_quote(p_customers int[], p_class text, p_carrier_cost numeric default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_staff();
  return coalesce((select jsonb_agg(jsonb_build_object('customer_id', x.customer_id, 'customer', c.name, 'zone', x.zone, 'share', x.share, 'rule', x.rule,
            'pct', x.pct, 'charge', x.charge, 'value', x.value, 'descr', x.descr, 'problem', x.problem,
            'address', coalesce(c.ship_to_address, c.address)))
     from ship_calc(p_customers, p_class, p_carrier_cost) x join customers c on c.id = x.customer_id), '[]');
end $$;

-- settings: zones, customer shipping, vehicle class (Sales Admin or Distribution Admin)
create or replace function ship_admin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  perform no_view_as();
  if not (mod_level('sales') = 'admin' or mod_level('distribution') = 'admin' or is_admin()) then raise exception 'Only a Sales or Distribution Admin'; end if;
end $$;

create or replace function save_ship_zone(p_id int, p_name text, p_miles numeric, p_rate_van numeric, p_rate_box numeric,
                                          p_price_van numeric, p_price_box numeric, p_active boolean default true) returns ship_zones
language plpgsql security definer set search_path = public as $$
declare z ship_zones;
begin
  perform ship_admin();
  if nullif(trim(p_name), '') is null then raise exception 'Name the zone'; end if;
  if p_id is null then
    insert into ship_zones (name, miles_rt, rate_van, rate_box, price_van, price_box, active, sort, updated_by)
    values (trim(p_name), p_miles, p_rate_van, p_rate_box, p_price_van, p_price_box, coalesce(p_active, true),
            coalesce((select max(sort) from ship_zones), 0) + 1, current_email()) returning * into z;
  else
    update ship_zones set name = trim(p_name), miles_rt = p_miles, rate_van = p_rate_van, rate_box = p_rate_box, price_van = p_price_van,
                          price_box = p_price_box, active = coalesce(p_active, true), updated_by = current_email(), updated_at = now()
     where id = p_id returning * into z;
  end if;
  insert into events (user_email, type, details) values (current_email(), 'ship_zone_saved', to_jsonb(z));
  return z;
end $$;

create or replace function set_customer_shipping(p_customer int, p_zone int, p_rule text, p_pct numeric default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform no_view_as();
  if not can_edit('sales') then raise exception 'Only Sales can change shipping'; end if;
  if p_rule is not null and p_rule not in ('calc', 'free', 'split', 'pickup') then raise exception 'Pick a shipping rule'; end if;
  if p_rule = 'split' and (p_pct is null or p_pct <= 0 or p_pct > 100) then raise exception 'Enter the percent Lifted pays'; end if;
  update customers set ship_zone_id = p_zone, ship_rule = p_rule, ship_split_pct = case when p_rule = 'split' then p_pct end where id = p_customer;
  if not found then raise exception 'Customer not found'; end if;
  insert into events (user_email, type, details) values (current_email(), 'customer_shipping', jsonb_build_object('customer_id', p_customer, 'zone', p_zone, 'rule', p_rule, 'pct', p_pct));
end $$;

create or replace function set_vehicle_ship_class(p_vehicle int, p_class text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform ship_admin();
  if p_class is not null and p_class not in ('van', 'box', 'carrier') then raise exception 'Pick van, box truck or carrier'; end if;
  update fleet_assets set ship_class = p_class, updated_at = now() where id = p_vehicle and coalesce(body_type, '') <> 'Customer pickup';
end $$;

-- what the app reads for shipping settings
create or replace function ship_settings() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_staff();
  return jsonb_build_object(
    'fee', coalesce(nullif((select value from app_settings where key = 'ship.multi_stop_fee'), '')::numeric, 100),
    'zones', (select coalesce(jsonb_agg(to_jsonb(z) order by z.sort, z.name), '[]') from ship_zones z),
    'customers', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'zone_id', c.ship_zone_id, 'rule', c.ship_rule,
                          'pct', c.ship_split_pct, 'auto_rule', customer_ship_rule(c.id), 'contract', is_contract_customer(c.id)) order by c.name), '[]')
                    from customers c where c.kind = 'external' and coalesce(c.active, true)),
    'vehicles', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'class', a.ship_class, 'auto_class', vehicle_ship_class(a.id),
                          'carrier', a.carrier_id is not null) order by a.name), '[]')
                   from fleet_assets a where a.kind in ('vehicle', 'trailer') and a.status <> 'retired'
                    and (a.department = 'distribution' or a.carrier_id is not null) and coalesce(a.body_type, '') <> 'Customer pickup'));
end $$;

-- =====================================================================================================
-- 6. QuickBooks: send 30 minutes after the invoice is made; pull price changes back
-- =====================================================================================================
alter table invoices add column if not exists acct_push_after timestamptz;   -- when the auto-send may go (null = not queued)
alter table invoices add column if not exists acct_flags jsonb not null default '[]';   -- QuickBooks changes the app didn't copy (qty, unknown lines)
alter table acct_pushes add column if not exists line_map jsonb;             -- [{line_id, qbo_line_id, as_amount}] in QuickBooks line order
alter table acct_pushes add column if not exists pulled_at timestamptz;
insert into app_settings (key, value) values ('acct.auto_push', 'true'), ('acct.auto_push_minutes', '30') on conflict (key) do nothing;

create table if not exists acct_push_locks (invoice_id int not null, env text not null, at timestamptz not null default now(), primary key (invoice_id, env));
alter table acct_push_locks enable row level security;
revoke all on acct_push_locks from anon, authenticated;

create or replace function acct_hold_minutes() returns int
language sql stable security definer set search_path = public as $$
  select coalesce(nullif((select value from app_settings where key = 'acct.auto_push_minutes'), '')::int, 30)
$$;

-- new invoices for outside customers are queued; editing an unsent one restarts the clock
create or replace function invoice_queue_push() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if coalesce((select value from app_settings where key = 'acct.auto_push'), 'true') = 'true'
       and (select kind from customers where id = new.customer_id) = 'external' and new.status <> 'void' then
      new.acct_push_after := now() + make_interval(mins => acct_hold_minutes());
    end if;
  elsif new.acct_push_after is not null and new.acct_status <> 'sent'
        and (new.terms_code, new.invoice_date, new.po_number, new.notes) is distinct from (old.terms_code, old.invoice_date, old.po_number, old.notes) then
    new.acct_push_after := greatest(new.acct_push_after, now() + make_interval(mins => acct_hold_minutes()));
  end if;
  if new.status = 'void' then new.acct_push_after := null; end if;
  return new;
end $$;
drop trigger if exists invoice_queue_push on invoices;
create trigger invoice_queue_push before insert or update on invoices for each row execute function invoice_queue_push();

create or replace function invoice_line_bump() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if current_setting('app.qbo_pull', true) = 'on' then return null; end if;
  update invoices set acct_push_after = greatest(acct_push_after, now() + make_interval(mins => acct_hold_minutes()))
   where id = coalesce(new.invoice_id, old.invoice_id) and acct_push_after is not null and acct_status <> 'sent'
     and created_at < now() - interval '5 seconds';   -- not while the invoice is being made
  return null;
end $$;
drop trigger if exists invoice_line_bump on invoice_lines;
create trigger invoice_line_bump after insert or update or delete on invoice_lines for each row execute function invoice_line_bump();

-- the server: invoices due to go (not sent in this QuickBooks yet, not being sent right now)
create or replace function acct_autopush_due(p_env text) returns setof int
language sql stable security definer set search_path = public as $$
  select i.id from invoices i join customers c on c.id = i.customer_id
   where i.acct_push_after is not null and i.acct_push_after <= now() and i.status <> 'void' and c.kind = 'external'
     and not exists (select 1 from acct_pushes p where p.invoice_id = i.id and p.env = p_env and p.status = 'sent')
     and not exists (select 1 from acct_push_locks k where k.invoice_id = i.id and k.env = p_env and k.at > now() - interval '5 minutes')
   order by i.acct_push_after, i.id limit 40
$$;

-- one send at a time per invoice (two clicks or the auto-send and a click can't make two QuickBooks invoices)
create or replace function acct_claim_push(p_inv int, p_env text) returns boolean
language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  insert into acct_push_locks (invoice_id, env, at) values (p_inv, p_env, now())
  on conflict (invoice_id, env) do update set at = now() where acct_push_locks.at <= now() - interval '5 minutes'
  returning true into ok;
  return coalesce(ok, false);
end $$;
create or replace function acct_release_push(p_inv int, p_env text) returns void
language sql security definer set search_path = public as $$ delete from acct_push_locks where invoice_id = p_inv and env = p_env $$;

-- after a send: remember which QuickBooks line is which app line; stop the auto-send (an error retries in an hour)
drop function if exists acct_record_push(int, text, text, text, numeric, numeric, text, text);
create or replace function acct_record_push(p_inv int, p_env text, p_qbo_id text, p_doc text, p_total numeric, p_balance numeric, p_error text, p_by text,
                                            p_line_map jsonb default null) returns void
language plpgsql security definer set search_path = public as $$
declare i invoices;
begin
  if auth.role() <> 'service_role' then raise exception 'Server only'; end if;
  select * into i from invoices where id = p_inv;
  if p_error is null then
    insert into acct_pushes (invoice_id, env, status, qbo_id, doc_number, total, balance, error, sent_by, sent_at, synced_at, line_map)
    values (p_inv, p_env, 'sent', p_qbo_id, p_doc, p_total, p_balance, null, p_by, now(), now(), p_line_map)
    on conflict (invoice_id, env) do update set status = 'sent', qbo_id = excluded.qbo_id, doc_number = excluded.doc_number, total = excluded.total,
      balance = excluded.balance, error = null, sent_by = excluded.sent_by, sent_at = now(), synced_at = now(),
      line_map = coalesce(excluded.line_map, acct_pushes.line_map);
    if p_env = 'production' then
      update invoices set acct_status = 'sent', acct_ref = p_qbo_id, acct_error = null, acct_push_after = null, updated_at = now() where id = p_inv;
    else
      update invoices set acct_push_after = null where id = p_inv;
    end if;
  else
    insert into acct_pushes (invoice_id, env, status, error, sent_by, sent_at)
    values (p_inv, p_env, 'error', p_error, p_by, now())
    on conflict (invoice_id, env) do update set status = case when acct_pushes.status = 'sent' then 'sent' else 'error' end,
      error = excluded.error, sent_by = excluded.sent_by, sent_at = case when acct_pushes.status = 'sent' then acct_pushes.sent_at else now() end;
    if p_env = 'production' and i.acct_status <> 'sent' then
      update invoices set acct_status = 'error', acct_error = p_error, updated_at = now() where id = p_inv;
    end if;
    update invoices set acct_push_after = case when acct_push_after is not null then now() + interval '1 hour' end where id = p_inv;
  end if;
  delete from acct_push_locks where invoice_id = p_inv and env = p_env;
  insert into events (user_email, type, note, details)
  values (coalesce(p_by, 'system'), case when p_error is null then 'acct_sent' else 'acct_error' end, p_error,
          jsonb_build_object('invoice_id', p_inv, 'inv', i.inv_number, 'env', p_env, 'qbo_id', p_qbo_id, 'total', p_total));
end $$;
revoke execute on function acct_record_push(int,text,text,text,numeric,numeric,text,text,jsonb) from public, anon, authenticated;
grant execute on function acct_record_push(int,text,text,text,numeric,numeric,text,text,jsonb) to service_role;

-- prices changed in QuickBooks come back. p_lines: QuickBooks' lines in order [{qbo_line_id, item, qty, price, amount, description}].
-- Quantities never change here (they match METRC): a different quantity, a removed line or a line with an unknown product is flagged.
create or replace function acct_pull_lines(p_inv int, p_env text, p_lines jsonb, p_updated text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pu acct_pushes; i invoices; q jsonb; m jsonb; l invoice_lines; flags jsonb := '[]'; changes jsonb := '[]'; prod text; seen int[] := '{}';
        newp numeric; mapped int[] := '{}'; k int := 0;
begin
  if auth.role() <> 'service_role' then raise exception 'Server only'; end if;
  select * into pu from acct_pushes where invoice_id = p_inv and env = p_env;
  select * into i from invoices where id = p_inv;
  if pu.invoice_id is null or i.id is null or pu.line_map is null or i.status = 'void' then return jsonb_build_object('skipped', true); end if;
  perform set_config('app.qbo_pull', 'on', true);
  select array_agg((x ->> 'line_id')::int) into mapped from jsonb_array_elements(pu.line_map) x;
  for q in select * from jsonb_array_elements(coalesce(p_lines, '[]')) loop
    k := k + 1;
    select x into m from jsonb_array_elements(pu.line_map) x where x ->> 'qbo_line_id' = q ->> 'qbo_line_id' limit 1;
    if m is null then
      -- a line added in QuickBooks: copied if its product is one the app knows
      select r.key into prod from qbo_refs r where r.env = p_env and r.kind = 'item' and r.qbo_id = q ->> 'item' limit 1;
      if prod is not null and exists (select 1 from acct_products where code = prod) then
        insert into invoice_lines (invoice_id, sort, kind, item, description, qty, uom, price, acct_product)
        values (i.id, 2000 + k, 'charge', (select name from acct_products where code = prod), coalesce(nullif(q ->> 'description', ''), 'Added in QuickBooks'),
                coalesce((q ->> 'qty')::numeric, 1), 'ea', coalesce((q ->> 'price')::numeric, (q ->> 'amount')::numeric, 0), prod)
        returning * into l;
        update acct_pushes set line_map = line_map || jsonb_build_array(jsonb_build_object('line_id', l.id, 'qbo_line_id', q ->> 'qbo_line_id'))
         where invoice_id = p_inv and env = p_env;
        changes := changes || jsonb_build_object('added', l.description, 'amount', round(l.qty * l.price, 2));
      else
        flags := flags || to_jsonb(format('Line added in QuickBooks the app doesn''t know: "%s" $%s. Not copied.', left(coalesce(q ->> 'description', ''), 80), q ->> 'amount'));
      end if;
      continue;
    end if;
    select * into l from invoice_lines where id = (m ->> 'line_id')::int;
    if l.id is null then continue; end if;
    seen := seen || l.id;
    if coalesce((m ->> 'split')::boolean, false) then
      -- one app line sent as one QuickBooks line per farm: the price is what can change
      newp := (q ->> 'price')::numeric;
    elsif coalesce((m ->> 'as_amount')::boolean, false) then
      newp := case when l.qty <> 0 then round((q ->> 'amount')::numeric / l.qty, 4) end;
    else
      if (q ->> 'qty') is not null and abs((q ->> 'qty')::numeric - l.qty) > 0.005 then
        flags := flags || to_jsonb(format('Quantity changed in QuickBooks on "%s": %s here, %s there. The app keeps %s (it matches METRC).',
                   left(split_part(l.description, E'\n', 1), 60), l.qty, q ->> 'qty', l.qty));
      end if;
      newp := (q ->> 'price')::numeric;
    end if;
    if newp is not null and abs(newp - l.price) > 0.00005 then
      update invoice_lines set price = newp where id = l.id;
      changes := changes || jsonb_build_object('line', left(split_part(l.description, E'\n', 1), 80), 'from', l.price, 'to', newp);
    end if;
  end loop;
  select string_agg(left(split_part(x.description, E'\n', 1), 60), '; ') into prod
    from invoice_lines x where x.id = any(mapped) and not (x.id = any(seen)) and x.invoice_id = i.id;
  if prod is not null then flags := flags || to_jsonb(format('Removed in QuickBooks (still on the app invoice): %s', prod)); end if;
  if jsonb_array_length(changes) > 0 then
    perform recompute_invoice(i.id);
    insert into events (user_email, type, details)
    values ('quickbooks', 'invoice_qbo_change', jsonb_build_object('invoice_id', i.id, 'inv', i.inv_number, 'env', p_env, 'changes', changes));
  end if;
  update invoices set acct_flags = flags where id = i.id and acct_flags is distinct from flags;
  update acct_pushes set pulled_at = now() where invoice_id = p_inv and env = p_env;
  perform set_config('app.qbo_pull', 'off', true);
  return jsonb_build_object('changes', changes, 'flags', flags);
end $$;
revoke execute on function acct_pull_lines(int, text, jsonb, text) from public, anon, authenticated;
grant execute on function acct_pull_lines(int, text, jsonb, text) to service_role;
revoke execute on function acct_autopush_due(text) from public, anon, authenticated;
revoke execute on function acct_claim_push(int, text) from public, anon, authenticated;
revoke execute on function acct_release_push(int, text) from public, anon, authenticated;
grant execute on function acct_autopush_due(text), acct_claim_push(int, text), acct_release_push(int, text) to service_role;

-- invoices already made before this (and not sent yet) are not auto-sent: Accounting sends those by hand as before

-- =====================================================================================================
-- 7. permissions and what the app reads
-- =====================================================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'order_fill(int)', 'load_blockers(int)', 'depart_prepare(int)', 'depart_finish(int)', 'depart_back(int)', 'set_stop_manifest(int,text)',
    'create_pickup(int,date,text)', 'set_pickup_driver(int,text,text,text,text,text,text)', 'stop_shipping(int)',
    'set_stop_shipping(int,numeric,text)', 'set_load_carrier_cost(int,numeric)', 'set_order_shipping(int,numeric,boolean)', 'ship_quote(int[],text,numeric)',
    'save_ship_zone(int,text,numeric,numeric,numeric,numeric,numeric,boolean)', 'set_customer_shipping(int,int,text,numeric)',
    'set_vehicle_ship_class(int,text)', 'ship_settings()', 'pick_part(int,bigint,numeric,text,boolean)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array['editable_item(bigint)', 'pallet_workable(pallets)', 'order_load_check(orders)', 'stop_is_site(int)', 'stop_is_billed(int)',
    'load_item_like(bigint,load_items)', 'stop_needs_manifest(int)', 'stop_manifest_ok(int)', 'stop_shipping_save(int)', 'pickup_vehicle()',
    'vehicle_ship_class(int)', 'customer_ship_rule(int)', 'zone_price(int,text)', 'ship_calc(int[],text,numeric)', 'ship_admin()', 'acct_hold_minutes()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;
grant execute on function editable_item(bigint), pallet_workable(pallets), stop_is_site(int), stop_is_billed(int), stop_needs_manifest(int),
  stop_manifest_ok(int), vehicle_ship_class(int), customer_ship_rule(int), zone_price(int,text) to service_role;

-- Fulfillment: how complete each order is, even on a load
do $$
declare d text;
begin
  select pg_get_functiondef('fulfillment_orders(int)'::regprocedure) into d;
  if d not like '%''fill'', order_fill%' then
    d := replace(d, '''state'', order_state(o.id),', '''state'', order_state(o.id), ''fill'', order_fill(o.id), ''shipping'', o.shipping, ''shipping_quoted'', o.shipping_quoted,');
    d := replace(d, '''stop_status'', s.status)', '''stop_status'', s.status, ''load_kind'', l.kind, ''manifest'', s.manifest)');
    execute d;
  end if;
end $$;

select 'zones' as what, count(*)::text as n from ship_zones
union all select 'customers with a zone', count(*)::text from customers where ship_zone_id is not null
union all select 'outside customers without a zone', string_agg(name, ', ' order by name) from customers where kind = 'external' and active and ship_zone_id is null
union all select 'split shipping', string_agg(name || ' ' || ship_split_pct || '%', ', ') from customers where ship_rule = 'split';

-- invoice documents show the METRC manifest number (and the QuickBooks send time)
do $$
declare d text;
begin
  select pg_get_functiondef('_doc(text,integer)'::regprocedure) into d;
  if d not like '%''manifest'', i.manifest%' then
    d := replace(d, '''acct_status'', i.acct_status, ''sent_at'', i.sent_at,',
                    '''acct_status'', i.acct_status, ''sent_at'', i.sent_at, ''manifest'', i.manifest, ''push_after'', i.acct_push_after, ''acct_flags'', i.acct_flags,');
    execute d;
  end if;
end $$;

-- Accounting lists: when each one goes, and what QuickBooks changed that the app didn't copy
do $$
declare d text;
begin
  select pg_get_functiondef('acct_invoices()'::regprocedure) into d;
  if d not like '%push_after%' then
    d := replace(d, '''acct_status'', i.acct_status, ''acct_ref'', i.acct_ref, ''paid_at'', i.paid_at,',
                    '''acct_status'', i.acct_status, ''acct_ref'', i.acct_ref, ''paid_at'', i.paid_at, ''push_after'', i.acct_push_after, ''flags'', i.acct_flags,');
    execute d;
  end if;
end $$;
