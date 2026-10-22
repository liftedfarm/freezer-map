-- Migration 021: reserve requests as a batch (customers send many strains at once) and batch decisions
-- (Admins approve or decline several at once, and can approve a different amount than asked).
-- Run once in Supabase after 020_reserves_by_year.sql: SQL Editor > New query > paste > Run. Safe to re-run.
set client_min_messages = warning;

alter table reserve_requests add column if not exists batch_id uuid;
alter table reserve_requests add column if not exists approved_lbs numeric;
create index if not exists reserve_requests_batch_idx on reserve_requests (batch_id);

-- p_lines: [{"strain": "Banana Bonanza", "lbs": 500}, ...] = the new TOTAL reserve wanted per strain.
-- Lines that don't change anything are skipped. Every line is checked the same way as a single request;
-- if one fails, nothing is sent and the error names the strain.
create or replace function request_reserve_batch(p_lines jsonb, p_note text default null, p_year int default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare me int := my_customer(); yr int := coalesce(p_year, crop_year()); b uuid := gen_random_uuid(); l jsonb; s text; n numeric;
        cur numeric; q reserve_requests; rid int; ids int[] := '{}';
begin
  perform no_view_as();
  if me is null then raise exception 'Only a customer login can request reserve changes'; end if;
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]')) loop
    s := canonical_strain(l ->> 'strain');
    n := nullif(l ->> 'lbs', '')::numeric;
    if s is null or n is null then continue; end if;
    select lbs into cur from reserves where customer_id = me and lower(strain) = lower(s) and product = 'fresh_frozen' and crop_year = yr;
    select * into q from reserve_requests where customer_id = me and lower(strain) = lower(s) and status = 'pending' and crop_year = yr;
    -- nothing to change: same as the reserve and no open request
    if n = coalesce(cur, 0) and q.id is null then continue; end if;
    -- back to the current reserve: withdraw the open request
    if n = coalesce(cur, 0) and q.id is not null then
      update reserve_requests set status = 'cancelled', decided_by = jwt_email(), decided_at = now() where id = q.id;
      continue;
    end if;
    if q.id is not null and q.requested_lbs = n then continue; end if;
    begin
      rid := request_reserve_change(s, n, p_note, yr);
    exception when others then
      raise exception '%: %', s, sqlerrm;
    end;
    update reserve_requests set batch_id = b where reserve_requests.id = rid;
    ids := ids || rid;
  end loop;
  if cardinality(ids) = 0 then raise exception 'Nothing changed. Enter a new total for at least one strain.'; end if;
  return jsonb_build_object('batch', b, 'ids', to_jsonb(ids), 'count', cardinality(ids));
end $$;

-- p_items: [{"id": 12, "approve": true, "lbs": 400}, {"id": 13, "approve": false}]
-- lbs (optional) approves a different total than the customer asked for.
create or replace function decide_reserve_requests(p_items jsonb, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare it jsonb; q reserve_requests; b reserve_balances; amt numeric; ok int := 0; no int := 0;
begin
  perform no_view_as();
  if not is_admin() then raise exception 'Only an Admin can approve reserve changes'; end if;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
    select * into q from reserve_requests where id = (it ->> 'id')::int for update;
    if q.id is null or q.status <> 'pending' then continue; end if;
    if coalesce((it ->> 'approve')::boolean, false) then
      amt := coalesce(nullif(it ->> 'lbs', '')::numeric, q.requested_lbs);
      if amt < 0 then raise exception '%: amount can''t be negative', q.strain; end if;
      select * into b from reserve_balances where customer_id = q.customer_id and lower(strain) = lower(q.strain) and crop_year = q.crop_year;
      if amt < coalesce(b.shipped, 0) + coalesce(b.pending, 0) then
        raise exception '%: they''ve shipped or ordered % lbs, more than %', q.strain, coalesce(b.shipped, 0) + coalesce(b.pending, 0), amt;
      end if;
      perform _apply_reserve(q.customer_id, q.strain, amt, coalesce(p_note, q.note), current_email(), 'request', q.crop_year);
      update reserve_requests set status = 'approved', approved_lbs = amt, decided_by = current_email(), decided_at = now(),
             decision_note = coalesce(nullif(trim(p_note), ''), case when amt <> q.requested_lbs then 'Approved at ' || amt || ' lbs' end)
       where id = q.id;
      ok := ok + 1;
    else
      update reserve_requests set status = 'declined', decided_by = current_email(), decided_at = now(), decision_note = nullif(trim(p_note), '')
       where id = q.id;
      no := no + 1;
    end if;
    insert into events (user_email, type, note, details)
    values (current_email(), case when coalesce((it ->> 'approve')::boolean, false) then 'reserve_approved' else 'reserve_declined' end, p_note,
            jsonb_build_object('customer_id', q.customer_id, 'customer', (select name from customers where id = q.customer_id),
                               'strain', q.strain, 'from', q.current_lbs, 'to', case when coalesce((it ->> 'approve')::boolean, false) then amt else q.requested_lbs end,
                               'asked', q.requested_lbs, 'request_id', q.id, 'crop_year', q.crop_year));
  end loop;
  return jsonb_build_object('approved', ok, 'declined', no);
end $$;

-- one email per batch: the details of every line in it
create or replace function request_notification(p_id int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare q reserve_requests; lines jsonb;
begin
  select * into q from reserve_requests where id = p_id and requested_by = jwt_email() and customer_id = my_customer();
  if q.id is null or q.notified_at is not null then return null; end if;
  if q.batch_id is not null then
    select jsonb_agg(jsonb_build_object('strain', r.strain, 'from', r.current_lbs, 'to', r.requested_lbs) order by r.strain) into lines
      from reserve_requests r where r.batch_id = q.batch_id;
    update reserve_requests set notified_at = now() where batch_id = q.batch_id;
  else
    update reserve_requests set notified_at = now() where id = q.id;
  end if;
  return jsonb_build_object('customer', (select name from customers where id = q.customer_id), 'strain', q.strain,
    'from', q.current_lbs, 'to', q.requested_lbs, 'note', q.note, 'by', q.requested_by, 'crop_year', q.crop_year, 'lines', lines,
    'by_name', (select display_name from app_users where email = q.requested_by),
    'admins', (select jsonb_agg(email) from app_users where role = 'admin'));
end $$;

revoke execute on function request_reserve_batch(jsonb, text, int), decide_reserve_requests(jsonb, text) from public, anon;
grant execute on function request_reserve_batch(jsonb, text, int), decide_reserve_requests(jsonb, text) to authenticated;

select 'ok' as reserve_batches;
