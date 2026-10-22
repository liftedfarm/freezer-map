-- Migration 034: Breeding in the Nursery: pollination runs (one donor x many receivers per trailer), seed lots,
-- pheno hunts with numbered phenos, group scoring (vigor, structure, aroma, color, tackiness, jar test, 1-5), keepers.
-- Run after 031. Safe to re-run.
set client_min_messages = warning;

-- a pollination run: one trailer, one donor (pollen) variety, many receiver varieties. Donors start and flower in their own trailer.
create table if not exists breed_runs (
  id              bigserial primary key,
  site            text not null default '1PN' references nursery_sites(code) on update cascade,
  season          int not null default extract(year from current_date)::int,
  name            text not null,
  room_id         int references nursery_rooms(id) on delete set null,      -- trailer the receivers flower in
  donor_strain    text not null,
  donor_mother_id bigint references nursery_mothers(id) on delete set null,
  donor_room_id   int references nursery_rooms(id) on delete set null,      -- where the donors start and flower
  donor_plants    int,
  donors_cut_on   date,
  donors_flip_on  date,
  receivers_cut_on date,
  receivers_planted_on date,
  flip_on         date,              -- receivers to flower
  pollinated_on   date,              -- donors moved in / pollen applied
  harvested_on    date,              -- seeds harvested
  status          text not null default 'planned' check (status in ('planned','growing','flowering','pollinated','harvested','done','cancelled')),
  notes           text,
  created_by      text default current_email(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists breed_receivers (
  id          bigserial primary key,
  run_id      bigint not null references breed_runs(id) on delete cascade,
  strain      text not null,
  mother_id   bigint references nursery_mothers(id) on delete set null,
  plants      int not null default 1 check (plants >= 0),
  plant_tag   text,
  notes       text,
  created_at  timestamptz not null default now()
);
create index if not exists breed_receivers_run_idx on breed_receivers (run_id);

-- seeds: from a run's receiver (in house) or bought / traded
create table if not exists seed_lots (
  id            bigserial primary key,
  code          text,                          -- short name for the cross, e.g. HBxP
  mother_strain text,                          -- receiver (seed parent)
  father_strain text,                          -- donor (pollen)
  run_id        bigint references breed_runs(id) on delete set null,
  receiver_id   bigint references breed_receivers(id) on delete set null,
  source        text not null default 'in-house' check (source in ('in-house','breeder','trade','other')),
  breeder       text,
  harvested_on  date,
  seeds         int,
  germ_pct      numeric,
  notes         text,
  created_by    text default current_email(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists pheno_hunts (
  id           bigserial primary key,
  site         text not null default '1PN' references nursery_sites(code) on update cascade,
  season       int not null default extract(year from current_date)::int,
  name         text not null,
  seed_lot_id  bigint references seed_lots(id) on delete set null,
  sown_on      date,
  seeds_sown   int,
  germinated   int,
  room_id      int references nursery_rooms(id) on delete set null,
  status       text not null default 'growing' check (status in ('sown','growing','scoring','done','cancelled')),
  notes        text,
  created_by   text default current_email(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists phenos (
  id            bigserial primary key,
  hunt_id       bigint not null references pheno_hunts(id) on delete cascade,
  number        int not null,
  label         text,                 -- HBxP #22
  plant_tag     text,
  room_id       int references nursery_rooms(id) on delete set null,
  bed           text,
  status        text not null default 'growing' check (status in ('growing','keeper','maybe','culled','male')),
  keeper_strain text,                 -- the name it became (Plantain Pressure)
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (hunt_id, number)
);

create table if not exists pheno_scores (
  id         bigserial primary key,
  pheno_id   bigint not null references phenos(id) on delete cascade,
  scorer     text not null default current_email(),
  scored_on  date not null default current_date,
  vigor      smallint check (vigor between 1 and 5),
  structure  smallint check (structure between 1 and 5),
  aroma      smallint check (aroma between 1 and 5),
  color      smallint check (color between 1 and 5),
  tackiness  smallint check (tackiness between 1 and 5),
  jar        smallint check (jar between 1 and 5),
  notes      text,
  created_at timestamptz not null default now(),
  unique (pheno_id, scorer)
);

-- read: Nursery (and Admin); write: Nursery users. Scores: everyone with Nursery scores for themselves.
do $$
declare t text;
begin
  foreach t in array array['breed_runs','breed_receivers','seed_lots','pheno_hunts','phenos','pheno_scores'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists n_read on %I', t);
    execute format('drop policy if exists n_add on %I', t);
    execute format('drop policy if exists n_edit on %I', t);
    execute format('drop policy if exists n_delete on %I', t);
    execute format('create policy n_read on %I for select to authenticated using (has_module(''nursery'') or is_admin())', t);
    execute format('grant select, insert, update, delete on %I to authenticated', t);
    execute format('grant usage on sequence %I to authenticated', t || '_id_seq');
    if t <> 'pheno_scores' then
      execute format('create policy n_add on %I for insert to authenticated with check (has_module(''nursery'') and not impersonating())', t);
      execute format('create policy n_edit on %I for update to authenticated using (has_module(''nursery'')) with check (has_module(''nursery'') and not impersonating())', t);
      execute format('create policy n_delete on %I for delete to authenticated using (has_module(''nursery'') and not impersonating())', t);
    end if;
  end loop;
end $$;
create policy n_add on pheno_scores for insert to authenticated with check (has_module('nursery') and scorer = current_email() and not impersonating());
create policy n_edit on pheno_scores for update to authenticated using (scorer = current_email()) with check (scorer = current_email() and not impersonating());
create policy n_delete on pheno_scores for delete to authenticated using ((scorer = current_email() or is_mod_admin('nursery')) and not impersonating());

-- strain names through the Strains list; changes go in Activity
do $$
declare t text;
begin
  foreach t in array array['breed_receivers'] loop
    execute format('drop trigger if exists %I on %I', t || '_strain', t);
    execute format('create trigger %I before insert or update of strain on %I for each row execute function cult_strain_name()', t || '_strain', t);
  end loop;
end $$;
create or replace function breed_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare r jsonb := to_jsonb(coalesce(new, old));
begin
  if tg_op = 'UPDATE' then
    new.updated_at := now(); r := to_jsonb(new);
    if (r - 'updated_at') = (to_jsonb(old) - 'updated_at') then return new; end if;
  end if;
  insert into events (user_email, type, note, details)
  values (current_email(), 'nursery_breed_' || tg_table_name || '_' || lower(tg_op), coalesce(r ->> 'name', r ->> 'label', r ->> 'code'), jsonb_build_object('row', r));
  return coalesce(new, old);
end $$;
do $$
declare t text;
begin
  foreach t in array array['breed_runs','seed_lots','pheno_hunts','phenos'] loop
    execute format('drop trigger if exists %I on %I', t || '_audit', t);
    execute format('create trigger %I before insert or update or delete on %I for each row execute function breed_audit()', t || '_audit', t);
  end loop;
end $$;

-- a hunt's phenos #1..#N in one go
create or replace function pheno_hunt_number(p_hunt bigint, p_count int, p_prefix text) returns int
language plpgsql security definer set search_path = public as $$
declare h pheno_hunts; start int; n int := 0;
begin
  perform no_view_as();
  if not has_module('nursery') then raise exception 'The Nursery module isn''t switched on for your account'; end if;
  select * into h from pheno_hunts where id = p_hunt;
  if h.id is null then raise exception 'Hunt not found'; end if;
  if coalesce(p_count, 0) <= 0 or p_count > 2000 then raise exception 'How many phenos?'; end if;
  select coalesce(max(number), 0) into start from phenos where hunt_id = p_hunt;
  insert into phenos (hunt_id, number, label, room_id)
  select p_hunt, start + g, nullif(trim(coalesce(p_prefix, '')), '') || ' #' || (start + g), h.room_id from generate_series(1, p_count) g;
  get diagnostics n = row_count;
  return n;
end $$;

-- keeper: name it, put it on the Strains list (lineage from the cross)
create or replace function pheno_keeper(p_pheno bigint, p_name text) returns phenos
language plpgsql security definer set search_path = public as $$
declare p phenos; h pheno_hunts; s seed_lots; nm text := nullif(trim(p_name), '');
begin
  perform no_view_as();
  if not has_module('nursery') then raise exception 'The Nursery module isn''t switched on for your account'; end if;
  select * into p from phenos where id = p_pheno;
  if p.id is null then raise exception 'Pheno not found'; end if;
  nm := coalesce(nm, p.label);
  select * into h from pheno_hunts where id = p.hunt_id;
  select * into s from seed_lots where id = h.seed_lot_id;
  if canonical_strain(nm) is null then
    insert into strains (name, lineage, breeder, active, notes)
    values (nm, nullif(concat_ws(' x ', s.mother_strain, s.father_strain), ''), coalesce(s.breeder, case when s.source = 'in-house' then 'Lifted (in house)' end), true,
            'Keeper from pheno hunt ' || h.name || ', ' || coalesce(p.label, '#' || p.number));
  end if;
  update phenos set status = 'keeper', keeper_strain = coalesce(canonical_strain(nm), nm) where id = p.id returning * into p;
  return p;
end $$;
revoke execute on function pheno_hunt_number(bigint, int, text), pheno_keeper(bigint, text), breed_audit() from public, anon;
grant execute on function pheno_hunt_number(bigint, int, text), pheno_keeper(bigint, text) to authenticated;

-- only 4 trailers (the 4 rooting chambers): remove Trailer 5 (just turn it off if anything ever pointed at it)
update nursery_rooms r set active = false where r.name = 'Trailer 5' and r.site = '1PN';
delete from nursery_rooms r where r.name = 'Trailer 5' and r.site = '1PN'
   and not exists (select 1 from nursery_batches b where b.room_id = r.id) and not exists (select 1 from nursery_mothers m where m.room_id = r.id)
   and not exists (select 1 from pheno_hunts h where h.room_id = r.id) and not exists (select 1 from breed_runs x where x.room_id = r.id or x.donor_room_id = r.id)
   and not exists (select 1 from phenos p where p.room_id = r.id) and not exists (select 1 from nursery_tests t where t.room_id = r.id);

select 'ok' as breeding;
