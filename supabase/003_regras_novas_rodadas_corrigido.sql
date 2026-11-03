-- SENHA SECRETA - regras de desafio em sequência e várias rodadas por sala
-- Execute este arquivo no SQL Editor do Supabase DEPOIS dos scripts já aplicados.

-- Uma sala poderá ter várias partidas, mas somente uma ativa por vez.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.games'::regclass and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (room_id)'
  loop
    execute format('alter table public.games drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.games add column if not exists round_number integer not null default 1;
alter table public.rooms add column if not exists next_round_ready boolean not null default false;
create index if not exists games_room_round_idx on public.games(room_id, round_number desc);

-- Retorna o jogador seguinte na ordem fixa de entrada da sala.
create or replace function public.ss_next_player(p_room_id uuid, p_player_id uuid)
returns uuid as $$
  with ordered as (
    select player_id, row_number() over(order by joined_at, id) as rn,
           count(*) over() as total
    from public.room_members where room_id=p_room_id
  ), current_player as (select rn,total from ordered where player_id=p_player_id)
  select o.player_id from ordered o, current_player c
  where o.rn = case when c.rn = c.total then 1 else c.rn + 1 end
  limit 1
$$ language sql stable security definer set search_path=public,pg_temp;
revoke all on function public.ss_next_player(uuid,uuid) from public,anon;
grant execute on function public.ss_next_player(uuid,uuid) to authenticated;

-- Salva/atualiza a senha apenas quando a sala está aguardando ou preparando nova rodada.
create or replace function public.set_secret(p_room_id uuid,p_secret text)
returns jsonb as $$
declare v_room_status text; v_next_ready boolean;
begin
  if auth.uid() is null then raise exception 'Sessão não encontrada.'; end if;
  if p_secret !~ '^[0-9]{4}$' then raise exception 'A senha deve ter exatamente quatro dígitos.'; end if;
  if not exists(select 1 from public.room_members where room_id=p_room_id and player_id=auth.uid()) then raise exception 'Você não pertence à sala.'; end if;
  select status,next_round_ready into v_room_status,v_next_ready from public.rooms where id=p_room_id for update;
  if v_room_status not in ('waiting','in_progress') then raise exception 'Esta sala não está disponível.'; end if;
  if v_room_status='in_progress' and not v_next_ready then raise exception 'Aguarde o anfitrião preparar a próxima rodada.'; end if;
  if exists(select 1 from public.games where room_id=p_room_id and status='active') then raise exception 'A rodada ainda está em andamento.'; end if;
  insert into public.player_secrets(room_id,player_id,secret)
  values(p_room_id,auth.uid(),p_secret)
  on conflict(room_id,player_id) do update set secret=excluded.secret;
  update public.room_members set secret_set=true where room_id=p_room_id and player_id=auth.uid();
  return jsonb_build_object('saved',true);
end $$ language plpgsql security definer set search_path=public,pg_temp;

-- Inicia a primeira rodada ou a rodada seguinte depois de todos cadastrarem novas senhas.
create or replace function public.start_game(p_room_id uuid)
returns jsonb as $$
declare v_first uuid; v_total int; v_ready int; v_game uuid; v_round int; v_status text; v_next_ready boolean;
begin
  if auth.uid() is null then raise exception 'Sessão não encontrada.'; end if;
  perform 1 from public.rooms where id=p_room_id for update;
  select status,next_round_ready into v_status,v_next_ready from public.rooms where id=p_room_id and host_id=auth.uid();
  if not found then raise exception 'Somente o anfitrião pode iniciar a rodada.'; end if;
  if v_status='in_progress' and not v_next_ready then raise exception 'Prepare a próxima rodada antes de iniciar.'; end if;
  if v_status not in ('waiting','in_progress') then raise exception 'A sala não está disponível.'; end if;
  if exists(select 1 from public.games where room_id=p_room_id and status='active') then raise exception 'Já existe uma rodada em andamento.'; end if;
  select count(*),count(*) filter(where secret_set) into v_total,v_ready from public.room_members where room_id=p_room_id;
  if v_total<2 or v_total>4 or v_ready<>v_total then raise exception 'Todos os jogadores precisam cadastrar uma nova senha.'; end if;
  if exists(select 1 from public.room_members m left join public.player_secrets s on s.room_id=m.room_id and s.player_id=m.player_id where m.room_id=p_room_id and s.secret is null) then
    raise exception 'Há jogador sem senha cadastrada.';
  end if;
  select player_id into v_first from public.room_members where room_id=p_room_id order by joined_at,id limit 1;
  select coalesce(max(round_number),0)+1 into v_round from public.games where room_id=p_room_id;
  insert into public.games(room_id,status,current_turn_player_id,round_number,started_at)
  values(p_room_id,'active',v_first,v_round,now()) returning id into v_game;
  update public.rooms set status='in_progress',next_round_ready=false where id=p_room_id;
  return jsonb_build_object('game_id',v_game,'round_number',v_round);
end $$ language plpgsql security definer set search_path=public,pg_temp;

-- Prepara nova rodada sem remover jogadores, sala ou histórico anterior.
create or replace function public.prepare_next_round(p_room_id uuid)
returns jsonb as $$
begin
  if auth.uid() is null then raise exception 'Sessão não encontrada.'; end if;
  perform 1 from public.rooms where id=p_room_id and host_id=auth.uid() for update;
  if not found then raise exception 'Somente o anfitrião pode preparar outra rodada.'; end if;
  if exists(select 1 from public.games where room_id=p_room_id and status='active') then raise exception 'A rodada atual ainda não terminou.'; end if;
  if not exists(select 1 from public.games where room_id=p_room_id and status='finished') then raise exception 'A primeira rodada ainda não foi concluída.'; end if;
  delete from public.player_secrets where room_id=p_room_id;
  update public.room_members set secret_set=false,revealed_mask='****' where room_id=p_room_id;
  update public.rooms set status='in_progress',next_round_ready=true where id=p_room_id;
  return jsonb_build_object('ready_for_new_round',true);
end $$ language plpgsql security definer set search_path=public,pg_temp;

-- A pessoa da vez só pode desafiar automaticamente o próximo jogador da ordem.
create or replace function public.submit_guess(p_room_id uuid,p_target_player_id uuid,p_digit int)
returns jsonb as $$
declare
  g public.games; s text; mask text; pos int; actual int; outcome text;
  next_id uuid; expected_target uuid; win_id uuid;
begin
  if auth.uid() is null or p_digit not between 0 and 9 then raise exception 'Tentativa inválida.'; end if;
  select * into g from public.games where room_id=p_room_id and status='active' order by round_number desc limit 1 for update;
  if not found then raise exception 'Não há rodada ativa.'; end if;
  if g.current_turn_player_id<>auth.uid() then raise exception 'Não é sua vez.'; end if;
  if not exists(select 1 from public.room_members where room_id=p_room_id and player_id=auth.uid()) then raise exception 'Você não pertence à sala.'; end if;
  expected_target:=public.ss_next_player(p_room_id,auth.uid());
  if expected_target is null or p_target_player_id<>expected_target then raise exception 'O desafio deve seguir a ordem dos jogadores.'; end if;
  select secret into s from public.player_secrets where room_id=p_room_id and player_id=expected_target;
  select revealed_mask into mask from public.room_members where room_id=p_room_id and player_id=expected_target;
  if s is null or mask is null then raise exception 'Senha do próximo jogador não encontrada.'; end if;
  pos:=strpos(mask,'*');
  if pos=0 then raise exception 'A senha deste jogador já foi descoberta.'; end if;
  actual:=substr(s,pos,1)::int;
  if p_digit>actual then outcome:='MENOR'; elsif p_digit<actual then outcome:='MAIOR'; else outcome:='ACERTOU'; end if;
  if outcome='ACERTOU' then
    mask:=overlay(mask placing p_digit::text from pos for 1);
    update public.room_members set revealed_mask=mask where room_id=p_room_id and player_id=expected_target;
    if position('*' in mask)=0 then
      win_id:=auth.uid();
      update public.games set status='finished',winner_player_id=win_id,finished_at=now() where id=g.id;
    end if;
  end if;
  insert into public.game_attempts(game_id,player_id,target_player_id,digit_position,guessed_digit,result)
  values(g.id,auth.uid(),expected_target,pos,p_digit,outcome);
  if win_id is null then
    next_id:=public.ss_next_player(p_room_id,auth.uid());
    update public.games set current_turn_player_id=next_id where id=g.id;
  end if;
  return jsonb_build_object('result',outcome,'position',pos,'revealed_mask',mask,'finished',win_id is not null,'winner_player_id',win_id);
end $$ language plpgsql security definer set search_path=public,pg_temp;

-- Mantém sala em in_progress após a vitória; não marcar a sala como finished.
revoke all on function public.set_secret(uuid,text) from public,anon;
revoke all on function public.start_game(uuid) from public,anon;
revoke all on function public.prepare_next_round(uuid) from public,anon;
revoke all on function public.submit_guess(uuid,uuid,int) from public,anon;
grant execute on function public.set_secret(uuid,text) to authenticated;
grant execute on function public.start_game(uuid) to authenticated;
grant execute on function public.prepare_next_round(uuid) to authenticated;
grant execute on function public.submit_guess(uuid,uuid,int) to authenticated;

-- Realtime: tabelas já publicadas podem gerar duplicate_object, tratado aqui.
do $$ begin alter publication supabase_realtime add table public.rooms; exception when duplicate_object then null; end $$;
