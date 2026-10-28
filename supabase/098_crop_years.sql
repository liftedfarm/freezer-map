-- 098: crop years on pallets and order lines.
--  1. Every pallet gets a crop year: its harvest's crop year, else the year of its harvest date (Aziz: harvests never cross
--     the new year). Before: almost every pallet had none, so 2025 and 2026 product looked the same to Sales and Fulfillment.
--  2. New pallets get it the same way automatically (pallet_crop_default).
--  3. Assigning a pallet to an order line checks the crop year matches (2025 pallets on 2025 lines, 2026 on 2026).
--  4. Order #29 (Washed LA): lines set to the crop year that's actually in stock for each strain.
-- Run once in Supabase after 097_audit_weight.sql. Safe to re-run. The first result shows the counts per year.
begin;

-- what it will do (before)
create temp table _before on commit drop as
select coalesce(crop_year::text, 'none') as crop_year, count(*) as pallets from pallets group by 1;

-- 1. fill in
update pallets p set crop_year = x.yr
  from (select q.id, coalesce((select h.crop_year from cult_harvests h where h.id = coalesce(q.harvest_id, q.from_harvest)),
                              extract(year from q.harvest_date)::int) as yr
          from pallets q where q.crop_year is null) x
 where p.id = x.id and x.yr is not null;

-- 2. new pallets (and ones whose harvest date gets filled in later)
create or replace function pallet_crop_default() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.crop_year is null then
    new.crop_year := coalesce((select h.crop_year from cult_harvests h where h.id = coalesce(new.harvest_id, new.from_harvest)),
                              extract(year from new.harvest_date)::int);
  end if;
  return new;
end $$;
drop trigger if exists pallet_crop_default on pallets;
-- named so it runs before pallet_set_item_lot (triggers fire in name order)
create trigger pallet_crop_default before insert or update of harvest_date, harvest_id, from_harvest, crop_year on pallets
  for each row execute function pallet_crop_default();

-- 3. assigning to an order line: same crop year
do $$
declare d text; anchor text := 'if p.product <> ln.product then raise exception ''% is %, this line is %'', p.code, product_label(p.product), product_label(ln.product); end if;';
begin
  select pg_get_functiondef('pick_pallet(int, bigint)'::regprocedure) into d;
  if position('crop, this line is' in d) > 0 then raise notice 'pick_pallet already checks crop year';
  elsif position(anchor in d) = 0 then raise notice 'pick_pallet: product check not found, crop check NOT added (tell Claude)';
  else
    d := replace(d, anchor, anchor || '
  if p.crop_year is not null and ln.crop_year is not null and p.crop_year <> ln.crop_year then
    raise exception ''% is % crop, this line is % crop'', p.code, p.crop_year, ln.crop_year;
  end if;');
    execute d;
    raise notice 'pick_pallet now checks crop year';
  end if;
end $$;

-- 4. order #29: each fresh frozen line goes to the crop year that's in stock for that strain (a line with pallets
--    already assigned follows those pallets). Lines whose year has stock stay as they are.
create temp table _o29 on commit drop as
with stock as (
  select lower(coalesce(canonical_strain(p.strain), p.strain)) as k, p.crop_year as yr, sum(p.current_weight) as lbs
    from pallets p
   where p.status in ('in_freezer', 'unslotted') and coalesce(p.product, 'fresh_frozen') = 'fresh_frozen' and p.kind = 'package' and p.crop_year is not null
   group by 1, 2)
select l.id, l.strain, l.crop_year as was,
       coalesce((select max(p.crop_year) from order_picks x join pallets p on p.id = x.pallet_id where x.order_line_id = l.id),
                case when exists (select 1 from stock s where s.k = lower(coalesce(canonical_strain(l.strain), l.strain)) and s.yr = l.crop_year) then l.crop_year
                     else (select max(s.yr) from stock s where s.k = lower(coalesce(canonical_strain(l.strain), l.strain))) end,
                l.crop_year) as now
  from order_lines l join orders o on o.id = l.order_id
 where o.id = 29 and o.status in ('pending', 'submitted') and coalesce(l.product, 'fresh_frozen') = 'fresh_frozen';
update order_lines l set crop_year = x.now from _o29 x where x.id = l.id and x.now is distinct from x.was;

-- 5. Sales can change a line's crop year on an open order (Sales > Orders > Edit)
create or replace function set_order_line_year(p_line int, p_year int) returns void
language plpgsql security definer set search_path = public as $$
declare l order_lines; o orders; bad text;
begin
  if not is_sales() then raise exception 'Only Sales or an Admin can change orders'; end if;
  select * into l from order_lines where id = p_line for update;
  if l.id is null then raise exception 'Line not found'; end if;
  select * into o from orders where id = l.order_id;
  if o.status not in ('pending', 'submitted') then raise exception 'That order isn''t open'; end if;
  if p_year is null or p_year < 2020 or p_year > crop_year() + 1 then raise exception 'Pick a crop year'; end if;
  if l.crop_year = p_year then return; end if;
  select string_agg(p.code, ', ') into bad from order_picks x join pallets p on p.id = x.pallet_id
   where x.order_line_id = l.id and p.crop_year is not null and p.crop_year <> p_year;
  if bad is not null then raise exception '% % assigned to this line. Take them off in Fulfillment first.', bad, case when position(',' in bad) > 0 then 'are' else 'is' end; end if;
  update order_lines set crop_year = p_year, updated_at = now() where id = l.id;
  update orders set updated_at = now() where id = o.id;
  insert into events (user_email, type, details)
  values (current_email(), 'order_line', jsonb_build_object('order_id', o.id, 'strain', l.strain, 'crop_year', p_year, 'was_year', l.crop_year,
          'customer', (select name from customers where id = o.customer_id)));
end $$;
revoke execute on function set_order_line_year(int, int) from public, anon;
grant execute on function set_order_line_year(int, int) to authenticated;

select 'pallets by crop year' as what, b.crop_year as before_year, b.pallets as before,
       null::text as after_year, null::bigint as after from _before b
union all
select 'pallets by crop year', null, null, coalesce(crop_year::text, 'none'), count(*) from pallets group by crop_year
union all
select 'order 29: ' || strain, was::text, null, now::text, null from _o29;
commit;
