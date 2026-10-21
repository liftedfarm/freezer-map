-- One-time strain cleanup (run after 003_settings.sql). Safe to re-run.
--   Guava Tart          -> Guava Tartz
--   Dragon Fruit  Soda  -> Dragonfruit Soda
-- Pallets get the new name (logged in each pallet's history); old spellings
-- become "other names" on the strain so imports still match them.

begin;

create temp table fixes (old_name text, new_name text) on commit drop;
insert into fixes values
  ('Guava Tart',         'Guava Tartz'),
  ('Dragon Fruit  Soda', 'Dragonfruit Soda'),
  ('Dragon Fruit Soda',  'Dragonfruit Soda');

-- 1. pallets: rename and log
insert into events (user_email, type, pallet_id, note, details)
select 'strain cleanup', 'strain_renamed', p.id, 'Strain name cleanup',
       jsonb_build_object('from', p.strain, 'to', f.new_name)
  from pallets p join fixes f on p.strain = f.old_name;
update pallets p set strain = f.new_name, updated_at = now()
  from fixes f where p.strain = f.old_name;

-- 2. strains list: make sure the right name exists
insert into strains (name)
select distinct f.new_name from fixes f
 where not exists (select 1 from strains s where lower(s.name) = lower(f.new_name))
   and not exists (select 1 from strains s where s.name = f.old_name);
update strains s set name = f.new_name
  from fixes f
 where s.name = f.old_name
   and not exists (select 1 from strains t where lower(t.name) = lower(f.new_name));

-- 3. add old spellings as other names, and retire leftover duplicate entries
update strains s
   set aliases = (select array_agg(distinct a) from unnest(s.aliases || array(select old_name from fixes f where f.new_name = s.name)) a)
 where s.name in (select new_name from fixes);
update strains s set active = false
  from fixes f where s.name = f.old_name and s.active;

commit;

select name, aliases, active from strains where name in ('Guava Tartz','Guava Tart','Dragonfruit Soda','Dragon Fruit  Soda') order by name;
select strain, count(*) from pallets where strain in ('Guava Tartz','Guava Tart','Dragonfruit Soda','Dragon Fruit  Soda') group by 1;
