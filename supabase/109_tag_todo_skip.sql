-- 109: no extra "Tag a pending package" to-do when a split / combine / new package piece gets its tag.
-- The piece's own to-do (New package (split), Combine, New package) makes the package in METRC with that tag, so the
-- separate tag to-do was always left over (12 of them cleared by hand on 10/28). Now, when the tag is set while that
-- to-do is still open, the tag to-do is closed right away ("Not needed"). A real retag of a package that's already in
-- METRC still makes a tag to-do as before.
-- Run once in Supabase after 108. Safe to re-run.
begin;

create or replace function metrc_tag_todo_skip() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'tag' and new.status = 'todo' and new.pallet_id is not null
     and exists (select 1 from comp_metrc_actions a
                  where a.pallet_id = new.pallet_id and a.kind in ('split', 'combine', 'new_package') and a.status in ('todo', 'error')) then
    new.status := 'done';
    new.note := 'Not needed: the new package is made in METRC with this tag';
    new.done_by := 'auto';
    new.done_at := now();
  end if;
  return new;
end $$;

drop trigger if exists metrc_tag_todo_skip on comp_metrc_actions;
create trigger metrc_tag_todo_skip before insert on comp_metrc_actions for each row execute function metrc_tag_todo_skip();

commit;

select count(*) filter (where tgname = 'metrc_tag_todo_skip') as trigger_added from pg_trigger;
