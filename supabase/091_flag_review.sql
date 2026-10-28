-- 091: flag a pallet for review by hand (the reason shows on the pallet and in Review), from the pallet sheet. Run after 090.
create or replace function flag_review(p_pallet_id bigint, p_reason text) returns pallets
language plpgsql security definer set search_path = public as $$
declare p pallets; v text := nullif(trim(p_reason), '');
begin
  perform require_staff();
  if v is null then raise exception 'Say why it needs review'; end if;
  select * into p from pallets where id = p_pallet_id for update;
  if not found then raise exception 'Pallet not found'; end if;
  insert into events(user_email, type, pallet_id, note, details)
  values (current_email(), 'review_flagged', p.id, v, jsonb_build_object('was', p.needs_review));
  update pallets set needs_review = v, updated_at = now() where id = p.id returning * into p;
  return p;
end $$;
revoke all on function flag_review(bigint, text) from public, anon;
grant execute on function flag_review(bigint, text) to authenticated;
select 'ok' as flag_review;
