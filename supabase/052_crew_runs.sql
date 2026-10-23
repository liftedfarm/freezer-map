-- Migration 052: crew days are logged inside a run. Every new piece work entry needs a bucking or trimming run.
-- Days already logged by strain (FL25 and earlier) stay as they are and can still be corrected or removed.
-- Run after 051. Safe to run twice.

do $$
declare d text;
begin
  select pg_get_functiondef('piece_save_day(date,text,bigint,text,text,jsonb)'::regprocedure) into d;
  if position('needs_run' in d) = 0 then
    if position('  if p_run is not null then' in d) = 0 then raise exception 'piece_save_day: patch point not found'; end if;
    d := replace(d, '  if p_run is not null then',
'  -- needs_run (052): new work is logged inside a run; old strain-only days can still be fixed
  if p_run is null and exists (select 1 from jsonb_array_elements(coalesce(p_rows, ''[]'')) jr
                                where nullif(jr ->> ''id'', '''') is null and not coalesce((jr ->> ''delete'')::boolean, false)
                                  and nullif(jr ->> ''employee_id'', '''') is not null) then
    raise exception ''Log the day inside a run. Start a bucking or trimming run first.'';
  end if;
  if p_run is not null then');
    d := replace(d, 'if r.id is null then raise exception ''Run not found''; end if;',
                    'if r.id is null then raise exception ''Run not found''; end if;
    if r.status = ''cancelled'' then raise exception ''% was cancelled'', r.code; end if;');
    execute d;
  end if;
end $$;

notify pgrst, 'reload schema';
