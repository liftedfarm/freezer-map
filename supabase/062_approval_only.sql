-- Migration 062 (Aziz 10/24): nothing comes off the open menu until it's approved. Run after 061. Safe to re-run.
--  - Orders: only confirmed orders (status pending) count against the menu and against reserves. A customer's
--    submitted order is a request until Sales confirms it. (Shipped orders are already out of the freezers.)
--  - Confirm checks there's enough first: lbs (plus any sample hold) <= open + that customer's reserve left + their own sample holds.
--    If not, Sales gets "only X lbs of Strain left" and adjusts the line or declines.
--  - A customer's own submitted orders still count against what THEY can order, so one customer can't request the same lbs twice.
--  - Sample holds: start when the order is confirmed (state 'submitted' until then), run until N days after it ships, gone if cancelled.
--  - Reserve requests: no longer held off the menu while they wait. Only approved reserves come off the open menu.

-- reserves: confirmed (pending) and shipped orders use them up; submitted orders show separately
create or replace view reserve_balances with (security_invoker = true) as
  with sold as (
    select o.customer_id, l.strain, l.crop_year,
           sum(l.lbs) filter (where o.status = 'shipped') as shipped,
           sum(l.lbs) filter (where o.status = 'pending') as pending,
           sum(l.lbs) filter (where o.status = 'submitted') as submitted
      from orders o join order_lines l on l.order_id = o.id
     where l.product = 'fresh_frozen'
     group by o.customer_id, l.strain, l.crop_year)
  select r.id, r.customer_id, r.strain, r.lbs as reserved,
         coalesce(s.shipped, 0) as shipped, coalesce(s.pending, 0) as pending,
         greatest(r.lbs - coalesce(s.shipped, 0) - coalesce(s.pending, 0), 0) as remaining,
         r.crop_year, coalesce(s.submitted, 0) as submitted
    from reserves r
    left join sold s on s.customer_id = r.customer_id and lower(s.strain) = lower(r.strain) and s.crop_year = r.crop_year
   where r.product = 'fresh_frozen';

-- sample holds: 'submitted' (not holding yet) until the order is confirmed
create or replace function _sample_holds() returns table (
  line_id int, order_id int, so_number text, customer_id int, strain text, crop_year int, hold_lbs numeric, used_lbs numeric,
  remaining numeric, placed_on date, shipped_on date, until date, state text)
language sql stable security definer set search_path = public as $$
  select l.id, o.id, o.so_number, o.customer_id, l.strain, l.crop_year, l.hold_lbs, u.used,
         greatest(l.hold_lbs - u.used, 0), o.order_date, case when o.status = 'shipped' then coalesce(o.shipped_date, o.order_date) end,
         coalesce(l.hold_until, case when o.status = 'shipped' then coalesce(o.shipped_date, o.order_date) + sample_hold_days(o.customer_id) end),
         case when l.hold_released_at is not null then 'released'
              when o.status in ('cancelled', 'draft') then 'cancelled'
              when o.status = 'submitted' then 'submitted'
              when l.hold_lbs - u.used <= 0 then 'used'
              when l.hold_until is not null and l.hold_until < current_date then 'expired'
              when l.hold_until is null and o.status = 'shipped' and coalesce(o.shipped_date, o.order_date) + sample_hold_days(o.customer_id) < current_date then 'expired'
              when l.hold_until is null and o.status <> 'shipped' then 'waiting'
              else 'active' end
    from orders o
    join order_lines l on l.order_id = o.id
    -- used = confirmed lbs of it ordered after the sample, beyond what their reserve already covers (an order draws on the reserve first)
    cross join lateral (
      select least(coalesce(sum(l2.lbs) filter (where not l2.is_sample and o2.created_at > o.created_at), 0),
                   greatest(coalesce(sum(l2.lbs), 0) - coalesce((select sum(r.lbs) from reserves r where r.customer_id = o.customer_id
                              and lower(r.strain) = lower(l.strain) and r.crop_year = l.crop_year and r.product = 'fresh_frozen'), 0), 0)) as used
        from orders o2 join order_lines l2 on l2.order_id = o2.id
       where o2.customer_id = o.customer_id and o2.status in ('pending','shipped')
         and lower(l2.strain) = lower(l.strain) and l2.crop_year = l.crop_year and l2.product = 'fresh_frozen') u
   where l.is_sample and coalesce(l.hold_lbs, 0) > 0 and l.product = 'fresh_frozen'
$$;
revoke execute on function _sample_holds() from public, anon, authenticated;

-- the menu: on hand - confirmed orders - approved reserves left - sample holds (confirmed orders). Submitted orders and
-- reserve requests don't take anything until they're approved. 'held' = sample holds.
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
     where o.status = 'pending' and l.product = 'fresh_frozen' group by 1, 2),
  res as (select lower(b.strain) as k, sum(b.remaining) as lbs from reserve_balances b where b.crop_year = (select y from cy) group by 1),
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
         coalesce(sp.lbs, 0),
         coalesce(n.lbs, 0) - coalesce(pe.lbs, 0) - coalesce(sp.lbs, 0)
           - case when k.yr = (select y from cy) then coalesce(re.lbs, 0) else 0 end
    from k
    left join names n on lower(n.s) = lower(k.name) and n.yr = k.yr
    left join pend pe on pe.k = lower(k.name) and pe.yr = k.yr
    left join res re on re.k = lower(k.name)
    left join samp sp on sp.k = lower(k.name) and sp.yr = k.yr
$$;

-- what one customer could get of a strain right now (open + their reserve left + their own sample holds),
-- before counting any of their own orders still waiting for approval
create or replace function _available_to(p_customer int, p_strain text, p_year int) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select greatest(m.free, 0) from _menu_numbers() m where lower(m.strain) = lower(p_strain) and m.crop_year = p_year), 0)
       + coalesce((select sum(b.remaining) from reserve_balances b join customers c on c.id = b.customer_id
                    where b.customer_id = p_customer and c.reserves_enabled and lower(b.strain) = lower(p_strain) and b.crop_year = p_year
                      and b.crop_year = crop_year()), 0)
       + coalesce((select sum(h.remaining) from _sample_holds() h where h.customer_id = p_customer and lower(h.strain) = lower(p_strain)
                    and h.crop_year = p_year and h.state in ('waiting','active')), 0)
$$;
revoke execute on function _available_to(int, text, int) from public, anon, authenticated;

-- what one customer can order: reserve + own sample holds + open, minus their own orders still waiting for approval
create or replace function _orderable(p_customer int)
returns table (strain text, crop_year int, my_left numeric, open_lbs numeric, can_order numeric)
language sql stable security definer set search_path = public as $$
  select m.strain, m.crop_year, x.mine, x.open, greatest(x.mine + x.open - x.waiting, 0)
    from _menu_numbers() m
    join customers c on c.id = p_customer
    left join reserve_balances b on m.crop_year = crop_year() and b.crop_year = crop_year() and b.customer_id = p_customer and lower(b.strain) = lower(m.strain)
    cross join lateral (select coalesce(sum(h.remaining), 0) as lbs from _sample_holds() h
                         where h.customer_id = p_customer and lower(h.strain) = lower(m.strain) and h.crop_year = m.crop_year and h.state in ('waiting','active')) hold
    cross join lateral (select coalesce(sum(l.lbs + case when l.is_sample then coalesce(l.hold_lbs, 0) else 0 end), 0) as lbs
                          from orders o join order_lines l on l.order_id = o.id
                         where o.customer_id = p_customer and o.status = 'submitted' and l.product = 'fresh_frozen'
                           and lower(l.strain) = lower(m.strain) and l.crop_year = m.crop_year) sub
    cross join lateral (select
      (case when c.reserves_enabled then floor(coalesce(b.remaining, 0) / 10) * 10 else 0 end) + floor(hold.lbs / 10) * 10 as mine,
      case when m.on_menu then greatest(floor(m.free / 10) * 10, 0) else 0 end as open,
      sub.lbs as waiting) x
$$;

-- the stock check Confirm runs: every fresh frozen strain on the order (lbs + sample holds) has to fit
create or replace function order_stock_check(p_order int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o orders; r record; short jsonb := '[]';
begin
  if not (is_sales() or exists (select 1 from orders where id = p_order and customer_id = my_customer())) then raise exception 'Not allowed'; end if;
  select * into o from orders where id = p_order;
  if o.id is null then raise exception 'Order not found'; end if;
  for r in
    select l.strain, l.crop_year, sum(l.lbs) as lbs, sum(case when l.is_sample then coalesce(l.hold_lbs, 0) else 0 end) as hold
      from order_lines l where l.order_id = p_order and l.product = 'fresh_frozen' group by 1, 2
  loop
    declare avail numeric := _available_to(o.customer_id, r.strain, r.crop_year)
                            - case when o.status = 'submitted' then 0 else r.lbs end;   -- a confirmed order is already counted
    begin
      if r.lbs + r.hold > avail then
        short := short || jsonb_build_object('strain', r.strain, 'crop_year', r.crop_year, 'lbs', r.lbs, 'hold', r.hold, 'available', greatest(avail, 0));
      end if;
    end;
  end loop;
  return jsonb_build_object('ok', jsonb_array_length(short) = 0, 'short', short);
end $$;

-- Confirm (submitted -> pending, or straight to shipped) checks stock first
create or replace function set_order_status(p_id int, p_status text, p_so text default null, p_note text default null, p_date date default null)
returns void
language plpgsql security definer set search_path = public as $$
declare o orders; chk jsonb; msg text;
begin
  if not is_sales() then raise exception 'Only Sales or an Admin can change orders'; end if;
  if p_status not in ('pending','shipped','cancelled','submitted') then raise exception 'Unknown status %', p_status; end if;
  select * into o from orders where id = p_id for update;
  if o.id is null then raise exception 'Order not found'; end if;
  if nullif(trim(p_so), '') is not null and exists (select 1 from orders where so_number = trim(p_so) and id <> p_id) then
    raise exception 'SO % is already on another order', trim(p_so);
  end if;
  if o.status = 'submitted' and p_status in ('pending', 'shipped') then
    perform pg_advisory_xact_lock(4242);       -- same lock as ordering: two confirms can't take the same lbs
    chk := order_stock_check(p_id);
    if not (chk ->> 'ok')::boolean then
      select string_agg(format('%s: %s lbs%s ordered, only %s available', x ->> 'strain', round((x ->> 'lbs')::numeric),
                               case when (x ->> 'hold')::numeric > 0 then ' + ' || round((x ->> 'hold')::numeric) || ' held' else '' end, round((x ->> 'available')::numeric)), '; ')
        into msg from jsonb_array_elements(chk -> 'short') x;
      raise exception 'Not enough to confirm. %. Change the lines or decline the order.', msg;
    end if;
  end if;
  update orders set status = p_status, so_number = coalesce(nullif(trim(p_so), ''), so_number),
         confirmed_by = case when o.status = 'submitted' and p_status = 'pending' then current_email() else confirmed_by end,
         confirmed_at = case when o.status = 'submitted' and p_status = 'pending' then now() else confirmed_at end,
         shipped_date = case when p_status = 'shipped' then coalesce(p_date, shipped_date, current_date) else shipped_date end,
         updated_at = now()
   where id = p_id;
  insert into events (user_email, type, note, details)
  values (current_email(), 'order_status', p_note, jsonb_build_object('order_id', p_id, 'from', o.status, 'to', p_status, 'date', p_date,
          'so', coalesce(nullif(trim(p_so), ''), o.so_number), 'customer', (select name from customers where id = o.customer_id)));
end $$;

revoke execute on function order_stock_check(int) from public, anon;
grant execute on function order_stock_check(int) to authenticated;

-- holds to show (061) now include ones waiting for the order to be confirmed
create or replace function sample_holds(p_customer int default null, p_all boolean default false)
returns table (line_id int, order_id int, so_number text, customer_id int, customer text, strain text, crop_year int, hold_lbs numeric,
               used_lbs numeric, remaining numeric, placed_on date, shipped_on date, until date, state text)
language sql stable security definer set search_path = public as $$
  select h.line_id, h.order_id, h.so_number, h.customer_id, c.name, h.strain, h.crop_year, h.hold_lbs, h.used_lbs, h.remaining,
         h.placed_on, h.shipped_on, h.until, h.state
    from _sample_holds() h join customers c on c.id = h.customer_id
   where ((is_sales() and (p_customer is null or h.customer_id = p_customer)) or h.customer_id = my_customer())
     and (p_all or h.state in ('submitted','waiting','active') or h.until >= current_date - 30)
   order by h.state in ('waiting','active') desc, h.state = 'submitted' desc, h.until nulls first, c.name, h.strain
$$;
