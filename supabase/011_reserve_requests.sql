-- Migration 011: open menu + customer reserve change requests (approved by an Admin).
-- Run once in Supabase after 010_orders.sql: SQL Editor > New query > paste > Run. Safe to re-run.
--
--  * open_menu(): what's available per strain = on hand in the freezers - pending orders - reserves not yet
--    shipped - requested increases waiting for approval. Rounded down to 10 lbs.
--  * Customers ask for a new reserve amount on a strain (up, down, or a new strain). Increases are held
--    off the menu while they wait. Only an Admin approves or declines. Sales can see requests.
--  * Changing reserves directly is now Admin only.
set client_min_messages = warning;
drop function if exists menu_numbers();

create table if not exists reserve_requests (
  id             serial primary key,
  customer_id    int not null references customers(id),
  strain         text not null,
  current_lbs    numeric not null default 0,      -- reserve when asked
  requested_lbs  numeric not null check (requested_lbs >= 0),
  note           text,
  status         text not null default 'pending' check (status in ('pending','approved','declined','cancelled')),
  requested_by   text not null,
  requested_at   timestamptz not null default now(),
  decided_by     text,
  decided_at     timestamptz,
  decision_note  text,
  notified_at    timestamptz
);
create unique index if not exists reserve_requests_one_open on reserve_requests (customer_id, lower(strain)) where status = 'pending';
alter table reserve_requests enable row level security;
drop policy if exists read_requests on reserve_requests;
create policy read_requests on reserve_requests for select to authenticated using (is_sales() or customer_id = my_customer());
grant select on reserve_requests to authenticated;

-- ---------- reserve changes: one place that applies them ----------
create or replace function _apply_reserve(p_customer int, p_strain text, p_lbs numeric, p_note text, p_user text, p_kind text)
returns void
language plpgsql security definer set search_path = public as $$
declare s text := canonical_strain(p_strain); was reserves; c customers;
begin
  select * into c from customers where id = p_customer;
  if c.id is null then raise exception 'Customer not found'; end if;
  if s is null then raise exception '"%" isn''t in the Strains list. Add it in Settings > Strains first.', p_strain; end if;
  if p_lbs is null or p_lbs < 0 then raise exception 'Reserve must be 0 or more lbs'; end if;
  select * into was from reserves where customer_id = p_customer and lower(strain) = lower(s) and product = 'fresh_frozen';
  if p_lbs = 0 then
    delete from reserves where id = was.id;
  elsif was.id is null then
    insert into reserves (customer_id, strain, lbs, notes, created_by, updated_by) values (p_customer, s, p_lbs, nullif(trim(p_note), ''), p_user, p_user);
  else
    update reserves set lbs = p_lbs, updated_by = p_user, updated_at = now() where id = was.id;
  end if;
  insert into events (user_email, type, note, details)
  values (p_user, 'reserve_set', p_note,
          jsonb_build_object('customer', c.name, 'customer_id', c.id, 'strain', s, 'lbs', p_lbs, 'was', was.lbs, 'via', p_kind));
end $$;
revoke execute on function _apply_reserve(int,text,numeric,text,text,text) from public, anon, authenticated;

create or replace function set_reserve(p_customer int, p_strain text, p_lbs numeric, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Only an Admin can change reserves'; end if;
  perform _apply_reserve(p_customer, p_strain, p_lbs, p_note, current_email(), 'edit');
end $$;

-- ---------- the open menu ----------
create or replace function _menu_numbers()
returns table (strain text, on_hand numeric, pending numeric, reserved_left numeric, held numeric, free numeric)
language sql stable security definer set search_path = public as $$
  with names as (
    select canonical_strain(p.strain) as s, sum(coalesce(p.current_weight, 0)) as lbs
      from pallets p
     where p.kind = 'package' and p.status in ('in_freezer','unslotted') and p.strain is not null
     group by 1),
  pend as (
    select lower(l.strain) as k, sum(l.lbs) as lbs from orders o join order_lines l on l.order_id = o.id
     where o.status = 'pending' and l.product = 'fresh_frozen' group by 1),
  res as (select lower(strain) as k, sum(remaining) as lbs from reserve_balances group by 1),
  held as (
    select lower(q.strain) as k, sum(greatest(q.requested_lbs - coalesce(r.lbs, 0), 0)) as lbs
      from reserve_requests q
      left join reserves r on r.customer_id = q.customer_id and lower(r.strain) = lower(q.strain) and r.product = 'fresh_frozen'
     where q.status = 'pending' group by 1),
  allk as (
    select s as name from names where s is not null
    union select strain from reserves
    union select l.strain from orders o join order_lines l on l.order_id = o.id where o.status = 'pending')
  select a.name, coalesce(n.lbs, 0), coalesce(pe.lbs, 0), coalesce(re.lbs, 0), coalesce(h.lbs, 0),
         coalesce(n.lbs, 0) - coalesce(pe.lbs, 0) - coalesce(re.lbs, 0) - coalesce(h.lbs, 0)
    from allk a
    left join names n on lower(n.s) = lower(a.name)
    left join pend pe on pe.k = lower(a.name)
    left join res re on re.k = lower(a.name)
    left join held h on h.k = lower(a.name)
$$;
revoke execute on function _menu_numbers() from public, anon, authenticated;

-- staff view of the same numbers (Admin and Sales)
create or replace function menu_numbers()
returns table (strain text, on_hand numeric, pending numeric, reserved_left numeric, held numeric, free numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_sales() then raise exception 'Not allowed'; end if;
  return query select * from _menu_numbers();
end $$;
revoke execute on function menu_numbers() from public, anon;
grant execute on function menu_numbers() to authenticated;

-- what a customer sees: available (rounded down to 10), plus their own reserve and any open request
create or replace function open_menu()
returns table (strain text, available numeric, my_reserved numeric, my_shipped numeric, my_pending numeric, my_left numeric,
               request_id int, requested_lbs numeric)
language plpgsql stable security definer set search_path = public as $$
declare me int := my_customer();
begin
  if me is null and not is_sales() then raise exception 'Not allowed'; end if;
  return query
    select m.strain, greatest(floor(m.free / 10) * 10, 0),
           b.reserved, b.shipped, b.pending, b.remaining, q.id, q.requested_lbs
      from _menu_numbers() m
      left join reserve_balances b on b.customer_id = me and lower(b.strain) = lower(m.strain)
      left join reserve_requests q on q.customer_id = me and lower(q.strain) = lower(m.strain) and q.status = 'pending'
     where m.free >= 10 or b.id is not null or q.id is not null
     order by m.strain;
end $$;
revoke execute on function open_menu() from public, anon;
grant execute on function open_menu() to authenticated;

-- ---------- requests ----------
create or replace function request_reserve_change(p_strain text, p_lbs numeric, p_note text default null) returns int
language plpgsql security definer set search_path = public as $$
declare me int := my_customer(); s text := canonical_strain(p_strain); cur reserves; b reserve_balances; m record; q reserve_requests; avail numeric;
begin
  if me is null then raise exception 'Only a customer login can request reserve changes'; end if;
  if s is null then raise exception 'Unknown strain %', p_strain; end if;
  if p_lbs is null or p_lbs < 0 then raise exception 'Enter 0 or more lbs'; end if;
  if p_lbs % 10 <> 0 then raise exception 'Use multiples of 10 lbs'; end if;
  select * into cur from reserves where customer_id = me and lower(strain) = lower(s) and product = 'fresh_frozen';
  select * into b from reserve_balances where customer_id = me and lower(strain) = lower(s);
  if p_lbs = coalesce(cur.lbs, 0) then raise exception 'That''s already your reserve'; end if;
  if p_lbs < coalesce(b.shipped, 0) + coalesce(b.pending, 0) then
    raise exception 'You''ve already shipped or ordered % lbs of %, so the reserve can''t go below that', coalesce(b.shipped, 0) + coalesce(b.pending, 0), s;
  end if;
  select * into q from reserve_requests where customer_id = me and lower(strain) = lower(s) and status = 'pending';
  select * into m from _menu_numbers() x where lower(x.strain) = lower(s);
  -- room on the menu, not counting this customer's own open request on the strain
  avail := floor((coalesce(m.free, 0) + greatest(coalesce(q.requested_lbs, 0) - coalesce(cur.lbs, 0), 0)) / 10) * 10;
  if p_lbs - coalesce(cur.lbs, 0) > avail then
    raise exception 'Only % lbs more of % is available right now', greatest(avail, 0), s;
  end if;
  if q.id is not null then
    update reserve_requests set requested_lbs = p_lbs, current_lbs = coalesce(cur.lbs, 0), note = nullif(trim(p_note), ''),
           requested_by = jwt_email(), requested_at = now(), notified_at = null
     where id = q.id returning * into q;
  else
    insert into reserve_requests (customer_id, strain, current_lbs, requested_lbs, note, requested_by)
    values (me, s, coalesce(cur.lbs, 0), p_lbs, nullif(trim(p_note), ''), jwt_email()) returning * into q;
  end if;
  insert into events (user_email, type, note, details)
  values (jwt_email(), 'reserve_request', p_note, jsonb_build_object('customer_id', me, 'customer', (select name from customers where id = me),
          'strain', s, 'from', coalesce(cur.lbs, 0), 'to', p_lbs, 'request_id', q.id));
  return q.id;
end $$;

create or replace function cancel_reserve_request(p_id int) returns void
language plpgsql security definer set search_path = public as $$
begin
  update reserve_requests set status = 'cancelled', decided_by = jwt_email(), decided_at = now()
   where id = p_id and status = 'pending' and customer_id = my_customer();
  if not found then raise exception 'Request not found or already decided'; end if;
end $$;

create or replace function decide_reserve_request(p_id int, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare q reserve_requests; b reserve_balances;
begin
  if not is_admin() then raise exception 'Only an Admin can approve reserve changes'; end if;
  select * into q from reserve_requests where id = p_id for update;
  if q.id is null or q.status <> 'pending' then raise exception 'This request was already handled'; end if;
  if p_approve then
    select * into b from reserve_balances where customer_id = q.customer_id and lower(strain) = lower(q.strain);
    if q.requested_lbs < coalesce(b.shipped, 0) + coalesce(b.pending, 0) then
      raise exception 'They''ve shipped or ordered % lbs since asking, more than the requested reserve', coalesce(b.shipped, 0) + coalesce(b.pending, 0);
    end if;
    perform _apply_reserve(q.customer_id, q.strain, q.requested_lbs, coalesce(p_note, q.note), current_email(), 'request');
  end if;
  update reserve_requests set status = case when p_approve then 'approved' else 'declined' end,
         decided_by = current_email(), decided_at = now(), decision_note = nullif(trim(p_note), '')
   where id = q.id;
  insert into events (user_email, type, note, details)
  values (current_email(), case when p_approve then 'reserve_approved' else 'reserve_declined' end, p_note,
          jsonb_build_object('customer_id', q.customer_id, 'customer', (select name from customers where id = q.customer_id),
                             'strain', q.strain, 'from', q.current_lbs, 'to', q.requested_lbs, 'request_id', q.id));
end $$;

-- for the email: details of a request the caller just made, plus who to tell. Each request is sent once.
create or replace function request_notification(p_id int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare q reserve_requests;
begin
  update reserve_requests set notified_at = now()
   where id = p_id and notified_at is null and requested_by = jwt_email() and customer_id = my_customer()
  returning * into q;
  if q.id is null then return null; end if;
  return jsonb_build_object('customer', (select name from customers where id = q.customer_id), 'strain', q.strain,
    'from', q.current_lbs, 'to', q.requested_lbs, 'note', q.note, 'by', q.requested_by,
    'by_name', (select display_name from app_users where email = q.requested_by),
    'admins', (select jsonb_agg(email) from app_users where role = 'admin'));
end $$;

revoke execute on function request_reserve_change(text,numeric,text), cancel_reserve_request(int), decide_reserve_request(int,boolean,text), request_notification(int) from public, anon;
grant execute on function request_reserve_change(text,numeric,text), cancel_reserve_request(int), decide_reserve_request(int,boolean,text), request_notification(int) to authenticated;
