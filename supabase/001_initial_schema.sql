-- Senha Secreta: estrutura inicial.
-- Execute no SQL Editor do projeto Supabase.
create extension if not exists pgcrypto;

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  capacity int not null check (capacity between 2 and 4),
  status text not null default 'waiting' check (status in ('waiting','playing','finished')),
  host_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.room_players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  name text not null,
  is_host boolean not null default false,
  created_at timestamptz not null default now(),
  unique(room_id, name)
);

create index if not exists room_players_room_id_idx on public.room_players(room_id);

alter table public.rooms enable row level security;
alter table public.room_players enable row level security;

-- MVP de sala de espera. Para produção, substituir escrita aberta por RPCs
-- autenticadas e validação de capacidade/host no servidor.
create policy "rooms can be read by code lookup" on public.rooms
  for select to anon, authenticated using (status = 'waiting');

create policy "anyone can create a waiting room" on public.rooms
  for insert to anon, authenticated with check (status = 'waiting' and capacity between 2 and 4);

create policy "players in waiting rooms are visible" on public.room_players
  for select to anon, authenticated using (
    exists (select 1 from public.rooms r where r.id = room_id and r.status = 'waiting')
  );

create policy "players can join waiting rooms" on public.room_players
  for insert to anon, authenticated with check (
    exists (select 1 from public.rooms r where r.id = room_id and r.status = 'waiting')
  );

alter publication supabase_realtime add table public.room_players;
