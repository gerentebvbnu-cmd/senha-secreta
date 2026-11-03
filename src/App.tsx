import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, configReady } from './supabase'

type Room = { id: string; code: string; status: string; max_players: number; host_id: string; next_round_ready: boolean }
type Member = { id: string; player_id: string; nickname: string; is_host: boolean; secret_set: boolean; revealed_mask: string; joined_at: string }
type Game = { id: string; status: 'active' | 'finished'; current_turn_player_id: string; winner_player_id: string | null; round_number: number }
type Attempt = { id: number; game_id: string; player_id: string; target_player_id: string; digit_position: number; guessed_digit: number; result: 'MAIOR' | 'MENOR' | 'ACERTOU'; created_at: string }

function messageOf(error: unknown) {
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message)
  return 'Não foi possível concluir a operação.'
}

function playTurnAlert() {
  try {
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextClass) return
    const ctx = new AudioContextClass()
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    oscillator.type = 'sine'; oscillator.frequency.value = 880
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.025)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.32)
    oscillator.connect(gain); gain.connect(ctx.destination)
    oscillator.start(); oscillator.stop(ctx.currentTime + 0.34)
    oscillator.onended = () => void ctx.close()
  } catch { /* o jogo continua normalmente se o aparelho bloquear o áudio */ }
  try { if ('vibrate' in navigator) navigator.vibrate(120) } catch { /* opcional */ }
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
  const [digit, setDigit] = useState<number | null>(null)
  const [status, setStatus] = useState('Conectando ao Supabase...')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<Attempt[]>([])
  const [rounds, setRounds] = useState<Game[]>([])
  const previousTurn = useRef(false)
  const me = session?.user.id

  useEffect(() => {
    if (!configReady) { setStatus('Configure a conexão com o Supabase.'); return }
    let alive = true
    supabase.auth.getSession().then(async ({ data, error }) => {
      if (error) setStatus(error.message)
      if (data.session) { if (alive) { setSession(data.session); setStatus('Conectado.') }; return }
      const { data: auth, error: authError } = await supabase.auth.signInAnonymously()
      if (authError) setStatus(authError.message)
      else if (alive) { setSession(auth.session); setStatus('Conectado. Informe seu apelido para começar.') }
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => setSession(next))
    return () => { alive = false; listener.subscription.unsubscribe() }
  }, [])

  const refresh = useCallback(async (roomId = room?.id) => {
    if (!roomId) return
    const [r, m, g] = await Promise.all([
      supabase.from('rooms').select('id,code,status,max_players,host_id,next_round_ready').eq('id', roomId).single(),
      supabase.from('room_members').select('id,player_id,nickname,is_host,secret_set,revealed_mask,joined_at').eq('room_id', roomId).order('joined_at').order('id'),
      supabase.from('games').select('id,status,current_turn_player_id,winner_player_id,round_number').eq('room_id', roomId).order('round_number', { ascending: false })
    ])
    if (r.error) throw r.error
    if (m.error) throw m.error
    if (g.error) throw g.error
    const allRounds = (g.data || []) as Game[]
    setRoom(r.data); setMembers(m.data || []); setRounds(allRounds); setGame(allRounds[0] || null)
    if (allRounds.length) {
      const gameIds = allRounds.map(item => item.id)
      const { data: attempts, error: attemptsError } = await supabase.from('game_attempts').select('id,game_id,player_id,target_player_id,digit_position,guessed_digit,result,created_at').in('game_id', gameIds).order('created_at', { ascending: false }).limit(200)
      if (attemptsError) throw attemptsError
      setHistory((attempts || []) as Attempt[])
    } else setHistory([])
  }, [room?.id])

  useEffect(() => {
    if (!room?.id) return
    refresh(room.id).catch(e => setStatus(messageOf(e)))
    const syncRoom = () => refresh(room.id).catch(e => setStatus(messageOf(e)))
    const onVisible = () => { if (document.visibilityState === 'visible') syncRoom() }
    window.addEventListener('online', syncRoom)
    document.addEventListener('visibilitychange', onVisible)
    const channel = supabase.channel('room-' + room.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: 'id=eq.' + room.id }, syncRoom)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_members', filter: 'room_id=eq.' + room.id }, syncRoom)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: 'room_id=eq.' + room.id }, syncRoom)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_attempts' }, syncRoom)
      .subscribe()
    return () => {
      window.removeEventListener('online', syncRoom)
      document.removeEventListener('visibilitychange', onVisible)
      void supabase.removeChannel(channel)
    }
  }, [room?.id, refresh])

  async function run(action: () => Promise<void>) {
    setBusy(true); setStatus('')
    try { await action() } catch (e) { setStatus(messageOf(e)) } finally { setBusy(false) }
  }

  async function createRoom() {
    if (!nickname.trim()) throw new Error('Informe seu apelido.')
    const { data, error } = await supabase.rpc('create_room', { p_nickname: nickname.trim(), p_max_players: maxPlayers })
    if (error) throw error
    const roomId = data?.room_id as string | undefined
    if (!roomId) throw new Error('A sala foi criada, mas o Supabase não retornou o identificador.')
    await refresh(roomId); setStatus('Sala criada! Compartilhe o código com os outros jogadores.')
  }

  async function joinRoom() {
    if (!nickname.trim()) throw new Error('Informe seu apelido.')
    if (!roomCode.trim()) throw new Error('Informe o código da sala.')
    const { data, error } = await supabase.rpc('join_room', { p_code: roomCode.trim().toUpperCase(), p_nickname: nickname.trim() })
    if (error) throw error
    const roomId = data?.room_id as string | undefined
    if (!roomId) throw new Error('Você entrou, mas o Supabase não retornou o identificador da sala.')
    await refresh(roomId); setStatus('Você entrou na sala!')
  }

  async function saveSecret() {
    if (!room) return
    if (!/^\d{4}$/.test(secret)) throw new Error('A senha precisa ter exatamente quatro dígitos.')
    const { error } = await supabase.rpc('set_secret', { p_room_id: room.id, p_secret: secret })
    if (error) throw error
    setSecret(''); await refresh(); setStatus('Nova senha salva com segurança!')
  }

  async function startGame() {
    if (!room) return
    const { error } = await supabase.rpc('start_game', { p_room_id: room.id })
    if (error) throw error
    setDigit(null); await refresh(); setStatus('Rodada iniciada! Boa sorte!')
  }

  async function prepareNextRound() {
    if (!room) return
    const { error } = await supabase.rpc('prepare_next_round', { p_room_id: room.id })
    if (error) throw error
    setSecret(''); setDigit(null); await refresh(); setStatus('Sala preparada. Cada jogador deve cadastrar uma nova senha.')
  }

  const orderedMembers = members
  const myIndex = orderedMembers.findIndex(m => m.player_id === me)
  const myMember = orderedMembers[myIndex]
  const myTurn = Boolean(game?.status === 'active' && game.current_turn_player_id === me)
  const targetMember = myIndex >= 0 && orderedMembers.length > 1 ? orderedMembers[(myIndex + 1) % orderedMembers.length] : undefined
  const currentPlayer = orderedMembers.find(m => m.player_id === game?.current_turn_player_id)
  const currentIndex = orderedMembers.findIndex(m => m.player_id === game?.current_turn_player_id)
  const currentTarget = currentIndex >= 0 && orderedMembers.length > 1 ? orderedMembers[(currentIndex + 1) % orderedMembers.length] : undefined
  const preparingRound = Boolean(game?.status === 'finished' && room?.next_round_ready)
  const readyForStart = members.length === room?.max_players && members.length >= 2 && members.every(m => m.secret_set)
  const isHost = Boolean(myMember?.is_host)

  useEffect(() => {
    if (myTurn && !previousTurn.current) playTurnAlert()
    previousTurn.current = myTurn
  }, [myTurn])

  const historyByRound = useMemo(() => rounds.map(round => ({ round, attempts: history.filter(item => (item as Attempt & { game_id?: string }).game_id === round.id) })), [rounds, history])

  if (!configReady) return <main className="shell"><section className="panel"><div className="logo">SENHA <span>SECRETA</span></div><h1>Configure a conexão</h1><p>Crie o arquivo .env na pasta principal com a URL e a chave publishable do Supabase.</p></section></main>

  return <main className="shell">
    <header className="app-header"><div className="logo">🔒 SENHA <span>SECRETA</span></div><div className="online"><i /> {session ? 'Conectado' : 'Conectando'}</div></header>
    {!room ? <section className="panel home-panel">
      <p className="eyebrow">JOGO ONLINE • ATÉ 4 JOGADORES</p><h1>Descubra a senha.<br/><em>Vença a partida.</em></h1>
      <label>Seu apelido</label><input value={nickname} onChange={e => setNickname(e.target.value)} placeholder="Como quer aparecer no jogo?" maxLength={18}/>
      <div className="split create-row"><div><label>Jogadores na sala</label><select value={maxPlayers} onChange={e => setMaxPlayers(Number(e.target.value))}><option value={2}>2 jogadores</option><option value={3}>3 jogadores</option><option value={4}>4 jogadores</option></select></div><button disabled={busy || !session} onClick={() => run(createRoom)}>Criar sala</button></div>
      <div className="or">OU ENTRE EM UMA SALA</div><label>Código da sala</label><div className="split"><input value={roomCode} onChange={e => setRoomCode(e.target.value.toUpperCase())} placeholder="Digite o código" maxLength={12}/><button className="secondary" disabled={busy || !session} onClick={() => run(joinRoom)}>Entrar</button></div>
    </section> : <>
      <section className="room-bar"><div><small>SALA</small><b>{room.code}</b><button className="copy" onClick={() => navigator.clipboard?.writeText(room.code)}>Copiar</button></div><button className="new-round" disabled>↻ {game?.status === 'finished' ? 'Nova partida' : `Rodada ${game?.round_number || 1}`}</button></section>
      <section className="order-strip"><div className="order-title">Ordem de jogo</div><div className="order-list">{orderedMembers.map((m, i) => <div className={`order-player ${game?.current_turn_player_id === m.player_id && game.status === 'active' ? 'active' : ''}`} key={m.id}><span>{i + 1}</span><b>{m.nickname}{m.player_id === me ? ' (você)' : ''}</b></div>)}</div></section>
      <section className="panel progress-panel"><h2>Progresso das senhas <small>· dígitos descobertos</small></h2><div className="progress-grid">{orderedMembers.map(m => <div className={`progress-card ${m.player_id === me ? 'own-card' : ''}`} key={m.id}><div className="progress-person"><span className="avatar">{m.nickname.slice(0,1).toUpperCase()}</span><b>{m.nickname}{m.player_id === me ? ' (você)' : ''}</b></div><div className="digits">{(m.player_id === me ? '****' : m.revealed_mask || '****').split('').map((v, i) => <span className={v !== '*' ? 'revealed' : ''} key={i}>{v === '*' ? '✱' : v}</span>)}</div></div>)}</div></section>
      {(room.status === 'waiting' || preparingRound) && <section className="panel setup-panel"><h2>Jogadores ({members.length}/{room.max_players})</h2><div className="players">{members.map((m, i) => <div className="player" key={m.id}><span className="position">{i + 1}</span><span className="avatar">{m.nickname.slice(0,1).toUpperCase()}</span><div><b>{m.nickname}{m.player_id === me ? ' (você)' : ''}</b><small>{m.is_host ? 'Anfitrião' : `Desafia ${orderedMembers[i + 1]?.nickname || 'o próximo jogador'}`} · {m.secret_set ? 'Senha definida' : 'Aguardando senha'}</small></div><span className={m.secret_set ? 'ready-dot' : 'waiting-dot'} /></div>)}</div><label>Sua senha secreta (4 dígitos)</label><div className="split"><input className="secret-input" inputMode="numeric" maxLength={4} value={secret} onChange={e => setSecret(e.target.value.replace(/\D/g,'').slice(0,4))} placeholder="••••"/><button disabled={busy || secret.length !== 4} onClick={() => run(saveSecret)}>{myMember?.secret_set ? 'Atualizar senha' : 'Salvar senha'}</button></div>{myMember?.secret_set && <p className="success">Sua senha está protegida e não aparece para os outros jogadores.</p>}{isHost && <button className="wide" disabled={busy || !readyForStart} onClick={() => run(startGame)}>Iniciar partida</button>}<p className="hint">A partida começa quando todos os lugares estiverem ocupados e todos cadastrarem suas senhas.</p></section>}
      {game?.status === 'active' && <>
        <section className={`turn-banner ${myTurn ? 'my-turn' : ''}`}><span className="sound-icon">{myTurn ? '♫' : '◷'}</span><div><b>{myTurn ? 'É SUA VEZ!' : `Vez de ${currentPlayer?.nickname || 'outro jogador'}`}</b><small>{myTurn ? `Você desafia ${targetMember?.nickname || 'o próximo jogador'}.` : `${currentPlayer?.nickname || 'Jogador'} desafia ${currentTarget?.nickname || 'o próximo jogador'}.`}</small></div></section>
        <section className="panel keypad-panel"><h2>Qual número você acha?</h2><div className="number-grid">{Array.from({length:10},(_,n)=><button key={n} className={digit === n ? 'number selected' : 'number'} disabled={!myTurn || busy} onClick={() => setDigit(n)}>{n}</button>)}</div><button className="send-button" disabled={busy || !myTurn || digit === null || !targetMember} onClick={() => run(async () => { if (!room || !targetMember || digit === null) return; const { error } = await supabase.rpc('submit_guess', { p_room_id: room.id, p_target_player_id: targetMember.player_id, p_digit: digit }); if (error) throw error; setDigit(null); await refresh() })}>◎　Enviar Tentativa</button><p className="target-hint">Seu desafio automático: <b>{targetMember?.nickname || '—'}</b></p></section>
      </>}
      {game?.status === 'finished' && !preparingRound && <section className="panel winner-panel"><div className="trophy">🏆</div><h2>Fim da rodada!</h2><h1>{members.find(m => m.player_id === game.winner_player_id)?.nickname || 'Um jogador'} venceu!</h1><p>O código da sala e os jogadores foram mantidos. Preparem novas senhas para jogar novamente.</p>{isHost ? <button className="send-button" disabled={busy} onClick={() => run(prepareNextRound)}>↻　Nova Partida</button> : <p className="muted">Aguardando o anfitrião iniciar uma nova rodada.</p>}</section>}
      {rounds.length > 0 && <section className="panel history-panel"><h2>↶ Histórico das rodadas</h2>{historyByRound.map(({ round, attempts }) => <div className="round-history" key={round.id}><div className="round-history-title"><b>Rodada {round.round_number}</b><span>{round.status === 'finished' ? 'Finalizada' : 'Em andamento'}</span></div>{attempts.length === 0 ? <p className="muted">Nenhuma tentativa registrada nesta rodada.</p> : <div className="history-list">{attempts.map(a => <div className="history-row" key={a.id}><b className={`history-digit ${a.result.toLowerCase()}`}>{a.guessed_digit}</b><span className={`result ${a.result.toLowerCase()}`}>{a.result === 'ACERTOU' ? '✓ Acertou!' : a.result === 'MAIOR' ? '↑ Maior' : '↓ Menor'}</span><span className="versus">{members.find(m => m.player_id === a.player_id)?.nickname || 'Jogador'} → {members.find(m => m.player_id === a.target_player_id)?.nickname || 'Jogador'}</span></div>)}</div>}</div>)}<p className="legend"><span className="higher">↑ MAIOR</span><span className="lower">↓ MENOR</span><span className="correct">✓ ACERTOU</span></p></section>}
      <button className="textbutton" onClick={() => { setRoom(null); setMembers([]); setGame(null); setRounds([]); setHistory([]); setStatus('Você saiu da visualização da sala.') }}>Sair da sala</button>
    </>}
    {status && <div className="notice">{status}</div>}
    <footer>Senha Secreta <span>•</span> Partidas privadas entre amigos</footer>
  </main>
}
