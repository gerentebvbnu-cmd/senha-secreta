-- Migração compatível com a estrutura 001_initial_schema.sql já executada.
-- Não apaga as tabelas antigas nem as salas existentes.
create extension if not exists pgcrypto;

alter table public.rooms add column if not exists host_id uuid;
alter table public.rooms add column if not exists max_players int;
update public.rooms set max_players=capacity where max_players is null;
update public.rooms set host_id=(select rp.id from public.room_players rp where rp.room_id=rooms.id and rp.is_host limit 1) where host_id is null;
alter table public.rooms alter column max_players set default 2;
alter table public.rooms alter column max_players set not null;

create table if not exists public.room_members (
 id uuid primary key default gen_random_uuid(),
 room_id uuid not null references public.rooms(id) on delete cascade,
 player_id uuid not null,
 nickname text not null,
 is_host boolean not null default false,
 secret_set boolean not null default false,
 revealed_mask text not null default '****' check (revealed_mask ~ '^[0-9*]{4}$'),
 joined_at timestamptz not null default now(),
 unique(room_id,player_id)
);
create table if not exists public.player_secrets (
 room_id uuid not null references public.rooms(id) on delete cascade,
 player_id uuid not null,
 secret text not null check(secret ~ '^[0-9]{4}$'),
 primary key(room_id,player_id)
);
create table if not exists public.games (
 id uuid primary key default gen_random_uuid(),
 room_id uuid not null unique references public.rooms(id) on delete cascade,
 status text not null default 'active' check(status in ('active','finished')),
 current_turn_player_id uuid not null,
 winner_player_id uuid,
 created_at timestamptz not null default now()
);
create table if not exists public.game_attempts (
 id uuid primary key default gen_random_uuid(),
 game_id uuid not null references public.games(id) on delete cascade,
 player_id uuid not null,
 target_player_id uuid not null,
 guessed_digit int not null check(guessed_digit between 0 and 9),
 position int not null check(position between 1 and 4),
 result text not null check(result in ('MAIOR','MENOR','ACERTOU')),
 created_at timestamptz not null default now()
);
create index if not exists ss_members_room_idx on public.room_members(room_id,joined_at);
create index if not exists ss_attempts_game_idx on public.game_attempts(game_id,created_at);

alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.player_secrets enable row level security;
alter table public.games enable row level security;
alter table public.game_attempts enable row level security;
create or replace function public.ss_is_member(p_room_id uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.room_members m where m.room_id=p_room_id and m.player_id=auth.uid())
$$;
revoke all on function public.ss_is_member(uuid) from public,anon;
grant execute on function public.ss_is_member(uuid) to authenticated;
drop policy if exists ss_rooms_read on public.rooms;
create policy ss_rooms_read on public.rooms for select to authenticated using (public.ss_is_member(id));
drop policy if exists ss_members_read on public.room_members;
create policy ss_members_read on public.room_members for select to authenticated using (public.ss_is_member(room_id));
drop policy if exists ss_games_read on public.games;
create policy ss_games_read on public.games for select to authenticated using
 (public.ss_is_member(games.room_id));
drop policy if exists ss_attempts_read on public.game_attempts;
create policy ss_attempts_read on public.game_attempts for select to authenticated using
 (exists(select 1 from public.games g where g.id=game_attempts.game_id and public.ss_is_member(g.room_id))); 
revoke all on public.player_secrets from anon,authenticated;
revoke insert,update,delete on public.rooms,public.room_members,public.games,public.game_attempts from anon,authenticated;

create or replace function public.create_room(p_nickname text,p_max_players int)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid; v_code text;
begin
 if auth.uid() is null then raise exception 'Sessão não encontrada.'; end if;
 if trim(coalesce(p_nickname,''))='' or length(trim(p_nickname))>30 then raise exception 'Apelido inválido.'; end if;
 if p_max_players not between 2 and 4 then raise exception 'Escolha de 2 a 4 jogadores.'; end if;
 loop v_code:=upper(substr(encode(gen_random_bytes(5),'hex'),1,8)); exit when not exists(select 1 from rooms where code=v_code); end loop;
 insert into rooms(code,capacity,max_players,status,host_name,host_id) values(v_code,p_max_players,p_max_players,'waiting',trim(p_nickname),auth.uid()) returning id into v_id;
 insert into room_members(room_id,player_id,nickname,is_host) values(v_id,auth.uid(),trim(p_nickname),true);
 return jsonb_build_object('room_id',v_id,'code',v_code);
end $$;

create or replace function public.join_room(p_code text,p_nickname text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r rooms;
begin
 if auth.uid() is null then raise exception 'Sessão não encontrada.'; end if;
 select * into r from rooms where code=upper(trim(p_code)) for update;
 if not found or r.status<>'waiting' then raise exception 'Sala não encontrada ou partida iniciada.'; end if;
 if exists(select 1 from room_members where room_id=r.id and player_id=auth.uid()) then return jsonb_build_object('room_id',r.id); end if;
 if (select count(*) from room_members where room_id=r.id)>=r.max_players then raise exception 'Sala cheia.'; end if;
 insert into room_members(room_id,player_id,nickname) values(r.id,auth.uid(),trim(p_nickname));
 return jsonb_build_object('room_id',r.id);
end $$;

create or replace function public.set_secret(p_room_id uuid,p_secret text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is null or p_secret !~ '^[0-9]{4}$' then raise exception 'A senha deve ter exatamente 4 dígitos.'; end if;
 if not exists(select 1 from room_members where room_id=p_room_id and player_id=auth.uid()) then raise exception 'Você não pertence à sala.'; end if;
 if (select status from rooms where id=p_room_id)<>'waiting' then raise exception 'A partida já começou.'; end if;
 insert into player_secrets(room_id,player_id,secret) values(p_room_id,auth.uid(),p_secret) on conflict(room_id,player_id) do update set secret=excluded.secret;
 update room_members set secret_set=true where room_id=p_room_id and player_id=auth.uid();
 return jsonb_build_object('saved',true);
end $$;

create or replace function public.start_game(p_room_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_first uuid; v_total int; v_ready int; v_game uuid;
begin
 perform 1 from rooms where id=p_room_id for update;
 if not exists(select 1 from rooms where id=p_room_id and host_id=auth.uid() and status='waiting') then raise exception 'Somente o anfitrião pode iniciar.'; end if;
 select count(*),count(*) filter(where secret_set) into v_total,v_ready from room_members where room_id=p_room_id;
 if v_total<2 or v_ready<>v_total then raise exception 'Todos precisam entrar e cadastrar a senha.'; end if;
 select player_id into v_first from room_members where room_id=p_room_id order by joined_at limit 1;
 insert into games(room_id,current_turn_player_id) values(p_room_id,v_first) returning id into v_game;
 update rooms set status='playing' where id=p_room_id;
 return jsonb_build_object('game_id',v_game);
end $$;

create or replace function public.submit_guess(p_room_id uuid,p_target_player_id uuid,p_digit int)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare g games; s text; mask text; pos int; actual int; outcome text; next_id uuid; win_id uuid;
begin
 if auth.uid() is null or p_digit not between 0 and 9 then raise exception 'Tentativa inválida.'; end if;
 select * into g from games where room_id=p_room_id for update;
 if not found or g.status<>'active' then raise exception 'Partida encerrada.'; end if;
 if g.current_turn_player_id<>auth.uid() then raise exception 'Não é sua vez.'; end if;
 if p_target_player_id=auth.uid() or not exists(select 1 from room_members where room_id=p_room_id and player_id=p_target_player_id) then raise exception 'Adversário inválido.'; end if;
 select secret into s from player_secrets where room_id=p_room_id and player_id=p_target_player_id;
 select revealed_mask into mask from room_members where room_id=p_room_id and player_id=p_target_player_id;
 pos:=strpos(mask,'*'); if pos=0 then raise exception 'Senha já descoberta.'; end if;
 actual:=substr(s,pos,1)::int;
 if p_digit>actual then outcome:='MENOR'; elsif p_digit<actual then outcome:='MAIOR'; else outcome:='ACERTOU'; end if;
 if outcome='ACERTOU' then mask:=overlay(mask placing p_digit::text from pos for 1); update room_members set revealed_mask=mask where room_id=p_room_id and player_id=p_target_player_id;
   if position('*' in mask)=0 then win_id:=auth.uid(); update games set status='finished',winner_player_id=win_id where id=g.id; update rooms set status='finished' where id=p_room_id; end if;
 end if;
 insert into game_attempts(game_id,player_id,target_player_id,guessed_digit,position,result) values(g.id,auth.uid(),p_target_player_id,p_digit,pos,outcome);
 if win_id is null then
   select player_id into next_id from room_members where room_id=p_room_id and joined_at>(select joined_at from room_members where room_id=p_room_id and player_id=auth.uid()) order by joined_at limit 1;
   if next_id is null then select player_id into next_id from room_members where room_id=p_room_id order by joined_at limit 1; end if;
   update games set current_turn_player_id=next_id where id=g.id;
 end if;
 return jsonb_build_object('result',outcome,'position',pos,'revealed_mask',mask,'finished',win_id is not null,'winner_player_id',win_id);
end $$;

grant execute on function public.create_room(text,int) to authenticated;
grant execute on function public.join_room(text,text) to authenticated;
grant execute on function public.set_secret(uuid,text) to authenticated;
grant execute on function public.start_game(uuid) to authenticated;
grant execute on function public.submit_guess(uuid,uuid,int) to authenticated;

do $$ begin alter publication supabase_realtime add table public.room_members; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.games; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.game_attempts; exception when duplicate_object then null; end $$;
-- Remove policies abertas do MVP anterior; escrita passa somente pelas RPCs.
drop policy if exists "anyone can create a waiting room" on public.rooms;
drop policy if exists "rooms can be read by code lookup" on public.rooms;
