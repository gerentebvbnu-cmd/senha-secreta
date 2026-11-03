import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, configReady } from './supabase'

type Room = { id: string; code: string; status: string; max_players: number; host_id: string }
type Member = { id: string; player_id: string; nickname: string; is_host: boolean; secret_set: boolean; revealed_mask: string }
type Game = { id: string; status: string; current_turn_player_id: string; winner_player_id: string | null }

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'Não foi possível concluir a operação.'
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [nickname, setNickname] = useState('')
  const [maxPlayers, setMaxPlayers] = useState(2)
  const [roomCode, setRoomCode] = useState('')
  const [room, setRoom] = useState<Room | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [game, setGame] = useState<Game | null>(null)
  const [secret, setSecret] = useState('')
  const [target, setTarget] = useState('')
  const [digit, setDigit] = useState('0')
  const [status, setStatus] = useState('Conectando ao Supabase...')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<any[]>([])
  const me = session?.user.id

  useEffect(() => {
    if (!configReady) { setStatus('Configure o arquivo .env antes de iniciar.'); return }
    let alive = true
    supabase.auth.getSession().then(async ({ data, error }) => {
      if (error) setStatus(error.message)
      if (data.session) { if (alive) setSession(data.session); return }
      const { data: auth, error: authError } = await supabase.auth.signInAnonymously()
      if (authError) setStatus(authError.message)
      else if (alive) { setSession(auth.session); setStatus('Conectado. Informe seu apelido para começar.') }
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => setSession(next))
    return () => { alive = false; listener.subscription.unsubscribe() }
  }, [])

  async function refresh(roomId = room?.id) {
    if (!roomId) return
    const [r, m, g] = await Promise.all([
      supabase.from('rooms').select('id,code,status,max_players,host_id').eq('id', roomId).single(),
      supabase.from('room_members').select('id,player_id,nickname,is_host,secret_set,revealed_mask').eq('room_id', roomId).order('joined_at'),
      supabase.from('games').select('id,status,current_turn_player_id,winner_player_id').eq('room_id', roomId).maybeSingle()
    ])
    if (r.error) throw r.error
    if (m.error) throw m.error
    setRoom(r.data); setMembers(m.data || []); setGame(g.data)
    if (g.data) {
      const { data: attempts } = await supabase.from('game_attempts').select('id,player_id,target_player_id,digit_position,guessed_digit,result,created_at').eq('game_id', g.data.id).order('created_at', { ascending: false }).limit(30)
      setHistory(attempts || [])
    }
  }

  useEffect(() => {
    if (!room?.id) return
    refresh(room.id).catch(e => setStatus(messageOf(e)))
    const channel = supabase.channel('room-' + room.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: 'id=eq.' + room.id }, () => refresh(room.id).catch(e => setStatus(messageOf(e))))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_members', filter: 'room_id=eq.' + room.id }, () => refresh(room.id).catch(e => setStatus(messageOf(e))))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: 'room_id=eq.' + room.id }, () => refresh(room.id).catch(e => setStatus(messageOf(e))))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_attempts' }, () => refresh(room.id).catch(e => setStatus(messageOf(e))))
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [room?.id])

  async function run(action: () => Promise<void>) {
    setBusy(true); setStatus('')
    try { await action() } catch (e) { setStatus(messageOf(e)) } finally { setBusy(false) }
  }

  async function createRoom() {
    if (!nickname.trim()) throw new Error('Informe seu apelido.')
    const { error } = await supabase.rpc('create_room', { p_nickname: nickname.trim(), p_max_players: maxPlayers })
    if (error) throw error
    // The room is found through membership; this avoids depending on the RPC return shape.
    const { data: mine, error: findError } = await supabase.from('room_members').select('room_id').eq('player_id', me!).eq('is_host', true).order('joined_at', { ascending: false }).limit(1).maybeSingle()
    if (findError) throw findError
    if (!mine?.room_id) throw new Error('Sala criada, mas não consegui localizar sua sala. Confira a política de leitura de room_members.')
    await refresh(mine.room_id)
    setStatus('Sala criada! Compartilhe o código com os outros jogadores.')
  }

  async function joinRoom() {
    if (!nickname.trim()) throw new Error('Informe seu apelido.')
    if (!roomCode.trim()) throw new Error('Informe o código da sala.')
    const { error } = await supabase.rpc('join_room', { p_code: roomCode.trim().toUpperCase(), p_nickname: nickname.trim() })
    if (error) throw error
    const { data: member, error: findError } = await supabase.from('room_members').select('room_id').eq('player_id', me!).order('joined_at', { ascending: false }).limit(1).maybeSingle()
    if (findError) throw findError
    if (!member?.room_id) throw new Error('Entrada registrada, mas não consegui localizar a sala.')
    await refresh(member.room_id)
    setStatus('Você entrou na sala!')
  }

  async function saveSecret() {
    if (!room) return
    if (!/^[0-9]{4}$/.test(secret)) throw new Error('A senha precisa ter exatamente quatro dígitos.')
    const { error } = await supabase.rpc('set_secret', { p_room_id: room.id, p_secret: secret })
    if (error) throw error
    setSecret(''); await refresh()
    setStatus('Senha secreta salva!')
  }

  async function startGame() {
    if (!room) return
    const { error } = await supabase.rpc('start_game', { p_room_id: room.id })
    if (error) throw error
    await refresh()
  }

  async function submitGuess() {
    if (!room || !target) throw new Error('Escolha quem será desafiado.')
    const { error } = await supabase.rpc('submit_guess', { p_room_id: room.id, p_target_player_id: target, p_digit: Number(digit) })
    if (error) throw error
    await refresh()
  }

  const myMember = members.find(m => m.player_id === me)
  const myTurn = Boolean(game && game.current_turn_player_id === me && game.status === 'active')

  if (!configReady) return <main className="shell"><section className="panel"><div className="logo">SENHA<span>SECRETA</span></div><h1>Configure a conexão</h1><p>Crie um arquivo chamado <b>.env</b> na pasta principal e preencha a URL e a chave publishable do seu projeto Supabase. Veja o passo a passo no README incluído no pacote.</p></section></main>

  return <main className="shell">
    <header><div className="logo">SENHA<span>SECRETA</span></div><div className="online"><i /> {session ? 'Conectado' : 'Conectando'}</div></header>
    {!room ? <section className="panel">
      <p className="eyebrow">JOGO ONLINE • 2 A 4 JOGADORES</p><h1>Descubra a senha.<br/><em>Vença a partida.</em></h1>
      <label>Seu apelido</label><input value={nickname} onChange={e => setNickname(e.target.value)} placeholder="Como quer aparecer no jogo?" maxLength={18}/>
      <div className="split">
        <div><label>Jogadores na sala</label><select value={maxPlayers} onChange={e => setMaxPlayers(Number(e.target.value))}><option value={2}>2 jogadores</option><option value={3}>3 jogadores</option><option value={4}>4 jogadores</option></select></div>
        <button disabled={busy || !session} onClick={() => run(createRoom)}>Criar sala</button>
      </div>
      <div className="or">OU ENTRE EM UMA SALA</div>
      <label>Código da sala</label><div className="split"><input value={roomCode} onChange={e => setRoomCode(e.target.value.toUpperCase())} placeholder="Digite o código" maxLength={12}/><button className="secondary" disabled={busy || !session} onClick={() => run(joinRoom)}>Entrar</button></div>
    </section> : <section className="panel">
      <div className="roomtop"><div><p className="eyebrow">SUA SALA</p><h1 className="code">{room.code}</h1></div><button className="secondary small" onClick={() => navigator.clipboard?.writeText(room.code)}>Copiar código</button></div>
      <p className="muted">Compartilhe este código para convidar jogadores.</p>
      <h2>Jogadores <small>{members.length}/{room.max_players}</small></h2>
      <div className="players">{members.map((m, i) => <div className="player" key={m.id}><span className="avatar">{m.nickname.slice(0,1).toUpperCase()}</span><div><b>{m.nickname} {m.player_id === me ? '(você)' : ''}</b><small>{m.is_host ? 'Anfitrião' : 'Jogador'} · {m.secret_set ? 'Senha definida' : 'Aguardando senha'}</small></div>{m.is_host && <span className="crown">★</span>}</div>)}</div>
      {room.status === 'waiting' && <>
        <label>Sua senha secreta (4 dígitos)</label><div className="split"><input className="secret" inputMode="numeric" maxLength={4} value={secret} onChange={e => setSecret(e.target.value.replace(/\D/g,'').slice(0,4))} placeholder="••••"/><button disabled={busy || secret.length !== 4} onClick={() => run(saveSecret)}>Salvar senha</button></div>
        {myMember?.secret_set && <p className="success">Sua senha foi salva. Ela não fica visível aos outros jogadores.</p>}
        {myMember?.is_host && <button className="wide" disabled={busy || members.length < 2 || members.length !== room.max_players || members.some(m => !m.secret_set)} onClick={() => run(startGame)}>Iniciar partida</button>}
        <p className="hint">O anfitrião poderá iniciar quando todos os lugares estiverem ocupados e todos tiverem definido suas senhas.</p>
      </>}
      {game?.status === 'active' && <>
        <div className="turn">{myTurn ? 'É sua vez!' : 'Aguardando sua vez'}<small>{members.find(m => m.player_id === game.current_turn_player_id)?.nickname || 'Jogador'} está jogando</small></div>
        <h2>Desafiar jogador</h2>
        <select value={target} onChange={e => setTarget(e.target.value)}><option value="">Selecione um adversário</option>{members.filter(m => m.player_id !== me && m.revealed_mask !== '****').map(m => <option value={m.player_id} key={m.player_id}>{m.nickname} · {m.revealed_mask}</option>)}</select>
        <label>Qual é o dígito?</label><div className="split"><select value={digit} onChange={e => setDigit(e.target.value)}>{Array.from({length:10},(_,i)=><option key={i} value={i}>{i}</option>)}</select><button disabled={busy || !myTurn || !target} onClick={() => run(submitGuess)}>Enviar tentativa</button></div>
        <h2>Histórico</h2>{history.map(a=><div className="attempt" key={a.id}><span>{members.find(m=>m.player_id===a.player_id)?.nickname || 'Jogador'} → {members.find(m=>m.player_id===a.target_player_id)?.nickname || 'Adversário'}</span><b>{a.guessed_digit}: {a.result}</b></div>)}
      </>}
      {game?.status === 'finished' && <div className="winner">🏆 Vitória de {members.find(m => m.player_id === game.winner_player_id)?.nickname || 'um jogador'}!</div>}
      <button className="textbutton" onClick={() => { setRoom(null); setMembers([]); setGame(null); setHistory([]); setStatus('Você saiu da visualização da sala.') }}>Voltar à tela inicial</button>
    </section>}
    {status && <div className="notice">{status}</div>}
    <footer>Senha Secreta <span>•</span> Partidas privadas entre amigos</footer>
  </main>
}
