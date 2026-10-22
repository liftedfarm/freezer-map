
-- anything logged that isn't a product yet, in either module
insert into input_products (module, name)
select distinct l.module, trim(x ->> 'product') from ops_logs l, jsonb_array_elements(l.products) x
 where coalesce(trim(x ->> 'product'), '') <> ''
   and not exists (select 1 from input_products p where p.module = l.module and lower(p.name) = lower(trim(x ->> 'product')))
on conflict do nothing;

-- typical rate = the rate logged most often (only where the product has none yet)
update input_products p set rate = t.rate, rate_unit = t.unit || '/' || t.basis
  from (select distinct on (l.module, lower(x ->> 'product')) l.module, lower(x ->> 'product') as nm, (x ->> 'rate')::numeric as rate, x ->> 'unit' as unit,
               coalesce(x ->> 'basis', case when l.module = 'nursery' then 'gal' else 'acre' end) as basis
          from ops_logs l, jsonb_array_elements(l.products) x
         where x ->> 'rate' is not null and coalesce(x ->> 'unit', '') <> ''
         group by 1, 2, 3, 4, 5 order by l.module, lower(x ->> 'product'), count(*) desc) t
 where p.module = t.module and lower(p.name) = t.nm and p.rate is null;

-- who can change products: that module's Admins (anyone in the module can add one from a log)
drop policy if exists n_read on input_products;
drop policy if exists n_add on input_products;
drop policy if exists n_edit on input_products;
drop policy if exists n_delete on input_products;
create policy n_read on input_products for select to authenticated using (has_module(module) or is_admin());
create policy n_add on input_products for insert to authenticated with check (has_module(module) and not impersonating());
create policy n_edit on input_products for update to authenticated using (is_mod_admin(module)) with check (is_mod_admin(module) and not impersonating());
create policy n_delete on input_products for delete to authenticated using (is_mod_admin(module) and not impersonating());
grant select, insert, update, delete on input_products to authenticated;

select module, count(*) as products, (select count(*) from ops_logs l where l.module = p.module) as logs from input_products p group by module order by module;
