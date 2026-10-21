-- Migration 009: reserves (lbs of fresh frozen held for a customer, by strain).
-- Run once in Supabase after 008: SQL Editor > New query > paste > Run. Safe to re-run.
-- Admin and Sales see and edit all reserves. A customer login sees only its own. Crew sees none.
set client_min_messages = warning;

create table if not exists reserves (
  id          serial primary key,
  customer_id int not null references customers(id),
  strain      text not null,
  product     text not null default 'fresh_frozen',
  lbs         numeric not null check (lbs >= 0),
  notes       text,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_by  text,
  updated_at  timestamptz not null default now()
);
create unique index if not exists reserves_uq on reserves (customer_id, lower(strain), product);

-- the customer a portal login belongs to
create or replace function my_customer() returns int
language sql stable security definer set search_path = public as $$
  select case when my_role() = 'customer' then (select customer_id from app_users where email = jwt_email()) end
$$;

alter table reserves enable row level security;
drop policy if exists read_reserves on reserves;
create policy read_reserves on reserves for select to authenticated
  using (is_sales() or customer_id = my_customer());
grant select on reserves to authenticated;

-- strain name as it is in the Strains list (matches other names too)
create or replace function canonical_strain(p text) returns text
language sql stable security definer set search_path = public as $$
  select s.name from strains s
   where lower(s.name) = lower(trim(p)) or lower(trim(p)) = any(select lower(a) from unnest(s.aliases) a)
   order by (lower(s.name) = lower(trim(p))) desc limit 1
$$;

-- Admin/Sales: set a customer's reserve for a strain (0 removes it)
create or replace function set_reserve(p_customer int, p_strain text, p_lbs numeric, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare s text := canonical_strain(p_strain); was reserves; c customers;
begin
  if not is_sales() then raise exception 'Only Sales or an Admin can change reserves'; end if;
  select * into c from customers where id = p_customer;
  if c.id is null then raise exception 'Customer not found'; end if;
  if s is null then raise exception '"%" isn''t in the Strains list. Add it in Settings > Strains first.', p_strain; end if;
  if p_lbs is null or p_lbs < 0 then raise exception 'Reserve must be 0 or more lbs'; end if;
  select * into was from reserves where customer_id = p_customer and lower(strain) = lower(s) and product = 'fresh_frozen';
  if p_lbs = 0 then
    delete from reserves where id = was.id;
  elsif was.id is null then
    insert into reserves (customer_id, strain, lbs, notes, created_by, updated_by)
    values (p_customer, s, p_lbs, nullif(trim(p_note), ''), current_email(), current_email());
  else
    update reserves set lbs = p_lbs, notes = coalesce(nullif(trim(p_note), ''), notes), updated_by = current_email(), updated_at = now()
     where id = was.id;
  end if;
  insert into events (user_email, type, note, details)
  values (current_email(), 'reserve_set', p_note,
          jsonb_build_object('customer', c.name, 'customer_id', c.id, 'strain', s, 'lbs', p_lbs, 'was', was.lbs));
end $$;

-- the activity log hides reserve changes from Crew
drop policy if exists read_all on events;
create policy read_all on events for select to authenticated
  using (is_staff() and (is_sales() or not ((type = 'settings' and details ->> 'list' = 'customers') or type like 'reserve%')));

revoke execute on function set_reserve(int,text,numeric,text), canonical_strain(text) from public, anon;
grant execute on function set_reserve(int,text,numeric,text) to authenticated;

-- ---------- Hash Birds reserves (requested 2026-10-21) ----------
insert into customers (name, kind)
select 'Hash Birds', 'external'
 where not exists (select 1 from customers where name ilike 'hash bird%');

with hb as (select id from customers where name ilike 'hash bird%' order by id limit 1),
     want(strain, lbs) as (values ('Banana Bonanza', 1950), ('Hashburger', 1950), ('Rainbow Guava', 1950), ('Honeycomb Rainbow', 650)),
     ins as (
       insert into reserves (customer_id, strain, lbs, created_by, updated_by)
       select hb.id, coalesce(canonical_strain(w.strain), w.strain), w.lbs, 'aziz@lifted-organics.com', 'aziz@lifted-organics.com'
         from hb, want w
       on conflict (customer_id, lower(strain), product) do update set lbs = excluded.lbs, updated_at = now()
       returning *)
insert into events (user_email, type, note, details)
select 'aziz@lifted-organics.com', 'reserve_set', 'setup',
       jsonb_build_object('customer', c.name, 'customer_id', c.id, 'strain', i.strain, 'lbs', i.lbs)
  from ins i join customers c on c.id = i.customer_id;

-- check
select c.name as customer, r.strain, r.lbs from reserves r join customers c on c.id = r.customer_id order by 1, 2;
