-- Migration 020: reserves by crop year, customer requests for next year's crop, contract terms by year.
-- Run once in Supabase after 019_cultivation.sql: SQL Editor > New query > paste > Run. Safe to re-run.
--
--  * Every reserve and reserve request has a crop year. Everything that exists today becomes 2026 (the current crop).
--    The open menu, balances and ordering work exactly as before, on the current crop only.
--  * Customers can ask for reserves on a future crop (any active strain on the list) until that year's deadline
--    (app_settings "reserves.deadline.2027" = 2027-02-01). Same Admin approval as today. No availability check:
--    nothing is in the freezers yet.
--  * Contract terms by year: the customer's terms (price/lb, contract lbs, ...) carry over to later years until
--    someone sets different terms for a year (customer_terms). terms_for(customer, year) gives the terms in force.
--    Portal orders price each line from its crop year's terms.
set client_min_messages = warning;

-- ---------- columns ----------
alter table reserves add column if not exists crop_year int;
update reserves set crop_year = crop_year() where crop_year is null;
alter table reserves alter column crop_year set default crop_year();
alter table reserves alter column crop_year set not null;
drop index if exists reserves_uq;
create unique index reserves_uq on reserves (customer_id, lower(strain), product, crop_year);

alter table reserve_requests add column if not exists crop_year int;
update reserve_requests set crop_year = crop_year() where crop_year is null;
alter table reserve_requests alter column crop_year set default crop_year();
alter table reserve_requests alter column crop_year set not null;
drop index if exists reserve_requests_one_open;
create unique index reserve_requests_one_open on reserve_requests (customer_id, lower(strain), crop_year) where status = 'pending';

insert into app_settings values ('reserves.deadline.2027', '2027-02-01'), ('cult.buffer_pct', '0') on conflict do nothing;

-- ---------- balances: per crop year ----------
create or replace view reserve_balances with (security_invoker = true) as
  with sold as (
    select o.customer_id, l.strain, l.crop_year,
           sum(l.lbs) filter (where o.status = 'shipped') as shipped,
           sum(l.lbs) filter (where o.status in ('pending','submitted')) as pending
      from orders o join order_lines l on l.order_id = o.id
     where l.product = 'fresh_frozen' group by 1, 2, 3)
  select r.id, r.customer_id, r.strain, r.lbs as reserved,
         coalesce(s.shipped, 0) as shipped, coalesce(s.pending, 0) as pending,
         greatest(r.lbs - coalesce(s.shipped, 0) - coalesce(s.pending, 0), 0) as remaining,
         r.crop_year
    from reserves r left join sold s on s.customer_id = r.customer_id and lower(s.strain) = lower(r.strain) and s.crop_year = r.crop_year
   where r.product = 'fresh_frozen';

-- ---------- deadlines and which years are open ----------
create or replace function reserve_deadline(p_year int) returns date
language sql stable security definer set search_path = public as $$
  select nullif(value, '')::date from app_settings where key = 'reserves.deadline.' || p_year
$$;

-- the current crop plus every later crop that has a deadline: {current, years: [{year, deadline, open}]}
create or replace function reserve_years() returns jsonb
language sql stable security definer set search_path = public as $$
  with y as (
    select crop_year() as year
    union select substring(key from 'reserves\.deadline\.(\d{4})')::int from app_settings
     where key ~ '^reserves\.deadline\.\d{4}$' and substring(key from '(\d{4})$')::int > crop_year())
  select jsonb_build_object('current', crop_year(), 'years', coalesce(jsonb_agg(jsonb_build_object(
           'year', y.year, 'deadline', reserve_deadline(y.year),
           'open', y.year = crop_year() or coalesce(current_date <= reserve_deadline(y.year), false)) order by y.year), '[]'))
    from y
$$;

create or replace function set_reserve_deadline(p_year int, p_date date) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform no_view_as();
  if not is_admin() then raise exception 'Only an Admin can change reserve deadlines'; end if;
  if p_year <= crop_year() then raise exception 'Deadlines are for future crops'; end if;
  if p_date is null then delete from app_settings where key = 'reserves.deadline.' || p_year;
  else insert into app_settings values ('reserves.deadline.' || p_year, p_date::text) on conflict (key) do update set value = excluded.value;
  end if;
  insert into events (user_email, type, note, details)
  values (current_email(), 'settings', 'updated', jsonb_build_object('list', 'reserve deadlines', 'name', p_year::text, 'deadline', p_date));
end $$;

-- strain names a customer can ask for
create or replace function reserve_strains() returns setof text
language sql stable security definer set search_path = public as $$
  select name from strains where active and (is_staff() or my_customer() is not null) order by name
$$;

-- ---------- contract terms by crop year ----------
create table if not exists customer_terms (
  customer_id     int not null references customers(id) on delete cascade,
  crop_year       int not null,
  price_per_lb    numeric,
  contract_lbs    numeric,
  monthly_min_lbs numeric,
  deposit_usd     numeric,
  storage_fee     numeric,
  notes           text,
  updated_by      text,
  updated_at      timestamptz not null default now(),
  primary key (customer_id, crop_year)
);
alter table customer_terms enable row level security;
drop policy if exists read_terms on customer_terms;
create policy read_terms on customer_terms for select to authenticated using (is_sales() or customer_id = my_customer());
grant select on customer_terms to authenticated;

-- terms in force for a crop year: the latest year set on or before it, else the customer's own terms
create or replace function terms_for(p_customer int, p_year int)
returns table (price_per_lb numeric, contract_lbs numeric, monthly_min_lbs numeric, deposit_usd numeric, storage_fee numeric, from_year int)
language sql stable security definer set search_path = public as $$
  select * from (
    select t.price_per_lb, t.contract_lbs, t.monthly_min_lbs, t.deposit_usd, t.storage_fee, t.crop_year
      from customer_terms t where t.customer_id = p_customer and t.crop_year <= p_year
     order by t.crop_year desc limit 1) x
  union all
  select c.price_per_lb, c.contract_lbs, c.monthly_min_lbs, c.deposit_usd, c.storage_fee, null::int
    from customers c where c.id = p_customer
     and not exists (select 1 from customer_terms t where t.customer_id = p_customer and t.crop_year <= p_year)
$$;

create or replace function set_customer_terms(p_customer int, p_year int, p_price numeric, p_contract numeric, p_min numeric,
  p_deposit numeric, p_storage numeric, p_clear boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare c customers;
begin
  perform no_view_as();
  if not is_sales() then raise exception 'Only Sales or an Admin can change contract terms'; end if;
  select * into c from customers where id = p_customer;
  if c.id is null then raise exception 'Customer not found'; end if;
  if p_clear then
    delete from customer_terms where customer_id = p_customer and crop_year = p_year;
  else
    insert into customer_terms (customer_id, crop_year, price_per_lb, contract_lbs, monthly_min_lbs, deposit_usd, storage_fee, updated_by)
    values (p_customer, p_year, p_price, p_contract, p_min, p_deposit, p_storage, current_email())
    on conflict (customer_id, crop_year) do update set price_per_lb = excluded.price_per_lb, contract_lbs = excluded.contract_lbs,
      monthly_min_lbs = excluded.monthly_min_lbs, deposit_usd = excluded.deposit_usd, storage_fee = excluded.storage_fee,
      updated_by = excluded.updated_by, updated_at = now();
  end if;
  insert into events (user_email, type, note, details)
  values (current_email(), 'settings', 'updated', jsonb_build_object('list', 'customer terms', 'name', c.name || ' ' || p_year,
          'customer_id', c.id, 'crop_year', p_year, 'price_per_lb', p_price, 'cleared', p_clear));
end $$;

create or replace function my_terms_for(p_year int) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('crop_year', p_year, 'price_per_lb', t.price_per_lb, 'contract_lbs', t.contract_lbs)
    from terms_for(my_customer(), p_year) t where my_customer() is not null
$$;

-- ---------- reserve changes, now with a year ----------
drop function if exists _apply_reserve(int, text, numeric, text, text, text);
create or replace function _apply_reserve(p_customer int, p_strain text, p_lbs numeric, p_note text, p_user text, p_kind text, p_year int)
returns void
language plpgsql security definer set search_path = public as $$
declare s text := canonical_strain(p_strain); was reserves; c customers; yr int := coalesce(p_year, crop_year());
begin
  select * into c from customers where id = p_customer;
  if c.id is null then raise exception 'Customer not found'; end if;
  if s is null then raise exception '"%" isn''t in the Strains list. Add it in Settings > Strains first.', p_strain; end if;
  if p_lbs is null or p_lbs < 0 then raise exception 'Reserve must be 0 or more lbs'; end if;
  select * into was from reserves where customer_id = p_customer and lower(strain) = lower(s) and product = 'fresh_frozen' and crop_year = yr;
  if p_lbs = 0 then
    delete from reserves where id = was.id;
  elsif was.id is null then
    insert into reserves (customer_id, strain, lbs, notes, created_by, updated_by, crop_year)
    values (p_customer, s, p_lbs, nullif(trim(p_note), ''), p_user, p_user, yr);
  else
    update reserves set lbs = p_lbs, updated_by = p_user, updated_at = now() where id = was.id;
  end if;
  insert into events (user_email, type, note, details)
  values (p_user, 'reserve_set', p_note,
          jsonb_build_object('customer', c.name, 'customer_id', c.id, 'strain', s, 'lbs', p_lbs, 'was', was.lbs, 'via', p_kind, 'crop_year', yr));
end $$;
revoke execute on function _apply_reserve(int,text,numeric,text,text,text,int) from public, anon, authenticated;

drop function if exists set_reserve(int, text, numeric, text);
create or replace function set_reserve(p_customer int, p_strain text, p_lbs numeric, p_note text default null, p_year int default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform no_view_as();
  if not is_admin() then raise exception 'Only an Admin can change reserves'; end if;
  perform _apply_reserve(p_customer, p_strain, p_lbs, p_note, current_email(), 'edit', p_year);
end $$;
revoke execute on function set_reserve(int,text,numeric,text,int) from public, anon;
grant execute on function set_reserve(int,text,numeric,text,int) to authenticated;

-- ---------- the open menu: current crop reserves only ----------
create or replace function _menu_numbers()
returns table (strain text, crop_year int, on_menu boolean, on_hand numeric, pending numeric, reserved_left numeric, held numeric, free numeric)
language sql stable security definer set search_path = public as $$
  with cy as (select crop_year() as y),
  names as (
    select canonical_strain(p.strain) as s, coalesce(extract(year from p.harvest_date)::int, (select y from cy)) as yr,
           sum(coalesce(p.current_weight, 0)) as lbs
      from pallets p
     where p.kind = 'package' and p.status in ('in_freezer','unslotted') and p.strain is not null
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
  allk as (
    select s as name, yr from names where s is not null
    union select r.strain, r.crop_year from reserves r where r.crop_year = (select y from cy)
    union select l.strain, l.crop_year from orders o join order_lines l on l.order_id = o.id where o.status in ('pending','submitted')),
  k as (select distinct on (lower(name), yr) name, yr from allk order by lower(name), yr, name)
  select k.name, k.yr,
         coalesce((select st.show_on_menu from strains st where lower(st.name) = lower(k.name) limit 1), true),
         coalesce(n.lbs, 0), coalesce(pe.lbs, 0),
         case when k.yr = (select y from cy) then coalesce(re.lbs, 0) else 0 end,
         case when k.yr = (select y from cy) then coalesce(h.lbs, 0) else 0 end,
         coalesce(n.lbs, 0) - coalesce(pe.lbs, 0)
           - case when k.yr = (select y from cy) then coalesce(re.lbs, 0) + coalesce(h.lbs, 0) else 0 end
    from k
    left join names n on lower(n.s) = lower(k.name) and n.yr = k.yr
    left join pend pe on pe.k = lower(k.name) and pe.yr = k.yr
    left join res re on re.k = lower(k.name)
    left join held h on h.k = lower(k.name)
$$;
revoke execute on function _menu_numbers() from public, anon, authenticated;

create or replace function open_menu()
returns table (strain text, crop_year int, available numeric, my_reserved numeric, my_shipped numeric, my_pending numeric, my_left numeric,
               request_id int, requested_lbs numeric)
language plpgsql stable security definer set search_path = public as $$
declare me int := my_customer(); cy int := crop_year();
begin
  if me is null and not is_sales() then raise exception 'Not allowed'; end if;
  return query
    select m.strain, m.crop_year, case when m.on_menu then greatest(floor(m.free / 10) * 10, 0) else 0 end,
           b.reserved, b.shipped, b.pending, b.remaining, q.id, q.requested_lbs
      from _menu_numbers() m
      left join reserve_balances b on m.crop_year = cy and b.crop_year = cy and b.customer_id = me and lower(b.strain) = lower(m.strain)
      left join reserve_requests q on m.crop_year = cy and q.crop_year = cy and q.customer_id = me and lower(q.strain) = lower(m.strain) and q.status = 'pending'
     where (m.on_menu and m.free >= 10) or b.id is not null or q.id is not null
     order by m.crop_year desc, m.strain;
end $$;

create or replace function _orderable(p_customer int)
returns table (strain text, crop_year int, my_left numeric, open_lbs numeric, can_order numeric)
language sql stable security definer set search_path = public as $$
  select m.strain, m.crop_year, x.mine, x.open, x.mine + x.open
    from _menu_numbers() m
    join customers c on c.id = p_customer
    left join reserve_balances b on m.crop_year = crop_year() and b.crop_year = crop_year() and b.customer_id = p_customer and lower(b.strain) = lower(m.strain)
    cross join lateral (select
      case when c.reserves_enabled then floor(coalesce(b.remaining, 0) / 10) * 10 else 0 end as mine,
      case when m.on_menu then greatest(floor(m.free / 10) * 10, 0) else 0 end as open) x
$$;
revoke execute on function _orderable(int) from public, anon, authenticated;

-- orders: each line priced from its crop year's terms
create or replace function place_order(p_lines jsonb, p_note text default null, p_po text default null, p_wanted date default null)
returns int
language plpgsql security definer set search_path = public as $$
declare me int := my_customer(); l record; s text; ok record; o orders; price numeric; n int := 0;
begin
  perform no_view_as();
  if me is null then raise exception 'Only a customer login can place orders'; end if;
  perform pg_advisory_xact_lock(4242);          -- one order at a time, so two can't take the same lbs
  insert into orders (customer_id, status, order_date, source, notes, po_number, wanted_date, placed_by, created_by)
  values (me, 'submitted', current_date, 'portal', nullif(trim(p_note), ''), nullif(trim(p_po), ''), p_wanted, jwt_email(), jwt_email())
  returning * into o;
  for l in
    select x ->> 'strain' as strain, coalesce((x ->> 'crop_year')::int, crop_year()) as yr, sum((x ->> 'lbs')::numeric) as lbs
      from jsonb_array_elements(coalesce(p_lines, '[]')) x group by 1, 2
  loop
    if coalesce(l.lbs, 0) <= 0 then continue; end if;
    if l.lbs % 10 <> 0 then raise exception 'Use multiples of 10 lbs (% lbs of %)', l.lbs, l.strain; end if;
    s := canonical_strain(l.strain);
    if s is null then raise exception 'Unknown strain %', l.strain; end if;
    select * into ok from _orderable(me) x where lower(x.strain) = lower(s) and x.crop_year = l.yr;
    if coalesce(ok.can_order, 0) < l.lbs then
      raise exception 'Only % lbs of % (% crop) can be ordered right now', coalesce(ok.can_order, 0), s, l.yr;
    end if;
    select t.price_per_lb into price from terms_for(me, l.yr) t;
    insert into order_lines (order_id, strain, lbs, price_per_lb, crop_year) values (o.id, s, l.lbs, price, l.yr);
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'Add at least one strain'; end if;
  insert into events (user_email, type, note, details)
  values (jwt_email(), 'order_placed', p_note, jsonb_build_object('order_id', o.id, 'customer_id', me,
          'customer', (select name from customers where id = me), 'lbs', (select sum(lbs) from order_lines where order_id = o.id), 'lines', n));
  return o.id;
end $$;

-- ---------- requests, with a year ----------
drop function if exists request_reserve_change(text, numeric, text);
create or replace function request_reserve_change(p_strain text, p_lbs numeric, p_note text default null, p_year int default null) returns int
language plpgsql security definer set search_path = public as $$
declare me int := my_customer(); cy int := crop_year(); yr int := coalesce(p_year, crop_year()); s text := canonical_strain(p_strain);
        cur reserves; b reserve_balances; m record; q reserve_requests; avail numeric; dl date;
begin
  perform no_view_as();
  if me is null then raise exception 'Only a customer login can request reserve changes'; end if;
  if not coalesce((select reserves_enabled from customers where id = me), false) then
    raise exception 'Reserves aren''t set up for your account. Contact Lifted.';
  end if;
  if yr < cy then raise exception 'The % crop is closed for reserve changes', yr; end if;
  if yr > cy then
    dl := reserve_deadline(yr);
    if dl is null then raise exception 'Reserves for the % crop aren''t open yet', yr; end if;
    if current_date > dl then raise exception 'Reserve requests for the % crop closed on %', yr, to_char(dl, 'Mon FMDD, YYYY'); end if;
  end if;
  if s is null then raise exception 'Unknown strain %', p_strain; end if;
  if p_lbs is null or p_lbs < 0 then raise exception 'Enter 0 or more lbs'; end if;
  if p_lbs % 10 <> 0 then raise exception 'Use multiples of 10 lbs'; end if;
  select * into cur from reserves where customer_id = me and lower(strain) = lower(s) and product = 'fresh_frozen' and crop_year = yr;
  select * into b from reserve_balances where customer_id = me and lower(strain) = lower(s) and crop_year = yr;
  if p_lbs = coalesce(cur.lbs, 0) then raise exception 'That''s already your reserve'; end if;
  select * into q from reserve_requests where customer_id = me and lower(strain) = lower(s) and status = 'pending' and crop_year = yr;
  if yr = cy then
    if p_lbs < coalesce(b.shipped, 0) + coalesce(b.pending, 0) then
      raise exception 'You''ve already shipped or ordered % lbs of %, so the reserve can''t go below that', coalesce(b.shipped, 0) + coalesce(b.pending, 0), s;
    end if;
    select * into m from _menu_numbers() x where lower(x.strain) = lower(s) and x.crop_year = cy;
    -- room on the menu, not counting this customer's own open request on the strain
    avail := floor((case when coalesce(m.on_menu, true) then coalesce(m.free, 0) else 0 end
                    + greatest(coalesce(q.requested_lbs, 0) - coalesce(cur.lbs, 0), 0)) / 10) * 10;
    if p_lbs - coalesce(cur.lbs, 0) > avail then
      raise exception 'Only % lbs more of % is available right now', greatest(avail, 0), s;
    end if;
  end if;
  if q.id is not null then
    update reserve_requests set requested_lbs = p_lbs, current_lbs = coalesce(cur.lbs, 0), note = nullif(trim(p_note), ''),
           requested_by = jwt_email(), requested_at = now(), notified_at = null
     where id = q.id returning * into q;
  else
    insert into reserve_requests (customer_id, strain, current_lbs, requested_lbs, note, requested_by, crop_year)
    values (me, s, coalesce(cur.lbs, 0), p_lbs, nullif(trim(p_note), ''), jwt_email(), yr) returning * into q;
  end if;
  insert into events (user_email, type, note, details)
  values (jwt_email(), 'reserve_request', p_note, jsonb_build_object('customer_id', me, 'customer', (select name from customers where id = me),
          'strain', s, 'from', coalesce(cur.lbs, 0), 'to', p_lbs, 'request_id', q.id, 'crop_year', yr));
  return q.id;
end $$;
revoke execute on function request_reserve_change(text,numeric,text,int) from public, anon;
grant execute on function request_reserve_change(text,numeric,text,int) to authenticated;

create or replace function decide_reserve_request(p_id int, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare q reserve_requests; b reserve_balances;
begin
  perform no_view_as();
  if not is_admin() then raise exception 'Only an Admin can approve reserve changes'; end if;
  select * into q from reserve_requests where id = p_id for update;
  if q.id is null or q.status <> 'pending' then raise exception 'This request was already handled'; end if;
  if p_approve then
    select * into b from reserve_balances where customer_id = q.customer_id and lower(strain) = lower(q.strain) and crop_year = q.crop_year;
    if q.requested_lbs < coalesce(b.shipped, 0) + coalesce(b.pending, 0) then
      raise exception 'They''ve shipped or ordered % lbs since asking, more than the requested reserve', coalesce(b.shipped, 0) + coalesce(b.pending, 0);
    end if;
    perform _apply_reserve(q.customer_id, q.strain, q.requested_lbs, coalesce(p_note, q.note), current_email(), 'request', q.crop_year);
  end if;
  update reserve_requests set status = case when p_approve then 'approved' else 'declined' end,
         decided_by = current_email(), decided_at = now(), decision_note = nullif(trim(p_note), '')
   where id = q.id;
  insert into events (user_email, type, note, details)
  values (current_email(), case when p_approve then 'reserve_approved' else 'reserve_declined' end, p_note,
          jsonb_build_object('customer_id', q.customer_id, 'customer', (select name from customers where id = q.customer_id),
                             'strain', q.strain, 'from', q.current_lbs, 'to', q.requested_lbs, 'request_id', q.id, 'crop_year', q.crop_year));
end $$;

create or replace function request_notification(p_id int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare q reserve_requests;
begin
  update reserve_requests set notified_at = now()
   where id = p_id and notified_at is null and requested_by = jwt_email() and customer_id = my_customer()
  returning * into q;
  if q.id is null then return null; end if;
  return jsonb_build_object('customer', (select name from customers where id = q.customer_id), 'strain', q.strain,
    'from', q.current_lbs, 'to', q.requested_lbs, 'note', q.note, 'by', q.requested_by, 'crop_year', q.crop_year,
    'by_name', (select display_name from app_users where email = q.requested_by),
    'admins', (select jsonb_agg(email) from app_users where role = 'admin'));
end $$;

revoke execute on function reserve_deadline(int), reserve_years(), set_reserve_deadline(int,date), reserve_strains(), terms_for(int,int),
  set_customer_terms(int,int,numeric,numeric,numeric,numeric,numeric,boolean), my_terms_for(int) from public, anon;
grant execute on function reserve_deadline(int), reserve_years(), set_reserve_deadline(int,date), reserve_strains(),
  set_customer_terms(int,int,numeric,numeric,numeric,numeric,numeric,boolean), my_terms_for(int) to authenticated;

-- check: reserves by year
select crop_year, count(*) as reserves, sum(lbs) as lbs from reserves group by 1 order by 1;
