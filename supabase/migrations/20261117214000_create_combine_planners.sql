create table public.combine_planners (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  planner jsonb not null check (
    jsonb_typeof(planner) = 'object'
    and planner ? 'tasks' and jsonb_typeof(planner -> 'tasks') = 'array'
    and planner ? 'projects' and jsonb_typeof(planner -> 'projects') = 'array'
  )
);

alter table public.combine_planners enable row level security;
revoke all on public.combine_planners from public, anon, authenticated;
grant select, insert, update on public.combine_planners to authenticated;

create policy "Read own Combine planner" on public.combine_planners
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Create own Combine planner" on public.combine_planners
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Update own Combine planner" on public.combine_planners
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
