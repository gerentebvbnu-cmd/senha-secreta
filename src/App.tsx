
import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, configReady } from './supabase'

type Room = {
  id: string
  code: string
  status: string
  max_players: number
  host_id: string
}

type Member = {
  id: string
  player_id: string
  nickname: string
  is_host: boolean
  secret_set: boolean
  revealed_mask: string
}

type Game = {
  id: string
  status: string
  current_turn_player_id: string
  winner_player_id: string | null
}

type Attempt = {
  id: number
  player_id: string
  target_player_id: string
  digit_position: number
  guessed_digit: number
  result: string
  created_at: string
}

function messageOf(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'Não foi possível concluir a operação.'
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
  const [history, setHistory] = useState<Attempt[]>([])

  const me = session?.user.id

  useEffect(() => {
    if (!configReady) {
      setStatus('Configure o arquivo .env antes de iniciar.')
      return
    }

    let alive = true

    async function initialize() {
      const { data, error } = await supabase.auth.getSession()

      if (error) {
        if (alive) setStatus(error.message)
        return
      }

      if (data.session) {
        if (alive) {
          setSession(data.session)
          setStatus('Conectado!')
        }
        return
      }

      const { data: auth, error: authError } =
        await supabase.auth.signInAnonymously()

      if (authError) {
        if (alive) setStatus(authError.message)
      } else if (alive) {
        setSession(auth.session)
        setStatus('Conectado. Informe seu apelido para começar.')
      }
    }

    initialize().catch(error => {
      if (alive) setStatus(messageOf(error))
    })

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, next) => setSession(next)
    )

    return () => {
      alive = false
      listener.subscription.unsubscribe()
    }
  }, [])

  async function refresh(roomId = room?.id) {
    if (!roomId) return

    const [r, m, g] = await Promise.all([
      supabase
        .from('rooms')
        .select('id,code,status,max_players,host_id')
        .eq('id', roomId)
        .single(),

      supabase
        .from('room_members')
        .select('id,player_id,nickname,is_host,secret_set,revealed_mask')
        .eq('room_id', roomId)
        .order('joined_at'),

      supabase
        .from('games')
        .select('id,status,current_turn_player_id,winner_player_id')
        .eq('room_id', roomId)
        .maybeSingle()
    ])

    if (r.error) throw r.error
    if (m.error) throw m.error
    if (g.error) throw g.error

    setRoom(r.data)
    setMembers(m.data || [])
    setGame(g.data)

    if (g.data) {
      const { data: attempts, error } = await supabase
        .from('game_attempts')
        .select(
          'id,player_id,target_player_id,digit_position,guessed_digit,result,created_at'
        )
        .eq('game_id', g.data.id)
        .order('created_at', { ascending: false })
        .limit(30)

      if (error) throw error
      setHistory((attempts || []) as Attempt[])
    }
  }

  useEffect(() => {
    if (!room?.id) return

    const roomId = room.id

    refresh(roomId).catch(error => setStatus(messageOf(error)))

    const channel = supabase
      .channel('room-' + roomId)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'rooms',
          filter: 'id=eq.' + roomId
        },
        () => refresh(roomId).catch(error => setStatus(messageOf(error)))
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'room_members',
          filter: 'room_id=eq.' + roomId
        },
        () => refresh(roomId).catch(error => setStatus(messageOf(error)))
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'games',
          filter: 'room_id=eq.' + roomId
        },
        () => refresh(roomId).catch(error => setStatus(messageOf(error)))
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_attempts'
        },
        () => refresh(roomId).catch(error => setStatus(messageOf(error)))
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [room?.id])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setStatus('')

    try {
      await action()
    } catch (error) {
      setStatus(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  async function createRoom() {
    if (!nickname.trim()) {
      throw new Error('Informe seu apelido.')
    }

    const { error } = await supabase.rpc('create_room', {
      p_nickname: nickname.trim(),
      p_max_players: maxPlayers
    })

    if (error) throw error

    const { data: mine, error: findError } = await supabase
      .from('room_members')
      .select('room_id')
      .eq('player_id', me!)
      .eq('is_host', true)
      .order('joined_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (findError) throw findError

    if (!mine?.room_id) {
      throw new Error('Sala criada, mas não foi possível localizá-la.')
    }

    await refresh(mine.room_id)
    setStatus('Sala criada! Compartilhe o código com os outros jogadores.')
  }

  async function joinRoom() {
    if (!nickname.trim()) {
      throw new Error('Informe seu apelido.')
    }

    if (!roomCode.trim()) {
      throw new Error('Informe o código da sala.')
    }

    const code = roomCode.trim().toUpperCase()

    const { error } = await supabase.rpc('join_room', {
      p_code: code,
      p_nickname: nickname.trim()
    })

    if (error) throw error

    const { data: foundRoom, error: findError } = await supabase
      .from('rooms')
      .select('id')
      .eq('code', code)
      .maybeSingle()

    if (findError) throw findError
    if (!foundRoom) throw new Error('Não foi possível localizar a sala.')

    await refresh(foundRoom.id)
    setStatus('Você entrou na sala!')
  }

  async function saveSecret() {
    if (!room) return

    if (!/^[0-9]{4}$/.test(secret)) {
      throw new Error('A senha precisa ter exatamente quatro dígitos.')
    }

    const { error } = await supabase.rpc('set_secret', {
      p_room_id: room.id,
      p_secret: secret
    })

    if (error) throw error

    setSecret('')
    await refresh()
    setStatus('Senha secreta salva!')
  }

  async function startGame() {
    if (!room) return

    const { error } = await supabase.rpc('start_game', {
      p_room_id: room.id
    })

    if (error) throw error

    setTarget('')
    await refresh()
  }

  async function submitGuess() {
    if (!room) {
      throw new Error('Sala não encontrada.')
    }

    if (!target) {
      throw new Error('Escolha quem será desafiado.')
    }

    if (!myTurn) {
      throw new Error('Aguarde sua vez de jogar.')
    }

    const selectedOpponent = members.find(
      member => member.player_id === target
    )

    if (!selectedOpponent || selectedOpponent.player_id === me) {
      throw new Error('Selecione um adversário válido.')
    }

    const guessedDigit = Number(digit)

    if (!Number.isInteger(guessedDigit) || guessedDigit < 0 || guessedDigit > 9) {
      throw new Error('Selecione um dígito entre 0 e 9.')
    }

    const { error } = await supabase.rpc('submit_guess', {
      p_room_id: room.id,
      p_target_player_id: target,
      p_digit: guessedDigit
    })

    if (error) throw error

    setTarget('')
    await refresh()
    setStatus('Tentativa enviada!')
  }

  const myMember = members.find(member => member.player_id === me)

  const myTurn = Boolean(
    game &&
    game.current_turn_player_id === me &&
    game.status === 'active'
  )

  const validTarget = members.some(
    member => member.player_id === target && member.player_id !== me
  )

  const canSubmit =
    !busy &&
    myTurn &&
    validTarget &&
    digit !== '' &&
    Number.isInteger(Number(digit)) &&
    Number(digit) >= 0 &&
    Number(digit) <= 9

  if (!configReady) {
    return (
      <main className="shell">
        <section className="panel">
          <div className="logo">
            SENHA<span>SECRETA</span>
          </div>
          <h1>Configure a conexão</h1>
          <p>
            Crie um arquivo chamado <b>.env</b> na pasta principal e
            preencha a URL e a chave publishable do seu projeto Supabase.
          </p>
        </section>
      </main>
    )
  }

  return (
    <main className="shell">
      <header>
        <div className="logo">
          SENHA<span>SECRETA</span>
        </div>
        <div className="online">
          <i />
          {session ? 'Conectado' : 'Conectando'}
        </div>
      </header>

      {!room ? (
        <section className="panel">
          <p className="eyebrow">JOGO ONLINE • 2 A 4 JOGADORES</p>

          <h1>
            Descubra a senha.
            <br />
            <em>Vença a partida.</em>
          </h1>

          <label>Seu apelido</label>
          <input
            value={nickname}
            onChange={event => setNickname(event.target.value)}
            placeholder="Como quer aparecer no jogo?"
            maxLength={18}
          />

          <div className="split">
            <div>
              <label>Jogadores na sala</label>
              <select
                value={maxPlayers}
                onChange={event => setMaxPlayers(Number(event.target.value))}
              >
                <option value={2}>2 jogadores</option>
                <option value={3}>3 jogadores</option>
                <option value={4}>4 jogadores</option>
              </select>
            </div>

            <button
              disabled={busy || !session || !nickname.trim()}
              onClick={() => run(createRoom)}
            >
              Criar sala
            </button>
          </div>

          <div className="or">OU ENTRE EM UMA SALA</div>

          <label>Código da sala</label>

          <div className="split">
            <input
              value={roomCode}
              onChange={event =>
                setRoomCode(event.target.value.toUpperCase())
              }
              placeholder="Digite o código"
              maxLength={12}
            />

            <button
              className="secondary"
              disabled={busy || !session || !nickname.trim() || !roomCode.trim()}
              onClick={() => run(joinRoom)}
            >
              Entrar
            </button>
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="roomtop">
            <div>
              <p className="eyebrow">SUA SALA</p>
              <h1 className="code">{room.code}</h1>
            </div>

            <button
              className="secondary small"
              onClick={() => {
                navigator.clipboard?.writeText(room.code)
                setStatus('Código copiado!')
              }}
            >
              Copiar código
            </button>
          </div>

          <p className="muted">
            Compartilhe este código para convidar jogadores.
          </p>

          <h2>
            Jogadores <small>{members.length}/{room.max_players}</small>
          </h2>

          <div className="players">
            {members.map(member => (
              <div className="player" key={member.id}>
                <span className="avatar">
                  {member.nickname.slice(0, 1).toUpperCase()}
                </span>

                <div>
                  <b>
                    {member.nickname}
                    {member.player_id === me ? ' (você)' : ''}
                  </b>
                  <small>
                    {member.is_host ? 'Anfitrião' : 'Jogador'} ·{' '}
                    {member.secret_set ? 'Senha definida' : 'Aguardando senha'}
                  </small>
                </div>

                {member.is_host && <span className="crown">★</span>}
              </div>
            ))}
          </div>

          {room.status === 'waiting' && (
            <>
              <label>Sua senha secreta (4 dígitos)</label>

              <div className="split">
                <input
                  className="secret"
                  inputMode="numeric"
                  maxLength={4}
                  value={secret}
                  onChange={event =>
                    setSecret(
                      event.target.value.replace(/\D/g, '').slice(0, 4)
                    )
                  }
                  placeholder="••••"
                />

                <button
                  disabled={busy || secret.length !== 4}
                  onClick={() => run(saveSecret)}
                >
                  Salvar senha
                </button>
              </div>

              {myMember?.secret_set && (
                <p className="success">
                  Sua senha foi salva. Ela não fica visível aos outros jogadores.
                </p>
              )}

              {myMember?.is_host && (
                <button
                  className="wide"
                  disabled={
                    busy ||
                    members.length < 2 ||
                    members.length !== room.max_players ||
                    members.some(member => !member.secret_set)
                  }
                  onClick={() => run(startGame)}
                >
                  Iniciar partida
                </button>
              )}

              <p className="hint">
                O anfitrião poderá iniciar quando todos os lugares estiverem
                ocupados e todos tiverem definido suas senhas.
              </p>
            </>
          )}

          {game?.status === 'active' && (
            <>
              <div className="turn">
                {myTurn ? 'É sua vez!' : 'Aguardando sua vez'}
                <small>
                  {members.find(
                    member => member.player_id === game.current_turn_player_id
                  )?.nickname || 'Jogador'} está jogando
                </small>
              </div>

              <h2>Desafiar jogador</h2>

              <select
                value={target}
                disabled={!myTurn || busy}
                onChange={event => setTarget(event.target.value)}
              >
                <option value="">Selecione um adversário</option>

                {members
                  .filter(member => member.player_id !== me)
                  .map(member => (
                    <option value={member.player_id} key={member.player_id}>
                      {member.nickname} · {member.revealed_mask}
                    </option>
                  ))}
              </select>

              <label>Qual é o dígito?</label>

              <div className="split">
                <select
                  value={digit}
                  disabled={!myTurn || busy}
                  onChange={event => setDigit(event.target.value)}
                >
                  {Array.from({ length: 10 }, (_, index) => (
                    <option key={index} value={index}>
                      {index}
                    </option>
                  ))}
                </select>

                <button
                  disabled={!canSubmit}
                  onClick={() => run(submitGuess)}
                >
                  Enviar tentativa
                </button>
              </div>

              {!myTurn && (
                <p className="hint">
                  Aguarde sua vez para enviar uma tentativa.
                </p>
              )}

              {myTurn && !target && (
                <p className="hint">
                  Selecione um adversário para habilitar o botão.
                </p>
              )}

              <h2>Histórico</h2>

              {history.length === 0 && (
                <p className="muted">Nenhuma tentativa realizada ainda.</p>
              )}

              {history.map(attempt => (
                <div className="attempt" key={attempt.id}>
                  <span>
                    {members.find(
                      member => member.player_id === attempt.player_id
                    )?.nickname || 'Jogador'}
                    {' → '}
                    {members.find(
                      member => member.player_id === attempt.target_player_id
                    )?.nickname || 'Adversário'}
                  </span>

                  <b>
                    {attempt.guessed_digit}: {attempt.result}
                  </b>
                </div>
              ))}
            </>
          )}

          {game?.status === 'finished' && (
            <div className="winner">
              🏆 Vitória de{' '}
              {members.find(
                member => member.player_id === game.winner_player_id
              )?.nickname || 'um jogador'}!
            </div>
          )}

          <button
            className="textbutton"
            onClick={() => {
              setRoom(null)
              setMembers([])
              setGame(null)
              setHistory([])
              setTarget('')
              setStatus('Você saiu da visualização da sala.')
            }}
          >
            Voltar à tela inicial
          </button>
        </section>
      )}

      {status && <div className="notice">{status}</div>}

      <footer>
        Senha Secreta <span>•</span> Partidas privadas entre amigos
      </footer>
    </main>
  )
}
