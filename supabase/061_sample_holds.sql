-- Migration 061 (feedback #3, Matt): sample lines hold product for the customer.
-- A customer (portal) or Sales marks any line of an order as a sample (so samples can ride along on a full order) and,
-- for that strain, asks for an amount to hold (their likely order). Updated 10/24: sample is per line, not per order.
-- The hold starts when the order is placed, runs until N days after it ships, and goes away if the order is cancelled.
-- The hold comes off the open menu for everyone else while the sample is on its way, and for N days after it ships
-- (customer setting, default 10). Whatever that customer orders of the strain afterwards uses the hold up.
-- Sales can release or extend a hold. Nothing runs on a schedule: a hold simply stops counting when it expires.
-- Safe to re-run.

alter table orders add column if not exists is_sample boolean not null default false;
alter table order_lines add column if not exists is_sample boolean not null default false;
alter table order_lines add column if not exists hold_lbs numeric;
alter table order_lines add column if not exists hold_until date;            -- Sales override (extend / shorten)
alter table order_lines add column if not exists hold_released_at timestamptz;
alter table order_lines add column if not exists hold_released_by text;
alter table customers add column if not exists sample_hold_days int;
alter table order_lines drop constraint if exists order_lines_hold_lbs_check;
alter table order_lines add constraint order_lines_hold_lbs_check check (hold_lbs is null or hold_lbs >= 0);
alter table customers drop constraint if exists customers_sample_hold_days_check;
alter table customers add constraint customers_sample_hold_days_check check (sample_hold_days is null or sample_hold_days between 0 and 120);
insert into app_settings (key, value) values ('sales.sample_hold_days', '10') on conflict (key) do nothing;
-- orders marked as a sample by the first version: their fresh frozen lines are the sample lines
update order_lines l set is_sample = true from orders o
 where o.id = l.order_id and o.is_sample and not l.is_sample and l.product = 'fresh_frozen';
-- orders.is_sample now just means "has a sample line" (for the Sample pill)

create or replace function sample_hold_days(p_customer int) returns int
language sql stable security definer set search_path = public as $$
  select coalesce((select sample_hold_days from customers where id = p_customer),
                  (select nullif(value, '')::int from app_settings where key = 'sales.sample_hold_days'), 10)
$$;

-- every sample hold and where it stands: waiting (sample not shipped yet, already holding), active, expired, used, released, cancelled
create or replace function _sample_holds() returns table (
  line_id int, order_id int, so_number text, customer_id int, strain text, crop_year int, hold_lbs numeric, used_lbs numeric,
  remaining numeric, placed_on date, shipped_on date, until date, state text)
language sql stable security definer set search_path = public as $$
  select l.id, o.id, o.so_number, o.customer_id, l.strain, l.crop_year, l.hold_lbs, u.used,
         greatest(l.hold_lbs - u.used, 0), o.order_date, case when o.status = 'shipped' then coalesce(o.shipped_date, o.order_date) end,
         coalesce(l.hold_until, case when o.status = 'shipped' then coalesce(o.shipped_date, o.order_date) + sample_hold_days(o.customer_id) end),
         case when l.hold_released_at is not null then 'released'
              when o.status in ('cancelled', 'draft') then 'cancelled'
              when l.hold_lbs - u.used <= 0 then 'used'
              when l.hold_until is not null and l.hold_until < current_date then 'expired'
              when l.hold_until is null and o.status = 'shipped' and coalesce(o.shipped_date, o.order_date) + sample_hold_days(o.customer_id) < current_date then 'expired'
              when l.hold_until is null and o.status <> 'shipped' then 'waiting'
              else 'active' end
    from orders o
    join order_lines l on l.order_id = o.id
    -- used = what they ordered of it after the sample, beyond what their reserve already covers (an order draws on the reserve first)
    cross join lateral (
      select least(coalesce(sum(l2.lbs) filter (where not l2.is_sample and o2.created_at > o.created_at), 0),
                   greatest(coalesce(sum(l2.lbs), 0) - coalesce((select sum(r.lbs) from reserves r where r.customer_id = o.customer_id
                              and lower(r.strain) = lower(l.strain) and r.crop_year = l.crop_year and r.product = 'fresh_frozen'), 0), 0)) as used
        from orders o2 join order_lines l2 on l2.order_id = o2.id
       where o2.customer_id = o.customer_id and o2.status in ('submitted','pending','shipped')
         and lower(l2.strain) = lower(l.strain) and l2.crop_year = l.crop_year and l2.product = 'fresh_frozen') u
   where l.is_sample and coalesce(l.hold_lbs, 0) > 0 and l.product = 'fresh_frozen'
$$;
revoke execute on function _sample_holds() from public, anon, authenticated;

-- the menu math (020) + sample holds: held for that customer, off the open menu for everyone else
create or replace function _menu_numbers()
returns table (strain text, crop_year int, on_menu boolean, on_hand numeric, pending numeric, reserved_left numeric, held numeric, free numeric)
language sql stable security definer set search_path = public as $$
  with cy as (select crop_year() as y),
  names as (
    select canonical_strain(p.strain) as s, coalesce(extract(year from p.harvest_date)::int, (select y from cy)) as yr,
           sum(coalesce(p.current_weight, 0)) as lbs
      from pallets p
     where p.kind = 'package' and p.product = 'fresh_frozen' and p.status in ('in_freezer','unslotted') and p.pushed and p.strain is not null
     group by 1, 2),
  pend as (
    select lower(l.strain) as k, l.crop_year as yr, sum(l.lbs) as lbs from orders o join order_lines l on l.order_id = o.id
     where o.status in ('pending','submitted') and l.product = 'fresh_frozen' group by 1, 2),
  res as (select lower(b.strain) as k, sum(b.remaining) as lbs from reserve_balances b where b.crop_year = (select y from cy) group by 1),
  held as (
    select lower(q.strain) as k, sum(greatest(q.requested_lbs - coalesce(r.lbs, 0), 0)) as lbs
      from reserve_requests q
      left join reserves r on r.customer_id = q.customer_id and lower(r.strain) = lower(q.strain) and r.product = 'fresh_frozen' and r.crop_year = q.crop_year
     where q.status = 'pending' and q.crop_year = (select y from cy) group by 1),
  samp as (select lower(h.strain) as k, h.crop_year as yr, sum(h.remaining) as lbs from _sample_holds() h where h.state in ('waiting','active') group by 1, 2),
  allk as (
    select s as name, yr from names where s is not null
    union select r.strain, r.crop_year from reserves r where r.crop_year = (select y from cy)
    union select l.strain, l.crop_year from orders o join order_lines l on l.order_id = o.id where o.status in ('pending','submitted') and l.product = 'fresh_frozen'),
  k as (select distinct on (lower(name), yr) name, yr from allk order by lower(name), yr, name)
  select k.name, k.yr,
         coalesce((select st.show_on_menu from strains st where lower(st.name) = lower(k.name) limit 1), true),
         coalesce(n.lbs, 0), coalesce(pe.lbs, 0),
         case when k.yr = (select y from cy) then coalesce(re.lbs, 0) else 0 end,
         case when k.yr = (select y from cy) then coalesce(h.lbs, 0) else 0 end + coalesce(sp.lbs, 0),
         coalesce(n.lbs, 0) - coalesce(pe.lbs, 0) - coalesce(sp.lbs, 0)
           - case when k.yr = (select y from cy) then coalesce(re.lbs, 0) + coalesce(h.lbs, 0) else 0 end
    from k
    left join names n on lower(n.s) = lower(k.name) and n.yr = k.yr
    left join pend pe on pe.k = lower(k.name) and pe.yr = k.yr
    left join res re on re.k = lower(k.name)
    left join held h on h.k = lower(k.name)
    left join samp sp on sp.k = lower(k.name) and sp.yr = k.yr
$$;

-- what one customer can order: their reserve + their own sample holds + what's open
create or replace function _orderable(p_customer int)
returns table (strain text, crop_year int, my_left numeric, open_lbs numeric, can_order numeric)
language sql stable security definer set search_path = public as $$
  select m.strain, m.crop_year, x.mine, x.open, x.mine + x.open
    from _menu_numbers() m
    join customers c on c.id = p_customer
    left join reserve_balances b on m.crop_year = crop_year() and b.crop_year = crop_year() and b.customer_id = p_customer and lower(b.strain) = lower(m.strain)
    cross join lateral (select coalesce(sum(h.remaining), 0) as lbs from _sample_holds() h
                         where h.customer_id = p_customer and lower(h.strain) = lower(m.strain) and h.crop_year = m.crop_year and h.state in ('waiting','active')) hold
    cross join lateral (select
      (case when c.reserves_enabled then floor(coalesce(b.remaining, 0) / 10) * 10 else 0 end) + floor(hold.lbs / 10) * 10 as mine,
      case when m.on_menu then greatest(floor(m.free / 10) * 10, 0) else 0 end as open) x
$$;

-- the customer's menu, now with their sample holds (new column my_hold)
drop function if exists open_menu();
create function open_menu()
returns table (strain text, crop_year int, available numeric, my_reserved numeric, my_shipped numeric, my_pending numeric, my_left numeric,
               request_id int, requested_lbs numeric, my_hold numeric, my_hold_until date)
language plpgsql stable security definer set search_path = public as $$
declare me int := my_customer(); cy int := crop_year();
begin
  if me is null and not is_sales() then raise exception 'Not allowed'; end if;
  return query
    select m.strain, m.crop_year, case when m.on_menu then greatest(floor(m.free / 10) * 10, 0) else 0 end,
           b.reserved, b.shipped, b.pending, b.remaining, q.id, q.requested_lbs, h.lbs, h.until
      from _menu_numbers() m
      left join reserve_balances b on m.crop_year = cy and b.crop_year = cy and b.customer_id = me and lower(b.strain) = lower(m.strain)
      left join reserve_requests q on m.crop_year = cy and q.crop_year = cy and q.customer_id = me and lower(q.strain) = lower(m.strain) and q.status = 'pending'
      left join lateral (select sum(x.remaining) as lbs, max(x.until) as until from _sample_holds() x
                          where x.customer_id = me and lower(x.strain) = lower(m.strain) and x.crop_year = m.crop_year and x.state in ('waiting','active')) h on true
     where (m.on_menu and m.free >= 10) or b.id is not null or q.id is not null or coalesce(h.lbs, 0) > 0
     order by m.crop_year desc, m.strain;
end $$;
revoke execute on function open_menu() from public, anon;
grant execute on function open_menu() to authenticated;

-- portal ordering (020) + sample lines: each line can have "sample": true and "hold_lbs" (p_sample = every line is a sample)
drop function if exists place_order(jsonb, text, text, date);
create or replace function place_order(p_lines jsonb, p_note text default null, p_po text default null, p_wanted date default null, p_sample boolean default false)
returns int
language plpgsql security definer set search_path = public as $$
declare me int := my_customer(); l record; s text; ok record; o orders; price numeric; n int := 0;
begin
  perform no_view_as();
  if me is null then raise exception 'Only a customer login can place orders'; end if;
  perform pg_advisory_xact_lock(4242);          -- one order at a time, so two can't take the same lbs
  insert into orders (customer_id, status, order_date, source, notes, po_number, wanted_date, placed_by, created_by, is_sample)
  values (me, 'submitted', current_date, 'portal', nullif(trim(p_note), ''), nullif(trim(p_po), ''), p_wanted, jwt_email(), jwt_email(), false)
  returning * into o;
  for l in
    select x ->> 'strain' as strain, coalesce((x ->> 'crop_year')::int, crop_year()) as yr,
           coalesce(p_sample, false) or coalesce((x ->> 'sample')::boolean, false) as smp,
           sum((x ->> 'lbs')::numeric) as lbs, max(nullif(x ->> 'hold_lbs', '')::numeric) as hold
      from jsonb_array_elements(coalesce(p_lines, '[]')) x group by 1, 2, 3
  loop
    if coalesce(l.lbs, 0) <= 0 then continue; end if;
    if l.lbs % 10 <> 0 then raise exception 'Use multiples of 10 lbs (% lbs of %)', l.lbs, l.strain; end if;
    if l.smp and coalesce(l.hold, 0) % 10 <> 0 then raise exception 'Hold amounts go in multiples of 10 lbs (% lbs of %)', l.hold, l.strain; end if;
    s := canonical_strain(l.strain);
    if s is null then raise exception 'Unknown strain %', l.strain; end if;
    select * into ok from _orderable(me) x where lower(x.strain) = lower(s) and x.crop_year = l.yr;
    if coalesce(ok.can_order, 0) < l.lbs then
      raise exception 'Only % lbs of % (% crop) can be ordered right now', coalesce(ok.can_order, 0), s, l.yr;
    end if;
    if l.smp and coalesce(l.hold, 0) > 0 and coalesce(ok.can_order, 0) < l.lbs + l.hold then
      raise exception 'Only % lbs of % can be held after this sample', greatest(coalesce(ok.can_order, 0) - l.lbs, 0), s;
    end if;
    select t.price_per_lb into price from terms_for(me, l.yr) t;
    insert into order_lines (order_id, strain, lbs, price_per_lb, crop_year, is_sample, hold_lbs)
    values (o.id, s, l.lbs, price, l.yr, l.smp, case when l.smp and coalesce(l.hold, 0) > 0 then l.hold end);
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'Add at least one strain'; end if;
  update orders set is_sample = exists (select 1 from order_lines where order_id = o.id and is_sample) where id = o.id;
  insert into events (user_email, type, note, details)
  values (jwt_email(), 'order_placed', p_note, jsonb_build_object('order_id', o.id, 'customer_id', me,
          'samples', (select count(*) from order_lines where order_id = o.id and is_sample),
          'customer', (select name from customers where id = me), 'lbs', (select sum(lbs) from order_lines where order_id = o.id), 'lines', n));
  return o.id;
end $$;
revoke execute on function place_order(jsonb, text, text, date, boolean) from public, anon;
grant execute on function place_order(jsonb, text, text, date, boolean) to authenticated;

-- Sales: mark lines as samples and set what to hold. p_holds: [{"line_id": 12, "sample": true, "hold_lbs": 200}] or [{"strain": "Hashburger", ...}].
-- "sample" left out = p_sample. p_sample false with no lines = no samples on this order.
create or replace function set_order_sample(p_order int, p_sample boolean, p_holds jsonb default '[]') returns void
language plpgsql security definer set search_path = public as $$
declare o orders; h jsonb;
begin
  perform no_view_as();
  if not can_edit('sales') then raise exception 'Only Sales can change this'; end if;
  select * into o from orders where id = p_order;
  if o.id is null then raise exception 'Order not found'; end if;
  if not coalesce(p_sample, false) and jsonb_array_length(coalesce(p_holds, '[]')) = 0 then
    update order_lines set is_sample = false, hold_lbs = null, hold_until = null where order_id = p_order;
  else
    for h in select * from jsonb_array_elements(coalesce(p_holds, '[]')) loop
      update order_lines set is_sample = coalesce((h ->> 'sample')::boolean, coalesce(p_sample, false)),
             hold_lbs = case when coalesce((h ->> 'sample')::boolean, coalesce(p_sample, false)) then nullif(nullif(h ->> 'hold_lbs', '')::numeric, 0) end
       where order_id = p_order and product = 'fresh_frozen'
         and (id = nullif(h ->> 'line_id', '')::int or (h ->> 'line_id' is null and lower(strain) = lower(coalesce(canonical_strain(h ->> 'strain'), h ->> 'strain'))));
    end loop;
  end if;
  update orders set is_sample = exists (select 1 from order_lines where order_id = p_order and is_sample), updated_at = now() where id = p_order;
  insert into events (user_email, type, note, details)
  values (current_email(), 'sample_set', o.so_number, jsonb_build_object('order_id', p_order, 'sample', exists (select 1 from order_lines where order_id = p_order and is_sample), 'holds', p_holds,
          'customer', (select name from customers where id = o.customer_id)));
end $$;

-- Sales: release a hold now, or set the date it runs until (extend or shorten)
create or replace function set_sample_hold(p_line int, p_release boolean default false, p_until date default null) returns void
language plpgsql security definer set search_path = public as $$
declare l order_lines; o orders;
begin
  perform no_view_as();
  if not can_edit('sales') then raise exception 'Only Sales can change a hold'; end if;
  select * into l from order_lines where id = p_line;
  select * into o from orders where id = l.order_id;
  if l.id is null or not l.is_sample then raise exception 'Sample hold not found'; end if;
  if p_release then
    update order_lines set hold_released_at = now(), hold_released_by = current_email() where id = p_line;
  else
    update order_lines set hold_until = p_until, hold_released_at = null, hold_released_by = null where id = p_line;
  end if;
  insert into events (user_email, type, note, details)
  values (current_email(), 'sample_hold', l.strain, jsonb_build_object('order_id', o.id, 'so', o.so_number, 'line_id', p_line, 'release', p_release,
          'until', p_until, 'customer', (select name from customers where id = o.customer_id)));
end $$;

-- holds to show: Sales sees everyone's (or one customer's), a customer sees their own
create or replace function sample_holds(p_customer int default null, p_all boolean default false)
returns table (line_id int, order_id int, so_number text, customer_id int, customer text, strain text, crop_year int, hold_lbs numeric,
               used_lbs numeric, remaining numeric, placed_on date, shipped_on date, until date, state text)
language sql stable security definer set search_path = public as $$
  select h.line_id, h.order_id, h.so_number, h.customer_id, c.name, h.strain, h.crop_year, h.hold_lbs, h.used_lbs, h.remaining,
         h.placed_on, h.shipped_on, h.until, h.state
    from _sample_holds() h join customers c on c.id = h.customer_id
   where ((is_sales() and (p_customer is null or h.customer_id = p_customer)) or h.customer_id = my_customer())
     and (p_all or h.state in ('waiting','active') or h.until >= current_date - 30)
   order by h.state in ('waiting','active') desc, h.until nulls first, c.name, h.strain
$$;
create or replace function my_sample_hold_days() returns int
language sql stable security definer set search_path = public as $$ select case when my_customer() is not null then sample_hold_days(my_customer()) end $$;

revoke execute on function sample_hold_days(int), set_order_sample(int, boolean, jsonb), set_sample_hold(int, boolean, date),
  sample_holds(int, boolean), my_sample_hold_days() from public, anon;
grant execute on function sample_hold_days(int), set_order_sample(int, boolean, jsonb), set_sample_hold(int, boolean, date),
  sample_holds(int, boolean), my_sample_hold_days() to authenticated;
