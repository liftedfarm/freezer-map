-- Migration 014: reserves switched on per customer.
-- Customers without reserves can still get a portal login, but only to order off the open menu
-- (no reserve section, no reserve requests). Turned on for every customer that has reserves today,
-- and turns on by itself when an Admin adds a reserve. Run after 013_view_as.sql. Safe to re-run.
set client_min_messages = warning;

alter table customers add column if not exists reserves_enabled boolean not null default false;
update customers c set reserves_enabled = true
 where not c.reserves_enabled and exists (select 1 from reserves r where r.customer_id = c.id);

-- adding a reserve switches it on
create or replace function reserves_switch_on() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.lbs > 0 then
    update customers set reserves_enabled = true where id = new.customer_id and not reserves_enabled;
  end if;
  return new;
end $$;
drop trigger if exists reserves_switch_on on reserves;
create trigger reserves_switch_on after insert or update of lbs on reserves for each row execute function reserves_switch_on();

-- what a customer can order: reserve left only counts when reserves are on
create or replace function _orderable(p_customer int)
returns table (strain text, my_left numeric, open_lbs numeric, can_order numeric)
language sql stable security definer set search_path = public as $$
  select m.strain, case when c.reserves_enabled then coalesce(b.remaining, 0) else 0 end, greatest(floor(m.free / 10) * 10, 0),
         case when c.reserves_enabled then floor(coalesce(b.remaining, 0) / 10) * 10 else 0 end + greatest(floor(m.free / 10) * 10, 0)
    from _menu_numbers() m
    join customers c on c.id = p_customer
    left join reserve_balances b on b.customer_id = p_customer and lower(b.strain) = lower(m.strain)
$$;
revoke execute on function _orderable(int) from public, anon, authenticated;

create or replace function my_terms() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('name', name, 'price_per_lb', price_per_lb, 'contract_lbs', contract_lbs, 'reserves_enabled', reserves_enabled)
    from customers where id = my_customer()
$$;

-- no reserve requests unless reserves are on
do $$
declare def text := pg_get_functiondef('request_reserve_change(text,numeric,text)'::regprocedure);
begin
  if def not like '%reserves_enabled%' then
    execute regexp_replace(def, E'\nbegin\n', E'\nbegin\n  if not coalesce((select reserves_enabled from customers where id = my_customer()), false) then\n    raise exception ''Reserves aren''''t set up for your account. Contact Lifted.'';\n  end if;\n');
  end if;
end $$;

-- check
select name, reserves_enabled from customers where kind = 'external' and active order by reserves_enabled desc, name;
