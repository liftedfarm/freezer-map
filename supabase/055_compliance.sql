-- Migration 055: Compliance module (METRC, CCOF, document library, deadlines) + pre-harvest test files on every package.
-- Run once in Supabase after 054_item_model.sql: SQL Editor > New query > paste > Run. Safe to re-run.
--
--  * New module "Compliance" (Off / View / User / Admin in Users and access). Beth = Admin (Owners Aziz and Matt have everything).
--  * Files live in a private storage bucket "compliance". Only signed-in staff can open them, through links that expire
--    after a few minutes. Anyone who can edit in Compliance, Production, Nursery, Sales or Processing can upload.
--  * Document library: one list, tagged by type, site / license, crop year and linked to records (harvest test, pallet,
--    material, license, customer, METRC error). Versions, effective / expiry dates, owner. Deleting only hides it here;
--    the SharePoint copy moves to an _Archived folder.
--  * Deadlines: recurring obligations (owner, due date, reminder, repeat) plus everything with an expiry date
--    (documents, licenses, material listings, customer licenses) in one list.
--  * CCOF: approval status / listing / expiry on the Production and Nursery product lists; application log report
--    built from the Feed and Spray logs (nobody enters anything twice).
--  * METRC: every app action METRC needs (new packages, splits, combines, weight changes, runs, transfers) lands in a
--    to-do queue from now on. Upload the METRC Active Packages CSV per license to compare with the app. Error log + playbook.
--  * Testing: results (PDF + key numbers) attach to the Production > Testing entry. Every package from that harvest shows
--    it: fresh frozen and biomass use their field's area composite, dry flower uses its strain test.
--  * Customers: license expiry (Sales gets a warning on orders when it's missing or expired).
set client_min_messages = warning;

-- ---------- the module ----------
alter table module_access drop constraint if exists module_access_module_check;
alter table module_access add constraint module_access_module_check
  check (module in ('distribution','sales','cultivation','nursery','processing','accounting','compliance','admin'));

do $$
declare f text; d text;
begin
  foreach f in array array['my_access(','my_modules(','save_user('] loop
    select pg_get_functiondef(p.oid) into d from pg_proc p where p.oid::regprocedure::text like f || '%' and p.pronamespace = 'public'::regnamespace;
    if d is not null and d not like '%''compliance''%' then execute replace(d, '''processing'',''accounting''', '''processing'',''accounting'',''compliance'''); end if;
  end loop;
  d := null;
  if to_regprocedure('set_module_level(text,text,text)') is not null then select pg_get_functiondef('set_module_level(text,text,text)'::regprocedure) into d; end if;
  if d is not null and d not like '%''compliance''%' then execute replace(d, '''processing'',''accounting''', '''processing'',''accounting'',''compliance'''); end if;
end $$;
create or replace function is_any_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(mod_level('distribution') = 'admin', false) or coalesce(mod_level('sales') = 'admin', false)
      or coalesce(mod_level('cultivation') = 'admin', false) or coalesce(mod_level('nursery') = 'admin', false)
      or coalesce(mod_level('processing') = 'admin', false) or coalesce(mod_level('accounting') = 'admin', false)
      or coalesce(mod_level('compliance') = 'admin', false) or mod_level('admin') is not null
$$;

-- who gets it (as Aziz asked): Beth = Admin. Matt and Aziz are Owners. Sasha can be added in Users and access.
do $$
begin
  if not exists (select 1 from module_access where module = 'compliance') then
    insert into module_access (email, module, level)
    select email, 'compliance', 'admin' from app_users where email in ('beth@lifted-organics.com') and not coalesce(owner, false)
    on conflict (email, module) do nothing;
    perform sync_role(email) from app_users where email in ('beth@lifted-organics.com');
  end if;
end $$;

-- ---------- who can do what ----------
create or replace function comp_can_read() returns boolean
language sql stable security definer set search_path = public as $$ select coalesce(is_staff(), false) $$;
create or replace function comp_can_upload() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(is_staff(), false) and not impersonating()
     and (can_edit('compliance') or can_edit('cultivation') or can_edit('nursery') or can_edit('sales') or can_edit('processing') or can_edit('distribution'))
$$;
create or replace function comp_can_edit() returns boolean
language sql stable security definer set search_path = public as $$ select can_edit('compliance') and not impersonating() $$;
create or replace function comp_is_admin() returns boolean
language sql stable security definer set search_path = public as $$ select (is_mod_admin('compliance') or is_owner()) and not impersonating() $$;
/** for the server functions (SharePoint backup): who is calling and their Compliance level */
create or replace function comp_me() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('email', current_email(), 'level', mod_level('compliance'), 'admin', coalesce(is_mod_admin('compliance') or is_owner(), false))
$$;
revoke execute on function comp_can_read(), comp_can_upload(), comp_can_edit(), comp_is_admin(), comp_me() from public, anon;
grant execute on function comp_can_read(), comp_can_upload(), comp_can_edit(), comp_is_admin(), comp_me() to authenticated;

-- ---------- file storage (private bucket) ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('compliance', 'compliance', false, 52428800)
on conflict (id) do update set public = false;
drop policy if exists comp_files_read on storage.objects;
create policy comp_files_read on storage.objects for select to authenticated using (bucket_id = 'compliance' and public.comp_can_read());
drop policy if exists comp_files_add on storage.objects;
create policy comp_files_add on storage.objects for insert to authenticated with check (bucket_id = 'compliance' and public.comp_can_upload());

-- ---------- document types (= SharePoint folders) ----------
create table if not exists comp_doc_types (
  key      text primary key,
  label    text not null,
  folder   text not null,                 -- folder name under Compliance Archive in SharePoint
  sort     int not null default 0,
  expires  boolean not null default false, -- ask for an expiry date
  active   boolean not null default true,
  notes    text
);
insert into comp_doc_types (key, label, folder, sort, expires, notes) values
  ('testing',      'Cannabis Testing',        'Cannabis Testing',        1, false, 'Pre-harvest results, COAs'),
  ('licenses',     'Licenses',                'Licenses',                2, true,  'DCC state licenses, county permits'),
  ('ccof_cert',    'CCOF Certification',      'CCOF Certification',      3, true,  'OCal certificates, OSP, inspection reports'),
  ('ccof_records', 'CCOF Records',            'CCOF Records',            4, false, 'Soil affidavits, cover crop docs, labeling approvals, post harvest handling'),
  ('fertilizers',  'Fertilizers',             'Fertilizers',             5, true,  'Labels, SDS, OMRI / CDFA OIM listings'),
  ('pesticides',   'Pesticides',              'Pesticides',              6, true,  'Labels, SDS, listings, registrations'),
  ('receipts',     'Input Purchases',         'Input Purchases',         7, false, 'Receipts and invoices for inputs'),
  ('applications', 'Applications',            'Applications',            8, false, 'Renewals, CCOF applications, county and state submittals'),
  ('sops',         'SOPs',                    'SOPs',                    9, false, 'Standard operating procedures'),
  ('inspections',  'Inspections and Notices', 'Inspections and Notices', 10, false, 'Inspection reports, notices, responses'),
  ('reports',      'Reports',                 'Reports',                 11, false, 'Pesticide use reports, METRC reconciliations, other filings'),
  ('metrc',        'METRC',                   'METRC',                   12, false, 'Exports, screenshots, designations'),
  ('customers',    'Customer Licenses',       'Customer Licenses',       13, true,  'Licenses of the people we sell to'),
  ('partners',     'Partner Licenses',        'Partner Licenses',        14, true,  'Processors, transporters, labs'),
  ('security',     'Security and Premises',   'Security and Premises',   15, false, 'Security plans, premises diagrams'),
  ('waste',        'Waste Management',        'Waste Management',        16, false, 'Waste logs and hauler records'),
  ('water',        'Water and Environmental', 'Water and Environmental', 17, true,  'Water board, CEQA, environmental'),
  ('transport',    'Transport and Vehicles',  'Transport and Vehicles',  18, true,  'Vehicle registration, distributor transport'),
  ('insurance',    'Insurance',               'Insurance',               19, true,  'Policies and certificates'),
  ('training',     'Training Records',        'Training Records',        20, false, 'Staff training and sign-offs'),
  ('other',        'Other',                   'Other',                   99, false, null)
on conflict (key) do nothing;

-- ---------- documents ----------
create table if not exists comp_docs (
  id             bigserial primary key,
  doc_type       text not null references comp_doc_types(key) on update cascade,
  title          text not null,
  site           text,                       -- OHR / GVR / 1PN / blank = company
  license_no     text,
  crop_year      int,
  effective_on   date,
  expires_on     date,
  notes          text,
  owner_email    text,
  file_path      text unique,                -- path in the compliance bucket (blank = SharePoint link only)
  file_name      text,
  mime           text,
  size_bytes     bigint,
  link_url       text,                       -- optional link to the SharePoint original
  version        int not null default 1,
  replaces_id    bigint references comp_docs(id),
  current        boolean not null default true,
  deleted_at     timestamptz,
  deleted_by     text,
  -- SharePoint backup (server only)
  backed_up_at   timestamptz,
  sp_item_id     text,
  sp_path        text,
  sp_archived    boolean not null default false,
  backup_error   text,
  created_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists comp_docs_type on comp_docs (doc_type) where deleted_at is null;
create index if not exists comp_docs_exp on comp_docs (expires_on) where deleted_at is null and current;

create table if not exists comp_doc_links (
  doc_id    bigint not null references comp_docs(id) on delete cascade,
  ref_kind  text not null check (ref_kind in ('test','pallet','lot','harvest','material','license','customer','metrc_error','obligation','processor')),
  ref_id    text not null,
  primary key (doc_id, ref_kind, ref_id)
);
create index if not exists comp_doc_links_ref on comp_doc_links (ref_kind, ref_id);

-- ---------- deadlines ----------
create table if not exists comp_obligations (
  id             serial primary key,
  title          text not null,
  category       text not null default 'other' check (category in ('license','ccof','metrc','testing','report','sop','tax','insurance','other')),
  site           text,
  owner_email    text,
  due_on         date,                       -- blank = needs a date
  repeat_months  int check (repeat_months is null or repeat_months between 1 and 60),
  remind_days    int not null default 30,
  doc_type       text references comp_doc_types(key) on update cascade,
  notes          text,
  active         boolean not null default true,
  created_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create table if not exists comp_obligation_log (
  id             bigserial primary key,
  obligation_id  int not null references comp_obligations(id) on delete cascade,
  due_on         date,
  done_on        date not null default current_date,
  done_by        text,
  note           text,
  doc_id         bigint references comp_docs(id)
);
do $$
declare nxt10 date := (date_trunc('month', current_date) + interval '1 month' + interval '9 days')::date;
        eom date := (date_trunc('month', current_date) + interval '1 month' - interval '1 day')::date;
begin
  if not exists (select 1 from comp_obligations) then
    insert into comp_obligations (title, category, due_on, repeat_months, remind_days, doc_type, notes, created_by) values
      ('Monthly pesticide use report (County Ag Commissioner)', 'report', nxt10, 1, 7, 'reports',
       'Production ag pesticide use for the month, due by the 10th of the next month. Confirm the details with the Santa Cruz County Ag Commissioner.', 'setup'),
      ('METRC inventory reconciliation (all licenses)', 'metrc', eom, 1, 5, 'reports',
       'Upload each license''s METRC Active Packages export in Compliance > METRC > Reconcile and clear the differences.', 'setup'),
      ('CCOF annual update (OSP update and fees)', 'ccof', null, 12, 45, 'ccof_cert', 'Set the date from the CCOF renewal notice.', 'setup'),
      ('CCOF annual inspection', 'ccof', null, 12, 30, 'ccof_cert', 'Set the date once CCOF schedules it.', 'setup'),
      ('SOP annual review', 'sop', null, 12, 30, 'sops', 'Review every SOP and record staff sign-offs.', 'setup');
  end if;
end $$;

-- ---------- CCOF: approval on the product lists ----------
alter table input_products add column if not exists ccof_status text not null default 'unknown';
alter table input_products drop constraint if exists input_products_ccof_check;
alter table input_products add constraint input_products_ccof_check check (ccof_status in ('approved','pending','not_allowed','unknown'));
alter table input_products add column if not exists listing text;            -- OMRI / CDFA OIM / WSDA / CCOF approved / Not listed
alter table input_products add column if not exists listing_no text;
alter table input_products add column if not exists listing_expires date;
alter table input_products add column if not exists restrictions text;
alter table input_products add column if not exists ccof_notes text;
alter table input_products add column if not exists ccof_by text;
alter table input_products add column if not exists ccof_at timestamptz;
-- Compliance can read both product lists (Production's and Nursery's)
drop policy if exists comp_read on input_products;
create policy comp_read on input_products for select to authenticated using (has_module('compliance'));

-- ---------- METRC ----------
create table if not exists comp_metrc_actions (
  id         bigserial primary key,
  event_id   bigint unique,
  at         timestamptz not null default now(),
  license    text,
  action     text not null,
  pallet_id  bigint,
  code       text,
  tag        text,
  lbs        numeric,
  summary    text,
  details    jsonb,
  status     text not null default 'todo' check (status in ('todo','done','error','skipped')),
  note       text,
  done_by    text,
  done_at    timestamptz
);
create index if not exists comp_metrc_actions_open on comp_metrc_actions (status, at);

create table if not exists comp_metrc_uploads (
  id           bigserial primary key,
  license      text not null,
  file_name    text,
  rows         int not null default 0,
  uploaded_by  text,
  uploaded_at  timestamptz not null default now()
);
create table if not exists comp_metrc_packages (
  upload_id    bigint not null references comp_metrc_uploads(id) on delete cascade,
  tag          text not null,
  item         text,
  category     text,
  qty          numeric,
  uom          text,
  lbs          numeric,
  location     text,
  lab_status   text,
  on_hold      boolean not null default false,
  packaged_on  date,
  harvest      text,
  raw          jsonb,
  primary key (upload_id, tag)
);

create table if not exists comp_playbook (
  id          serial primary key,
  title       text not null,
  symptom     text,                         -- the error text or what you see
  fix         text not null,
  tags        text[] not null default '{}',
  created_by  text,
  updated_by  text,
  updated_at  timestamptz not null default now()
);
create table if not exists comp_metrc_errors (
  id            bigserial primary key,
  happened_on   date not null default current_date,
  license       text,
  tag           text,
  action        text,                       -- what you were doing
  what          text not null,              -- what happened
  error_text    text,                       -- the message METRC showed
  status        text not null default 'open' check (status in ('open','fixed')),
  assigned_to   text,
  fix           text,
  playbook_id   int references comp_playbook(id) on delete set null,
  created_by    text,
  created_at    timestamptz not null default now(),
  fixed_by      text,
  fixed_at      timestamptz
);

-- ---------- SharePoint backup runs ----------
create table if not exists comp_backup_runs (
  id           bigserial primary key,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  started_by   text,
  copied       int not null default 0,
  archived     int not null default 0,
  failed       int not null default 0,
  left_over    int not null default 0,
  error        text
);

-- ---------- testing: key numbers on the test entry (files are linked documents) ----------
alter table cult_tests add column if not exists total_thc numeric;
alter table cult_tests add column if not exists total_cannabinoids numeric;
alter table cult_tests add column if not exists moisture numeric;

-- ---------- customers: license expiry ----------
alter table customers add column if not exists license_expires date;

-- ---------- settings ----------
insert into app_settings (key, value) values
  ('comp.weight_tol', '1'), ('comp.stale_days', '90'),
  ('comp.sp_site', ''), ('comp.sp_root', 'Compliance Archive')
on conflict (key) do nothing;

-- ---------- security on the new tables (reads; all changes go through the functions below) ----------
do $$
declare t text;
begin
  foreach t in array array['comp_doc_types','comp_docs','comp_doc_links','comp_obligations','comp_obligation_log','comp_metrc_actions',
                           'comp_metrc_uploads','comp_metrc_packages','comp_playbook','comp_metrc_errors','comp_backup_runs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists comp_read on %I', t);
    execute format('create policy comp_read on %I for select to authenticated using (comp_can_read())', t);
    execute format('grant select on %I to authenticated', t);
  end loop;
end $$;

-- ---------- helpers ----------
create or replace function _comp_event(p_type text, p_note text, p_details jsonb) returns void
language sql security definer set search_path = public as $$
  insert into events (user_email, type, note, details) values (current_email(), p_type, p_note, p_details)
$$;
revoke execute on function _comp_event(text, text, jsonb) from public, anon, authenticated;

/** the license a package is under right now: its freezer's license, else the site's */
create or replace function comp_pallet_license(p_pallet bigint) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select f.license from pallets p join slots s on s.id = coalesce(p.slot_id, (select c.slot_id from pallets c where c.id = p.container_id))
       join freezers f on f.id = s.freezer_id where p.id = p_pallet),
    (select site_license(pallet_site(p)) from pallets p where p.id = p_pallet))
$$;
create or replace function comp_site_cult_license(p_site text) returns text
language sql stable security definer set search_path = public as $$
  select license_no from licenses where active and upper(site) = upper(p_site) and kind = 'cultivation' order by sort, license_no limit 1
$$;

-- ---------- documents ----------
create or replace function comp_add_doc(p jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint; old comp_docs; l jsonb; v_type text := coalesce(nullif(p ->> 'doc_type', ''), 'other');
begin
  if not comp_can_upload() then raise exception 'You can''t add documents. Ask a Compliance Admin.'; end if;
  if nullif(trim(p ->> 'title'), '') is null then raise exception 'Give the document a title'; end if;
  if nullif(p ->> 'file_path', '') is null and nullif(p ->> 'link_url', '') is null then raise exception 'Add a file or a link'; end if;
  if nullif(p ->> 'file_path', '') is not null and (p ->> 'file_path') !~ '^[a-z_]+/' then raise exception 'Bad file path'; end if;
  if not exists (select 1 from comp_doc_types where key = v_type) then raise exception 'Unknown document type %', v_type; end if;
  if nullif(p ->> 'replaces', '') is not null then
    select * into old from comp_docs where id = (p ->> 'replaces')::bigint and deleted_at is null;
    if old.id is null then raise exception 'The document being replaced wasn''t found'; end if;
  end if;
  insert into comp_docs (doc_type, title, site, license_no, crop_year, effective_on, expires_on, notes, owner_email, file_path, file_name, mime, size_bytes,
                         link_url, version, replaces_id, created_by)
  values (v_type, trim(p ->> 'title'), nullif(upper(trim(p ->> 'site')), ''), nullif(trim(p ->> 'license_no'), ''), nullif(p ->> 'crop_year', '')::int,
          nullif(p ->> 'effective_on', '')::date, nullif(p ->> 'expires_on', '')::date, nullif(trim(p ->> 'notes'), ''),
          coalesce(nullif(trim(p ->> 'owner_email'), ''), old.owner_email), nullif(p ->> 'file_path', ''), nullif(p ->> 'file_name', ''),
          nullif(p ->> 'mime', ''), nullif(p ->> 'size_bytes', '')::bigint, nullif(trim(p ->> 'link_url'), ''),
          coalesce(old.version, 0) + 1, old.id, current_email())
  returning id into v_id;
  if old.id is not null then
    update comp_docs set current = false, updated_at = now() where id = old.id;
    insert into comp_doc_links (doc_id, ref_kind, ref_id) select v_id, ref_kind, ref_id from comp_doc_links where doc_id = old.id on conflict do nothing;
  end if;
  for l in select * from jsonb_array_elements(coalesce(p -> 'links', '[]')) loop
    insert into comp_doc_links (doc_id, ref_kind, ref_id) values (v_id, l ->> 'kind', l ->> 'id') on conflict do nothing;
  end loop;
  perform _comp_event('comp_doc_added', trim(p ->> 'title'), jsonb_build_object('doc', v_id, 'type', v_type, 'version', coalesce(old.version, 0) + 1,
    'links', coalesce(p -> 'links', '[]')));
  return v_id;
end $$;

create or replace function comp_update_doc(p_id bigint, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare d comp_docs;
begin
  select * into d from comp_docs where id = p_id;
  if d.id is null then raise exception 'Document not found'; end if;
  if not (comp_can_edit() or (d.created_by = current_email() and comp_can_upload())) then raise exception 'Only Compliance or whoever added it can change this document'; end if;
  update comp_docs set
    doc_type = coalesce(nullif(p ->> 'doc_type', ''), doc_type),
    title = coalesce(nullif(trim(p ->> 'title'), ''), title),
    site = case when p ? 'site' then nullif(upper(trim(p ->> 'site')), '') else site end,
    license_no = case when p ? 'license_no' then nullif(trim(p ->> 'license_no'), '') else license_no end,
    crop_year = case when p ? 'crop_year' then nullif(p ->> 'crop_year', '')::int else crop_year end,
    effective_on = case when p ? 'effective_on' then nullif(p ->> 'effective_on', '')::date else effective_on end,
    expires_on = case when p ? 'expires_on' then nullif(p ->> 'expires_on', '')::date else expires_on end,
    notes = case when p ? 'notes' then nullif(trim(p ->> 'notes'), '') else notes end,
    owner_email = case when p ? 'owner_email' then nullif(trim(p ->> 'owner_email'), '') else owner_email end,
    link_url = case when p ? 'link_url' then nullif(trim(p ->> 'link_url'), '') else link_url end,
    -- moved to another folder: copy it again
    backed_up_at = case when coalesce(nullif(p ->> 'doc_type', ''), doc_type) <> doc_type
                          or (p ? 'site' and nullif(upper(trim(p ->> 'site')), '') is distinct from site) then null else backed_up_at end,
    updated_at = now()
  where id = p_id;
  perform _comp_event('comp_doc_updated', d.title, jsonb_build_object('doc', p_id, 'changes', p));
end $$;

create or replace function comp_delete_doc(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare d comp_docs;
begin
  select * into d from comp_docs where id = p_id;
  if d.id is null or d.deleted_at is not null then raise exception 'Document not found'; end if;
  if not (comp_can_edit() or (d.created_by = current_email() and d.created_at > now() - interval '1 day' and comp_can_upload())) then
    raise exception 'Only Compliance can remove a document (or whoever added it, the same day)';
  end if;
  update comp_docs set deleted_at = now(), deleted_by = current_email(), current = false, updated_at = now() where id = p_id;
  -- the previous version becomes the current one again
  if d.current and d.replaces_id is not null then update comp_docs set current = true, updated_at = now() where id = d.replaces_id and deleted_at is null; end if;
  perform _comp_event('comp_doc_deleted', d.title, jsonb_build_object('doc', p_id, 'type', d.doc_type));
end $$;

create or replace function comp_link_doc(p_doc bigint, p_kind text, p_ref text, p_on boolean default true) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not comp_can_upload() then raise exception 'Not allowed'; end if;
  if p_on then insert into comp_doc_links (doc_id, ref_kind, ref_id) values (p_doc, p_kind, p_ref) on conflict do nothing;
  else delete from comp_doc_links where doc_id = p_doc and ref_kind = p_kind and ref_id = p_ref; end if;
end $$;

create or replace function comp_save_doc_type(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare k text := trim(both '_' from lower(regexp_replace(trim(coalesce(nullif(p ->> 'key', ''), p ->> 'label', '')), '[^a-zA-Z0-9]+', '_', 'g')));
begin
  if not comp_is_admin() then raise exception 'Only a Compliance Admin can change document types'; end if;
  if k = '' or nullif(trim(p ->> 'label'), '') is null then raise exception 'Name the type'; end if;
  insert into comp_doc_types (key, label, folder, sort, expires, active, notes)
  values (k, trim(p ->> 'label'), coalesce(nullif(trim(p ->> 'folder'), ''), trim(p ->> 'label')), coalesce(nullif(p ->> 'sort', '')::int, 50),
          coalesce((p ->> 'expires')::boolean, false), coalesce((p ->> 'active')::boolean, true), nullif(trim(p ->> 'notes'), ''))
  on conflict (key) do update set label = excluded.label, folder = excluded.folder, sort = excluded.sort, expires = excluded.expires,
    active = excluded.active, notes = excluded.notes;
  -- folder renamed: everything of that type gets copied again into the new folder
  update comp_docs set backed_up_at = null where doc_type = k and backed_up_at is not null
     and coalesce(sp_path, '') not like '%/' || coalesce(nullif(trim(p ->> 'folder'), ''), trim(p ->> 'label')) || '/%';
  perform _comp_event('comp_setting', 'Document type ' || trim(p ->> 'label'), p);
end $$;

-- ---------- deadlines ----------
create or replace function comp_save_obligation(p jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare v_id int := nullif(p ->> 'id', '')::int;
begin
  if not comp_can_edit() then raise exception 'Only Compliance can change deadlines'; end if;
  if nullif(trim(p ->> 'title'), '') is null then raise exception 'What''s due?'; end if;
  if v_id is null then
    insert into comp_obligations (title, category, site, owner_email, due_on, repeat_months, remind_days, doc_type, notes, active, created_by)
    values (trim(p ->> 'title'), coalesce(nullif(p ->> 'category', ''), 'other'), nullif(upper(trim(p ->> 'site')), ''), nullif(trim(p ->> 'owner_email'), ''),
            nullif(p ->> 'due_on', '')::date, nullif(p ->> 'repeat_months', '')::int, coalesce(nullif(p ->> 'remind_days', '')::int, 30),
            nullif(p ->> 'doc_type', ''), nullif(trim(p ->> 'notes'), ''), coalesce((p ->> 'active')::boolean, true), current_email())
    returning id into v_id;
  else
    update comp_obligations set title = trim(p ->> 'title'), category = coalesce(nullif(p ->> 'category', ''), category),
      site = nullif(upper(trim(p ->> 'site')), ''), owner_email = nullif(trim(p ->> 'owner_email'), ''), due_on = nullif(p ->> 'due_on', '')::date,
      repeat_months = nullif(p ->> 'repeat_months', '')::int, remind_days = coalesce(nullif(p ->> 'remind_days', '')::int, remind_days),
      doc_type = nullif(p ->> 'doc_type', ''), notes = nullif(trim(p ->> 'notes'), ''), active = coalesce((p ->> 'active')::boolean, active), updated_at = now()
    where id = v_id;
  end if;
  perform _comp_event('comp_deadline_saved', trim(p ->> 'title'), jsonb_build_object('id', v_id, 'due', p ->> 'due_on'));
  return v_id;
end $$;

create or replace function comp_done_obligation(p_id int, p_done date default current_date, p_note text default null, p_doc bigint default null) returns date
language plpgsql security definer set search_path = public as $$
declare o comp_obligations; nxt date;
begin
  if not comp_can_edit() then raise exception 'Only Compliance can mark deadlines done'; end if;
  select * into o from comp_obligations where id = p_id for update;
  if o.id is null then raise exception 'Deadline not found'; end if;
  insert into comp_obligation_log (obligation_id, due_on, done_on, done_by, note, doc_id) values (o.id, o.due_on, coalesce(p_done, current_date), current_email(), nullif(trim(p_note), ''), p_doc);
  if p_doc is not null then insert into comp_doc_links (doc_id, ref_kind, ref_id) values (p_doc, 'obligation', o.id::text) on conflict do nothing; end if;
  if o.repeat_months is not null and o.due_on is not null then
    nxt := (o.due_on + make_interval(months => o.repeat_months))::date;
    while nxt <= coalesce(p_done, current_date) - 15 loop nxt := (nxt + make_interval(months => o.repeat_months))::date; end loop;
    update comp_obligations set due_on = nxt, updated_at = now() where id = o.id;
  elsif o.repeat_months is null then
    update comp_obligations set active = false, updated_at = now() where id = o.id;
  end if;
  perform _comp_event('comp_deadline_done', o.title, jsonb_build_object('id', o.id, 'due', o.due_on, 'next', nxt, 'note', p_note));
  return nxt;
end $$;

create or replace function comp_delete_obligation(p_id int) returns void
language plpgsql security definer set search_path = public as $$
declare o comp_obligations;
begin
  if not comp_is_admin() then raise exception 'Only a Compliance Admin can delete a deadline (anyone in Compliance can switch it off)'; end if;
  select * into o from comp_obligations where id = p_id;
  delete from comp_obligations where id = p_id;
  perform _comp_event('comp_deadline_deleted', o.title, jsonb_build_object('id', p_id));
end $$;

/** one list: obligations + anything with an expiry date */
create or replace function comp_deadlines() returns table (
  kind text, ref text, title text, category text, site text, due_on date, days_left int, remind_days int, owner_email text,
  repeat_months int, notes text, doc_type text)
language sql stable security definer set search_path = public as $$
  select * from (
    select 'obligation', o.id::text, o.title, o.category, o.site, o.due_on, (o.due_on - current_date)::int, o.remind_days, o.owner_email, o.repeat_months, o.notes, o.doc_type
      from comp_obligations o where o.active
    union all
    select 'doc', d.id::text, 'Renew: ' || d.title, coalesce((select case t.key when 'licenses' then 'license' when 'ccof_cert' then 'ccof' when 'insurance' then 'insurance' else 'other' end
                                                            from comp_doc_types t where t.key = d.doc_type), 'other'),
           d.site, d.expires_on, (d.expires_on - current_date)::int, 60, d.owner_email, null::int, d.notes, d.doc_type
      from comp_docs d where d.deleted_at is null and d.current and d.expires_on is not null
    union all
    select 'license', l.license_no, 'License renewal: ' || l.license_no || ' (' || coalesce(l.site, l.entity, '') || ' ' || l.kind || ')', 'license',
           l.site, l.expires, (l.expires - current_date)::int, 60, null, null::int, null, 'licenses'
      from licenses l where l.active
    union all
    select 'material', m.id::text, 'Listing expires: ' || m.name || coalesce(' (' || m.listing || ')', ''), 'ccof', null, m.listing_expires,
           (m.listing_expires - current_date)::int, 30, null, null::int, null, case when m.pesticide then 'pesticides' else 'fertilizers' end
      from input_products m where m.active and m.listing_expires is not null
    union all
    select 'customer', c.id::text, 'Customer license expires: ' || c.name || coalesce(' (' || c.license || ')', ''), 'license', null, c.license_expires,
           (c.license_expires - current_date)::int, 30, null, null::int, null, 'customers'
      from customers c where c.active and c.kind = 'external' and c.license_expires is not null
  ) x where comp_can_read()
  order by due_on nulls first
$$;

-- ---------- CCOF materials ----------
create or replace function comp_set_material(p_id int, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare m input_products;
begin
  if not comp_can_edit() then raise exception 'Only Compliance can change CCOF approval'; end if;
  select * into m from input_products where id = p_id;
  if m.id is null then raise exception 'Product not found'; end if;
  update input_products set
    ccof_status = coalesce(nullif(p ->> 'ccof_status', ''), ccof_status),
    listing = case when p ? 'listing' then nullif(trim(p ->> 'listing'), '') else listing end,
    listing_no = case when p ? 'listing_no' then nullif(trim(p ->> 'listing_no'), '') else listing_no end,
    listing_expires = case when p ? 'listing_expires' then nullif(p ->> 'listing_expires', '')::date else listing_expires end,
    restrictions = case when p ? 'restrictions' then nullif(trim(p ->> 'restrictions'), '') else restrictions end,
    ccof_notes = case when p ? 'ccof_notes' then nullif(trim(p ->> 'ccof_notes'), '') else ccof_notes end,
    epa_reg = case when p ? 'epa_reg' then nullif(trim(p ->> 'epa_reg'), '') else epa_reg end,
    ccof_by = current_email(), ccof_at = now(), updated_at = now()
  where id = p_id;
  perform _comp_event('comp_material', m.name, jsonb_build_object('id', p_id, 'module', m.module, 'from', m.ccof_status, 'changes', p));
end $$;

/** Feed / Spray logs as the application log (Production and Nursery), for the PDF and the screen */
create or replace function comp_app_log(p_from date, p_to date, p_site text default null, p_module text default null) returns table (
  id bigint, module text, kind text, site text, area text, log_on date, method text, spray_type text, water_gal numeric, acres numeric, sqft numeric,
  run_min numeric, applicator text, products jsonb, notes text, strain text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_module('compliance') or has_module('cultivation') or has_module('nursery')) then raise exception 'Not allowed'; end if;
  return query
    select l.id, l.module, l.kind, l.site, l.area, l.log_on, l.method, l.spray_type, l.water_gal, l.acres, l.sqft, l.run_min, l.applicator, l.products, l.notes, l.strain
      from ops_logs l
     where l.kind in ('feed','spray') and l.log_on between p_from and p_to
       and (p_site is null or upper(l.site) = upper(p_site)) and (p_module is null or l.module = p_module)
       and (has_module('compliance') or has_module(l.module))
     order by l.log_on, l.id;
end $$;

/** product lines in Feed / Spray logs that aren't on the approved list (or whose listing had expired) */
create or replace function comp_material_issues(p_since date default null) returns table (
  log_id bigint, module text, log_on date, site text, area text, product text, issue text, product_id int)
language sql stable security definer set search_path = public as $$
  select l.id, l.module, l.log_on, l.site, l.area, x ->> 'product',
         case when m.id is null then 'not on the product list'
              when m.ccof_status = 'not_allowed' then 'not allowed'
              when m.ccof_status = 'pending' then 'approval pending'
              when m.ccof_status = 'unknown' then 'not reviewed'
              else 'listing had expired' end, m.id
    from ops_logs l
    cross join lateral jsonb_array_elements(coalesce(l.products, '[]')) x
    left join lateral (select * from input_products m where lower(m.name) = lower(x ->> 'product') and m.module = l.module order by m.active desc limit 1) m on true
   where comp_can_read() and l.kind in ('feed','spray') and l.log_on >= coalesce(p_since, make_date(extract(year from current_date)::int, 1, 1))
     and nullif(trim(x ->> 'product'), '') is not null
     and (m.id is null or m.ccof_status <> 'approved' or (m.listing_expires is not null and m.listing_expires < l.log_on))
   order by l.log_on desc
$$;

-- ---------- METRC to-do queue (fed by the activity log from now on) ----------
create or replace function _comp_queue_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare a text; lic text; p pallets; s text;
begin
  a := case new.type
    when 'harvested' then 'Create package from harvest'
    when 'proc_wet' then 'Create wet package from harvest'
    when 'created' then 'New package entered by hand'
    when 'split_from' then 'New package (split)'
    when 'merge' then 'Combine packages'
    when 'weight_adjust' then 'Adjust package weight'
    when 'tag_set' then case when new.details ->> 'from' is null then 'Tag a pending package' else 'Change package tag' end
    when 'proc_output' then 'Create package from processing run'
    when 'proc_used' then 'Use package in processing run'
    when 'proc_run_done' then 'Record run waste / moisture loss'
    when 'proc_sent' then 'Transfer to drying processor (manifest)'
    when 'proc_received' then 'Receive back from drying processor'
    when 'shipped' then 'Ship to customer (transfer manifest)'
    when 'received' then 'Transfer between licenses'
    else null end;
  if a is null then return new; end if;
  if new.pallet_id is not null then select * into p from pallets where id = new.pallet_id; end if;
  lic := case
    when new.type in ('harvested', 'proc_wet') then coalesce(comp_site_cult_license(new.details ->> 'site'), comp_pallet_license(new.pallet_id))
    when new.pallet_id is not null then comp_pallet_license(new.pallet_id)
    else null end;
  s := concat_ws(' · ', p.code, p.strain, coalesce(new.details ->> 'run', null), coalesce(new.details ->> 'processor', null), coalesce(new.details ->> 'load', null),
                 case when new.type = 'merge' then 'from ' || (select string_agg(v, ', ') from jsonb_array_elements_text(coalesce(new.details -> 'sources', '[]')) v) end,
                 case when new.type = 'proc_run_done' then concat_ws(' ', new.details ->> 'kind', new.details ->> 'strain') end);
  insert into comp_metrc_actions (event_id, at, license, action, pallet_id, code, tag, lbs, summary, details)
  values (new.id, new.at, lic, a, new.pallet_id, p.code, coalesce(new.details ->> 'tag', new.details ->> 'to', p.package_tag), new.lbs, nullif(s, ''),
          jsonb_strip_nulls(new.details || jsonb_build_object('type', new.type, 'by', new.user_email, 'note', new.note)))
  on conflict (event_id) do nothing;
  return new;
exception when others then return new;   -- never block the real action
end $$;
drop trigger if exists comp_queue on events;
create trigger comp_queue after insert on events for each row execute function _comp_queue_event();

create or replace function comp_metrc_set(p_ids bigint[], p_status text, p_note text default null) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not (comp_can_edit() or is_mod_admin('distribution') or is_mod_admin('processing') or is_owner()) or impersonating() then
    raise exception 'Only Compliance (or a Distribution / Processing Admin) can check off METRC work';
  end if;
  if p_status not in ('todo','done','error','skipped') then raise exception 'Bad status'; end if;
  update comp_metrc_actions set status = p_status, note = coalesce(nullif(trim(p_note), ''), note),
         done_by = case when p_status = 'todo' then null else current_email() end, done_at = case when p_status = 'todo' then null else now() end
   where id = any(p_ids);
  get diagnostics n = row_count;
  perform _comp_event('comp_metrc_status', p_status, jsonb_build_object('ids', to_jsonb(p_ids), 'n', n, 'note', p_note));
  return n;
end $$;

/** METRC Active Packages CSV (rows already read in the browser) */
create or replace function comp_metrc_upload(p_license text, p_file text, p_rows jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint; n int;
begin
  if not comp_can_edit() then raise exception 'Only Compliance can upload METRC exports'; end if;
  if not exists (select 1 from licenses where license_no = p_license) then raise exception 'Unknown license %', p_license; end if;
  insert into comp_metrc_uploads (license, file_name, uploaded_by) values (p_license, p_file, current_email()) returning id into v_id;
  insert into comp_metrc_packages (upload_id, tag, item, category, qty, uom, lbs, location, lab_status, on_hold, packaged_on, harvest, raw)
  select v_id, upper(trim(r ->> 'tag')), nullif(trim(r ->> 'item'), ''), nullif(trim(r ->> 'category'), ''), nullif(r ->> 'qty', '')::numeric, nullif(trim(r ->> 'uom'), ''),
         case when lower(coalesce(r ->> 'uom', 'pounds')) ~ '^(g|gram)' then nullif(r ->> 'qty', '')::numeric / 453.59237
              when lower(coalesce(r ->> 'uom', 'pounds')) ~ '^(kg|kilo)' then nullif(r ->> 'qty', '')::numeric * 2.20462262
              when lower(coalesce(r ->> 'uom', 'pounds')) ~ '^(oz|ounce)' then nullif(r ->> 'qty', '')::numeric / 16
              when lower(coalesce(r ->> 'uom', 'pounds')) ~ '^(lb|pound)' then nullif(r ->> 'qty', '')::numeric
              else null end,
         nullif(trim(r ->> 'location'), ''), nullif(trim(r ->> 'lab_status'), ''), coalesce((r ->> 'on_hold')::boolean, false),
         nullif(r ->> 'packaged_on', '')::date, nullif(trim(r ->> 'harvest'), ''), r -> 'raw'
    from jsonb_array_elements(p_rows) r where nullif(trim(r ->> 'tag'), '') is not null
  on conflict (upload_id, tag) do nothing;
  get diagnostics n = row_count;
  update comp_metrc_uploads set rows = n where id = v_id;
  perform _comp_event('comp_metrc_upload', p_license, jsonb_build_object('upload', v_id, 'rows', n, 'file', p_file));
  return v_id;
end $$;

/** METRC export vs the app, for one upload */
create or replace function comp_reconcile(p_upload bigint) returns table (
  issue text, tag text, pallet_id bigint, code text, strain text, app_lbs numeric, metrc_lbs numeric, app_item text, metrc_item text, app_license text, note text)
language plpgsql stable security definer set search_path = public as $$
declare u comp_metrc_uploads; tol numeric; stale int;
begin
  if not comp_can_read() then raise exception 'Not allowed'; end if;
  select * into u from comp_metrc_uploads where id = p_upload;
  if u.id is null then raise exception 'Upload not found'; end if;
  tol := coalesce((select nullif(value, '')::numeric from app_settings where key = 'comp.weight_tol'), 1);
  stale := coalesce((select nullif(value, '')::int from app_settings where key = 'comp.stale_days'), 90);
  return query
  with live as (
    select p.*, comp_pallet_license(p.id) as lic from pallets p
     where p.status in ('in_freezer','unslotted') and coalesce(p.kind, '') <> 'mixed'
  ), m as (select * from comp_metrc_packages where upload_id = p_upload),
  bytag as (select distinct on (upper(p.package_tag)) p.* from pallets p join m on upper(p.package_tag) = m.tag
             order by upper(p.package_tag), (p.status in ('in_freezer','unslotted')) desc, p.id desc)
  -- in METRC, not in the app at all
  select 'not_in_app', m.tag, null::bigint, null::text, null::text, null::numeric, m.lbs, null::text, m.item, null::text, m.location
    from m where not exists (select 1 from bytag b where upper(b.package_tag) = m.tag)
  union all
  -- active in METRC, closed in the app
  select 'closed_in_app', m.tag, b.id, b.code, b.strain, b.current_weight, m.lbs, i.metrc_name, m.item, null, 'App says ' || b.status
    from m join bytag b on upper(b.package_tag) = m.tag left join items i on i.id = b.item_id
   where b.status not in ('in_freezer','unslotted','in_transit')
  union all
  -- live here, not in this license's METRC export
  select 'not_in_metrc', l.package_tag, l.id, l.code, l.strain, l.current_weight, null, i.metrc_name, null, l.lic, null
    from live l left join items i on i.id = l.item_id
   where l.lic = u.license and l.package_tag is not null and not coalesce(l.tag_pending, false)
     and not exists (select 1 from m where m.tag = upper(l.package_tag))
  union all
  -- in this export, but the app has it under another license
  select 'other_license', m.tag, l.id, l.code, l.strain, l.current_weight, m.lbs, null, m.item, l.lic, 'METRC: ' || u.license
    from m join live l on upper(l.package_tag) = m.tag where l.lic is distinct from u.license
  union all
  select 'weight', m.tag, l.id, l.code, l.strain, l.current_weight, m.lbs, null, null, l.lic, null
    from m join live l on upper(l.package_tag) = m.tag where m.lbs is not null and abs(coalesce(l.current_weight, 0) - m.lbs) > tol
  union all
  select 'item', m.tag, l.id, l.code, l.strain, null, null, i.metrc_name, m.item, l.lic, null
    from m join live l on upper(l.package_tag) = m.tag join items i on i.id = l.item_id
   where i.metrc_name is not null and m.item is not null and lower(trim(i.metrc_name)) <> lower(trim(m.item))
  union all
  select 'on_hold', m.tag, b.id, b.code, b.strain, null, m.lbs, null, m.item, null, concat_ws(' · ', case when m.on_hold then 'On hold' end, m.lab_status)
    from m left join bytag b on upper(b.package_tag) = m.tag
   where m.on_hold or coalesce(m.lab_status, '') ~* 'fail'
  union all
  select 'tag_pending', null, l.id, l.code, l.strain, l.current_weight, null, null, null, l.lic, null
    from live l where l.lic = u.license and (coalesce(l.tag_pending, false) or l.package_tag is null)
  union all
  select 'stale', l.package_tag, l.id, l.code, l.strain, l.current_weight, null, null, null, l.lic,
         'No change in ' || (current_date - coalesce((select max(e.at) from events e where e.pallet_id = l.id), l.created_at)::date) || ' days'
    from live l where l.lic = u.license
     and coalesce((select max(e.at) from events e where e.pallet_id = l.id), l.created_at) < now() - make_interval(days => stale);
end $$;

-- ---------- METRC errors and the playbook ----------
create or replace function comp_save_error(p jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint := nullif(p ->> 'id', '')::bigint; e comp_metrc_errors;
begin
  if not comp_can_upload() then raise exception 'Not allowed'; end if;
  if nullif(trim(p ->> 'what'), '') is null then raise exception 'Say what happened'; end if;
  if v_id is null then
    insert into comp_metrc_errors (happened_on, license, tag, action, what, error_text, assigned_to, created_by)
    values (coalesce(nullif(p ->> 'happened_on', '')::date, current_date), nullif(trim(p ->> 'license'), ''), nullif(upper(trim(p ->> 'tag')), ''),
            nullif(trim(p ->> 'action'), ''), trim(p ->> 'what'), nullif(trim(p ->> 'error_text'), ''), nullif(trim(p ->> 'assigned_to'), ''), current_email())
    returning id into v_id;
    perform _comp_event('comp_error', trim(p ->> 'what'), jsonb_build_object('id', v_id, 'tag', p ->> 'tag'));
  else
    select * into e from comp_metrc_errors where id = v_id;
    if not (comp_can_edit() or e.created_by = current_email()) then raise exception 'Only Compliance or whoever logged it can change this'; end if;
    update comp_metrc_errors set happened_on = coalesce(nullif(p ->> 'happened_on', '')::date, happened_on), license = nullif(trim(p ->> 'license'), ''),
      tag = nullif(upper(trim(p ->> 'tag')), ''), action = nullif(trim(p ->> 'action'), ''), what = trim(p ->> 'what'),
      error_text = nullif(trim(p ->> 'error_text'), ''), assigned_to = nullif(trim(p ->> 'assigned_to'), '') where id = v_id;
  end if;
  return v_id;
end $$;

create or replace function comp_fix_error(p_id bigint, p_fix text, p_playbook boolean default false, p_title text default null, p_reopen boolean default false) returns int
language plpgsql security definer set search_path = public as $$
declare e comp_metrc_errors; pb int;
begin
  select * into e from comp_metrc_errors where id = p_id;
  if e.id is null then raise exception 'Not found'; end if;
  if not (comp_can_edit() or e.created_by = current_email() or e.assigned_to = current_email()) or impersonating() then raise exception 'Not allowed'; end if;
  if p_reopen then
    update comp_metrc_errors set status = 'open', fixed_by = null, fixed_at = null where id = p_id;
    return null;
  end if;
  if nullif(trim(p_fix), '') is null then raise exception 'Say how it was fixed'; end if;
  pb := e.playbook_id;
  if p_playbook and pb is null then
    insert into comp_playbook (title, symptom, fix, tags, created_by, updated_by)
    values (coalesce(nullif(trim(p_title), ''), left(e.what, 80)), coalesce(e.error_text, e.what), trim(p_fix),
            array_remove(array[e.action], null), current_email(), current_email())
    returning id into pb;
  end if;
  update comp_metrc_errors set status = 'fixed', fix = trim(p_fix), fixed_by = current_email(), fixed_at = now(), playbook_id = pb where id = p_id;
  perform _comp_event('comp_error_fixed', e.what, jsonb_build_object('id', p_id, 'playbook', pb));
  return pb;
end $$;

create or replace function comp_save_playbook(p jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare v_id int := nullif(p ->> 'id', '')::int;
begin
  if not comp_can_edit() then raise exception 'Only Compliance can change the playbook'; end if;
  if (p ->> 'delete')::boolean then
    if not comp_is_admin() then raise exception 'Only a Compliance Admin can delete a playbook entry'; end if;
    delete from comp_playbook where id = v_id; return v_id;
  end if;
  if nullif(trim(p ->> 'title'), '') is null or nullif(trim(p ->> 'fix'), '') is null then raise exception 'A playbook entry needs a title and the fix'; end if;
  if v_id is null then
    insert into comp_playbook (title, symptom, fix, tags, created_by, updated_by)
    values (trim(p ->> 'title'), nullif(trim(p ->> 'symptom'), ''), trim(p ->> 'fix'),
            coalesce((select array_agg(trim(x)) from jsonb_array_elements_text(coalesce(p -> 'tags', '[]')) x where trim(x) <> ''), '{}'), current_email(), current_email())
    returning id into v_id;
  else
    update comp_playbook set title = trim(p ->> 'title'), symptom = nullif(trim(p ->> 'symptom'), ''), fix = trim(p ->> 'fix'),
      tags = coalesce((select array_agg(trim(x)) from jsonb_array_elements_text(coalesce(p -> 'tags', '[]')) x where trim(x) <> ''), '{}'),
      updated_by = current_email(), updated_at = now() where id = v_id;
  end if;
  perform _comp_event('comp_playbook', trim(p ->> 'title'), jsonb_build_object('id', v_id));
  return v_id;
end $$;

-- ---------- testing: what each package's test is ----------
/** the harvest behind a package, its pre-harvest test (+ files) and any COAs on the package itself */
create or replace function pallet_trace(p_pallet bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p pallets; h cult_harvests; t cult_tests; fname text; files jsonb; coas jsonb;
begin
  if not comp_can_read() then return null; end if;
  select * into p from pallets where id = p_pallet;
  if p.id is null then return null; end if;
  select * into h from cult_harvests where id = coalesce(p.harvest_id, p.from_harvest);
  if h.id is null and p.lot_id is not null then select * into h from cult_harvests where lot_id = p.lot_id order by harvested_on desc nulls last, id desc limit 1; end if;
  if h.id is not null then
    select name into fname from fields where id = h.field_id;
    if h.kind = 'dry' then
      select * into t from cult_tests where kind = 'strain' and harvest_id = h.id;
      if t.id is null then select * into t from cult_tests where kind = 'area' and crop_year = h.crop_year and field_id = h.field_id; end if;
    else
      select * into t from cult_tests where kind = 'area' and crop_year = h.crop_year and field_id = h.field_id;
      if t.id is null then select * into t from cult_tests where kind = 'strain' and harvest_id = h.id; end if;
    end if;
  end if;
  if t.id is not null then
    select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'file_name', d.file_name, 'file_path', d.file_path, 'link_url', d.link_url, 'mime', d.mime)
                              order by d.created_at desc), '[]') into files
      from comp_doc_links k join comp_docs d on d.id = k.doc_id
     where k.ref_kind = 'test' and k.ref_id = t.id::text and d.deleted_at is null and d.current;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'file_name', d.file_name, 'file_path', d.file_path, 'link_url', d.link_url, 'mime', d.mime)
                            order by d.created_at desc), '[]') into coas
    from comp_doc_links k join comp_docs d on d.id = k.doc_id
   where ((k.ref_kind = 'pallet' and k.ref_id = p.id::text) or (k.ref_kind = 'lot' and k.ref_id = p.lot_id::text)) and d.deleted_at is null and d.current;
  return jsonb_build_object(
    'harvest', case when h.id is null then null else jsonb_build_object('id', h.id, 'kind', h.kind, 'site', h.site, 'field', fname, 'strain', h.strain,
                    'harvested_on', h.harvested_on, 'crop_year', h.crop_year, 'metrc_name', h.metrc_name) end,
    'test', case when t.id is null then null else jsonb_build_object('id', t.id, 'kind', t.kind, 'lab', t.lab, 'test_ref', t.test_ref, 'sampled_on', t.sampled_on,
                 'results_on', t.results_on, 'result', t.result, 'total_thc', t.total_thc, 'total_cannabinoids', t.total_cannabinoids, 'moisture', t.moisture,
                 'files', coalesce(files, '[]')) end,
    'docs', coalesce(coas, '[]'));
end $$;

/** every test entry's files, for Production > Testing */
create or replace function test_files(p_year int) returns table (test_id bigint, doc_id bigint, title text, file_name text, file_path text, link_url text, mime text)
language sql stable security definer set search_path = public as $$
  select t.id, d.id, d.title, d.file_name, d.file_path, d.link_url, d.mime
    from cult_tests t join comp_doc_links k on k.ref_kind = 'test' and k.ref_id = t.id::text join comp_docs d on d.id = k.doc_id
   where comp_can_read() and t.crop_year = p_year and d.deleted_at is null and d.current
   order by d.created_at desc
$$;


/** test entries with results back but no file attached (this crop year) */
create or replace function comp_tests_no_file() returns table (id bigint, kind text, site text, ref text, results_on date, result text, lab text)
language sql stable security definer set search_path = public as $$
  select t.id, t.kind, t.site,
         case when t.kind = 'area' then coalesce(f.name, '?') else concat_ws(' · ', h.strain, f2.name) end,
         t.results_on, t.result, t.lab
    from cult_tests t
    left join fields f on f.id = t.field_id
    left join cult_harvests h on h.id = t.harvest_id
    left join fields f2 on f2.id = h.field_id
   where comp_can_read() and t.results_on is not null and t.crop_year = extract(year from current_date)::int
     and not exists (select 1 from comp_doc_links k join comp_docs d on d.id = k.doc_id where k.ref_kind = 'test' and k.ref_id = t.id::text and d.deleted_at is null)
   order by t.results_on desc
$$;

-- ---------- customers: license ----------
create or replace function comp_set_customer_license(p_customer int, p_license text, p_expires date) returns void
language plpgsql security definer set search_path = public as $$
declare c customers;
begin
  if not (comp_can_edit() or (is_sales_admin() and not impersonating())) then raise exception 'Only Compliance or a Sales Admin can change customer licenses'; end if;
  select * into c from customers where id = p_customer;
  if c.id is null then raise exception 'Customer not found'; end if;
  update customers set license = nullif(trim(p_license), ''), license_expires = p_expires, updated_at = now() where id = p_customer;
  perform _comp_event('comp_customer_license', c.name, jsonb_build_object('customer', p_customer, 'license', p_license, 'expires', p_expires));
end $$;
/** ok / missing / expired / expiring (within 30 days) / internal */
create or replace function customer_license_status(p_customer int) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when c.id is null then null
              when c.kind <> 'external' then jsonb_build_object('status', 'internal')
              else jsonb_build_object('license', c.license, 'expires', c.license_expires,
                'docs', (select count(*) from comp_doc_links k join comp_docs d on d.id = k.doc_id where k.ref_kind = 'customer' and k.ref_id = c.id::text and d.deleted_at is null and d.current),
                'status', case when nullif(trim(c.license), '') is null then 'missing'
                               when c.license_expires is null then 'no_expiry'
                               when c.license_expires < current_date then 'expired'
                               when c.license_expires < current_date + 30 then 'expiring' else 'ok' end) end
    from (select 1) one left join customers c on c.id = p_customer
   where coalesce(is_staff(), false)
$$;

create or replace function comp_customers() returns table (id int, name text, license text, license_expires date, docs bigint, last_order date, status text)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.license, c.license_expires,
         (select count(*) from comp_doc_links k join comp_docs d on d.id = k.doc_id where k.ref_kind = 'customer' and k.ref_id = c.id::text and d.deleted_at is null and d.current),
         (select max(o.created_at)::date from orders o where o.customer_id = c.id),
         case when nullif(trim(c.license), '') is null then 'missing' when c.license_expires is null then 'no_expiry'
              when c.license_expires < current_date then 'expired' when c.license_expires < current_date + 30 then 'expiring' else 'ok' end
    from customers c where c.active and c.kind = 'external' and comp_can_read()
   order by c.name
$$;

-- ---------- Compliance settings ----------
create or replace function comp_set_setting(p_key text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not comp_is_admin() then raise exception 'Only a Compliance Admin can change Compliance settings'; end if;
  if p_key not in ('comp.weight_tol', 'comp.stale_days', 'comp.sp_site', 'comp.sp_root') then raise exception 'Unknown setting'; end if;
  insert into app_settings (key, value) values (p_key, coalesce(trim(p_value), '')) on conflict (key) do update set value = excluded.value;
  if p_key in ('comp.sp_site', 'comp.sp_root') then update comp_docs set backed_up_at = null, sp_item_id = null, sp_path = null where backed_up_at is not null; end if;
  perform _comp_event('comp_setting', p_key, jsonb_build_object('key', p_key, 'value', p_value));
end $$;

create or replace function comp_set_license_expiry(p_license text, p_expires date) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not comp_can_edit() then raise exception 'Only Compliance can change license dates'; end if;
  update licenses set expires = p_expires, updated_at = now() where license_no = p_license;
  if not found then raise exception 'License % not found', p_license; end if;
  perform _comp_event('comp_license', p_license, jsonb_build_object('license', p_license, 'expires', p_expires));
end $$;

-- ---------- dashboard numbers ----------
create or replace function comp_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not has_module('compliance') then raise exception 'The Compliance module isn''t switched on for your account'; end if;
  with dl as (select * from comp_deadlines())
  select jsonb_build_object(
    'overdue', (select count(*) from dl where due_on < current_date),
    'due_soon', (select count(*) from dl where due_on >= current_date and due_on <= current_date + remind_days),
    'due_30', (select count(*) from dl where due_on between current_date and current_date + 30),
    'no_date', (select count(*) from dl where due_on is null and kind = 'obligation'),
    'docs', (select count(*) from comp_docs where deleted_at is null and current),
    'docs_by_type', (select coalesce(jsonb_object_agg(doc_type, n), '{}') from (select doc_type, count(*) n from comp_docs where deleted_at is null and current group by 1) x),
    'metrc_todo', (select count(*) from comp_metrc_actions where status = 'todo'),
    'metrc_error', (select count(*) from comp_metrc_actions where status = 'error'),
    'errors_open', (select count(*) from comp_metrc_errors where status = 'open'),
    'playbook', (select count(*) from comp_playbook),
    'materials', (select count(*) from input_products where active),
    'materials_approved', (select count(*) from input_products where active and ccof_status = 'approved'),
    'materials_unreviewed', (select count(*) from input_products where active and ccof_status in ('unknown','pending')),
    'materials_no_docs', (select count(*) from input_products m where m.active and m.ccof_status = 'approved'
                            and not exists (select 1 from comp_doc_links k join comp_docs d on d.id = k.doc_id where k.ref_kind = 'material' and k.ref_id = m.id::text and d.deleted_at is null)),
    'material_issues', (select count(*) from comp_material_issues(null)),
    'last_recon', (select coalesce(jsonb_object_agg(license, at), '{}') from (select license, max(uploaded_at) at from comp_metrc_uploads group by 1) x),
    'licenses', (select coalesce(jsonb_agg(license_no order by sort, license_no), '[]') from licenses where active and kind <> 'transport'),
    'customers_missing', (select count(*) from comp_customers() where status in ('missing','expired')),
    'tests_no_file', (select count(*) from cult_tests t where t.results_on is not null and t.crop_year = extract(year from current_date)::int
                        and not exists (select 1 from comp_doc_links k join comp_docs d on d.id = k.doc_id where k.ref_kind = 'test' and k.ref_id = t.id::text and d.deleted_at is null)),
    'backup', (select to_jsonb(b) from comp_backup_runs b order by id desc limit 1),
    'backup_waiting', (select count(*) from comp_docs where file_path is not null and ((deleted_at is null and backed_up_at is null) or (deleted_at is not null and sp_item_id is not null and not sp_archived))),
    'sp_site', (select value from app_settings where key = 'comp.sp_site'),
    'sp_root', (select value from app_settings where key = 'comp.sp_root'),
    'weight_tol', (select value from app_settings where key = 'comp.weight_tol'),
    'stale_days', (select value from app_settings where key = 'comp.stale_days')
  ) into r;
  return r;
end $$;

-- ---------- grants ----------
do $$
declare f text;
begin
  foreach f in array array['comp_pallet_license(bigint)','comp_site_cult_license(text)','comp_add_doc(jsonb)','comp_update_doc(bigint,jsonb)','comp_delete_doc(bigint)',
    'comp_link_doc(bigint,text,text,boolean)','comp_save_doc_type(jsonb)','comp_save_obligation(jsonb)','comp_done_obligation(int,date,text,bigint)',
    'comp_delete_obligation(int)','comp_deadlines()','comp_set_material(int,jsonb)','comp_app_log(date,date,text,text)','comp_material_issues(date)',
    'comp_metrc_set(bigint[],text,text)','comp_metrc_upload(text,text,jsonb)','comp_reconcile(bigint)','comp_save_error(jsonb)',
    'comp_fix_error(bigint,text,boolean,text,boolean)','comp_save_playbook(jsonb)','pallet_trace(bigint)','test_files(int)',
    'comp_set_customer_license(int,text,date)','customer_license_status(int)','comp_customers()','comp_set_setting(text,text)',
    'comp_set_license_expiry(text,date)','comp_overview()','comp_tests_no_file()'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

select (select count(*) from comp_doc_types) as doc_types, (select count(*) from comp_obligations) as deadlines,
       (select count(*) from module_access where module = 'compliance') as compliance_people, has_module('compliance') as you_have_it;
