-- Read-only login for the nightly database backup (GitHub Actions).
-- Replace PUT-PASSWORD-HERE (letters and numbers only, 20+ characters), run once in the Supabase SQL Editor.
-- Safe to run again: it just resets the password and re-applies the grants.

do $$
declare pw text := 'PUT-PASSWORD-HERE';
begin
  if pw = 'PUT-PASSWORD-HERE' then raise exception 'Put your new password in first'; end if;
  if exists (select 1 from pg_roles where rolname = 'backup_reader') then
    execute format('alter role backup_reader with login password %L', pw);
  else
    execute format('create role backup_reader with login password %L', pw);
  end if;
  -- read past row-level security so the backup gets every row
  begin execute 'alter role backup_reader bypassrls'; exception when others then raise notice 'bypassrls: %', sqlerrm; end;
end $$;

-- App tables (and anything created later by migrations)
grant usage on schema public to backup_reader;
grant select on all tables in schema public to backup_reader;
grant select on all sequences in schema public to backup_reader;
alter default privileges in schema public grant select on tables to backup_reader;
alter default privileges in schema public grant select on sequences to backup_reader;

-- Logins and the storage file list (best effort; the result below shows what worked)
do $$ begin
  begin grant usage on schema auth to backup_reader; execute 'grant select on all tables in schema auth to backup_reader';
  exception when others then raise notice 'auth: %', sqlerrm; end;
  begin grant usage on schema storage to backup_reader; execute 'grant select on all tables in schema storage to backup_reader';
  exception when others then raise notice 'storage: %', sqlerrm; end;
end $$;

-- What the backup login can do (send Claude this row)
select
  split_part(version(), ' ', 2)                                          as postgres_version,
  (select rolbypassrls from pg_roles where rolname = 'backup_reader')    as reads_all_rows,
  has_table_privilege('backup_reader', 'public.pallets', 'select')       as app_tables,
  has_schema_privilege('backup_reader', 'auth', 'usage') and has_table_privilege('backup_reader', 'auth.users', 'select') as logins,
  has_schema_privilege('backup_reader', 'storage', 'usage') and has_table_privilege('backup_reader', 'storage.objects', 'select') as file_list;
