-- Run in your Supabase project's SQL Editor. No service-role key is needed by the app.
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  hobby text not null check (hobby in ('drawing', 'reading', 'journaling')),
  minutes integer not null check (minutes between 1 and 180),
  project_name text not null default '' check (length(project_name) <= 120),
  materials text not null default '' check (length(materials) <= 200),
  idea text not null default '' check (length(idea) <= 200),
  goal text not null check (length(goal) between 1 and 1200),
  note text not null default '' check (length(note) <= 2000),
  task_history jsonb not null default '[]'::jsonb check (jsonb_typeof(task_history) = 'array'),
  elapsed_seconds integer not null default 0 check (elapsed_seconds >= 0),
  goal_completed boolean not null default false,
  completed_at timestamptz,
  storage_path text check (storage_path is null or split_part(storage_path, '/', 1) = user_id::text),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.sessions add column if not exists project_name text not null default '' check (length(project_name) <= 120);
alter table public.sessions add column if not exists task_history jsonb not null default '[]'::jsonb check (jsonb_typeof(task_history) = 'array');
alter table public.sessions add column if not exists elapsed_seconds integer not null default 0 check (elapsed_seconds >= 0);
alter table public.sessions add column if not exists goal_completed boolean not null default false;
alter table public.sessions add column if not exists completed_at timestamptz;
create index if not exists sessions_user_updated_idx on public.sessions(user_id, updated_at desc);

create or replace function public.touch_session_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  if TG_OP = 'UPDATE' then
    new.created_at = old.created_at;
  end if;
  return new;
end;
$$;
drop trigger if exists touch_session_updated_at on public.sessions;
create trigger touch_session_updated_at before insert or update on public.sessions
  for each row execute function public.touch_session_updated_at();

alter table public.sessions enable row level security;
revoke all on public.sessions from anon;
grant select, insert, update, delete on public.sessions to authenticated;

drop policy if exists "Read own sessions" on public.sessions;
create policy "Read own sessions" on public.sessions for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists "Insert own sessions" on public.sessions;
create policy "Insert own sessions" on public.sessions for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists "Update own sessions" on public.sessions;
create policy "Update own sessions" on public.sessions for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "Delete own sessions" on public.sessions;
create policy "Delete own sessions" on public.sessions for delete to authenticated
  using ((select auth.uid()) = user_id);

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('progress-photos', 'progress-photos', false, 1048576,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = 1048576,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

-- Paths are <auth-user-id>/<session-id>/<random-file-name>.
-- These policies apply only to this bucket; leave other buckets' policies alone.
drop policy if exists "Read own progress photos" on storage.objects;
create policy "Read own progress photos" on storage.objects for select to authenticated
  using (bucket_id = 'progress-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "Insert own progress photos" on storage.objects;
create policy "Insert own progress photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'progress-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "Update own progress photos" on storage.objects;
create policy "Update own progress photos" on storage.objects for update to authenticated
  using (bucket_id = 'progress-photos' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'progress-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "Delete own progress photos" on storage.objects;
create policy "Delete own progress photos" on storage.objects for delete to authenticated
  using (bucket_id = 'progress-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
