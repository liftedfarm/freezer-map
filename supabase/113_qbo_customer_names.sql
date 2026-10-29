-- 113: QuickBooks customer names, for Admin > Settings > Customers > Import from QuickBooks.
--  * customers.qbo_name: the customer's name exactly as in QuickBooks (Display name). Invoices sent to QuickBooks match
--    on it first, so an app name or legal name that's spelled differently no longer makes a duplicate customer there.
--  * Two app customers can't point at the same QuickBooks customer.
--  * Changing it forgets the old QuickBooks match, so the next invoice matches the new name.
-- Run once in Supabase (any time; the app works with or without it, but the import needs it). Safe to re-run.
begin;

alter table customers add column if not exists qbo_name text;
create unique index if not exists customers_qbo_name_key on customers (lower(qbo_name)) where qbo_name is not null;

create or replace function customer_qbo_name_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.qbo_name is distinct from old.qbo_name then
    new.qbo_name := nullif(trim(new.qbo_name), '');
    delete from qbo_refs where kind = 'customer' and key = new.id::text;
  end if;
  return new;
end $$;
drop trigger if exists customer_qbo_name_changed on customers;
create trigger customer_qbo_name_changed before update of qbo_name on customers for each row execute function customer_qbo_name_changed();

-- the server gets it with the invoice
do $$
declare d text;
begin
  select pg_get_functiondef('acct_invoice_payload(int)'::regprocedure) into d;
  if position('''qbo_name''' in d) > 0 then raise notice 'acct_invoice_payload already sends qbo_name'; return; end if;
  if position('''license'', c.license,' in d) = 0 then raise exception 'acct_invoice_payload has changed: tell Claude (nothing was changed)'; end if;
  execute replace(d, '''license'', c.license,', '''license'', c.license, ''qbo_name'', c.qbo_name,');
end $$;

commit;

select (select count(*) from information_schema.columns where table_name = 'customers' and column_name = 'qbo_name') as column_added,
       position('qbo_name' in pg_get_functiondef('acct_invoice_payload(int)'::regprocedure)) > 0 as payload_updated;
