-- 096: "canceling statement due to statement timeout".
-- Every row-level security rule called is_staff(), can_edit('...'), has_module('...') and friends once PER ROW. Each of
-- those looks up the signed-in user (app_users, module access, view-as), so reading 20,000 events or 4,000 METRC packages
-- ran tens of thousands of lookups and hit Supabase's 8-second limit; the app's own functions read through the same rules.
-- Wrapping each call as (SELECT is_staff()) makes Postgres work it out once per query instead. Same rules, same answers:
-- only calls with no column inputs are wrapped (who you are, which module), never ones that depend on the row.
-- Run once in Supabase after 095_combine_parts.sql. Safe to re-run (already wrapped calls are left alone).
do $$
declare
  r record; q text; c text; n int := 0;
  -- no-argument calls about the signed-in user
  plain text := '(?<!SELECT )\m(is_staff|is_admin|is_sales|is_owner|impersonating|comp_can_read|is_sales_admin|is_any_admin|can_see_pay|my_customer|current_email|jwt_email|real_email|my_role|is_customer)\(\)';
  -- module checks with a fixed module name
  modarg text := '(?<!SELECT )\m(can_edit|has_module|is_mod_admin|mod_level|manages_module)\(''([a-z_]+)''::text\)';
begin
  for r in select schemaname, tablename, policyname, cmd, qual, with_check from pg_policies where schemaname = 'public' loop
    q := r.qual; c := r.with_check;
    if q is not null then
      q := regexp_replace(q, plain, '(SELECT \1())', 'g');
      q := regexp_replace(q, modarg, '(SELECT \1(''\2''::text))', 'g');
    end if;
    if c is not null then
      c := regexp_replace(c, plain, '(SELECT \1())', 'g');
      c := regexp_replace(c, modarg, '(SELECT \1(''\2''::text))', 'g');
    end if;
    if q is distinct from r.qual or c is distinct from r.with_check then
      execute format('alter policy %I on %I.%I', r.policyname, r.schemaname, r.tablename)
           || case when q is not null then format(' using (%s)', q) else '' end
           || case when c is not null then format(' with check (%s)', c) else '' end;
      n := n + 1;
    end if;
  end loop;
  raise notice '% policies sped up', n;
end $$;

-- lookups the app's functions do by pallet and by tag
create index if not exists pallets_tag_upper_trim on pallets (upper(trim(package_tag))) where package_tag is not null;
create index if not exists metrc_packages_label_upper on metrc_packages (upper(trim(label)));

select count(*) filter (where coalesce(qual, '') || coalesce(with_check, '') ~ '(?<!SELECT )\mis_staff\(\)') as still_per_row,
       count(*) as policies
  from pg_policies where schemaname = 'public';
