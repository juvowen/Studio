-- Studio accounts: one row per person in public.profiles, so accounts show up
-- in the Table Editor. Supabase keeps the login itself (email, password) in
-- auth.users; these rows are made and kept up to date from there by triggers,
-- so the site never writes them.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  created_at timestamptz not null default now(),
  last_sign_in_at timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.profiles is 'Studio accounts (one per auth user), kept in step with auth.users by triggers.';

-- Each person may read only their own row. Nobody writes from the site:
-- the triggers below do it.
alter table public.profiles enable row level security;

drop policy if exists "Read own profile" on public.profiles;
create policy "Read own profile"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

-- A new account gets its row.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, created_at, last_sign_in_at)
  values (new.id, new.email, new.created_at, new.last_sign_in_at)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Signing in, or changing email, updates the row.
create or replace function public.handle_user_updated()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
     set email = new.email,
         last_sign_in_at = new.last_sign_in_at,
         updated_at = now()
   where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
  after update of email, last_sign_in_at on auth.users
  for each row execute function public.handle_user_updated();

-- Accounts made before this table existed.
insert into public.profiles (id, email, created_at, last_sign_in_at)
select id, email, created_at, last_sign_in_at
  from auth.users
on conflict (id) do nothing;
