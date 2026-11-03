# Senha Secreta

Aplicativo multiplayer para Android (Capacitor) e web, desenvolvido com React, TypeScript, Vite e Supabase.

## Funcionalidades incluídas

- Salas online para 2, 3 ou 4 participantes, com código de acesso.
- Autenticação anônima do Supabase.
- Senha secreta individual de quatro dígitos, armazenada no servidor.
- Desafio automático ao próximo participante na ordem de entrada.
- Respostas MAIOR, MENOR e ACERTOU.
- Revelação progressiva dos dígitos descobertos, sem exibir a senha integral.
- Teclado numérico de 0 a 9.
- Destaque visual, alerta sonoro e vibração quando chega a vez do jogador.
- Histórico de tentativas agrupado por rodada.
- Encerramento imediato da rodada quando a senha é descoberta.
- Preparação de novas rodadas mantendo a sala, os participantes e os registros anteriores.
- Atualização em tempo real pelo Supabase Realtime.

## Configuração do Supabase

O projeto utiliza estas variáveis de ambiente:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY` (aceita a chave publishable do Supabase)

No GitHub, cadastre ambas em **Settings → Secrets and variables → Actions** com esses nomes exatos. A chave publishable pode estar no aplicativo; nunca coloque uma chave `service_role` ou secret key no frontend.

Os scripts SQL de referência estão em `supabase/`. Eles documentam a estrutura e as funções do backend. Como o banco deste projeto já foi atualizado manualmente durante a configuração, não execute novamente scripts antigos sem revisar o estado atual do banco.

## Enviar para o GitHub

1. Extraia o ZIP.
2. Abra o repositório `senha-secreta` no GitHub.
3. Envie os arquivos e pastas que estão dentro de `senha-secreta-android` para a raiz do repositório, substituindo os arquivos antigos.
4. Faça o commit na branch `main`.
5. O workflow **Build Android APK** será iniciado automaticamente. Também pode ser iniciado em **Actions → Build Android APK → Run workflow**.

## Baixar o APK

Quando a execução do workflow terminar com sucesso:

1. Abra a execução em **Actions**.
2. Vá até **Artifacts**.
3. Baixe `senha-secreta-apk`.
4. Extraia o arquivo ZIP do artifact. Dentro estará `app-debug.apk`.

Esse APK é para instalação e testes. Para publicar na Google Play, será necessário preparar uma versão de lançamento assinada (AAB).

## Executar localmente

Requer Node.js 22 ou superior.

```bash
npm install
npm run dev
```

Para gerar a versão web:

```bash
npm run build
```

O workflow do GitHub Actions prepara a plataforma Android e gera o APK de testes.
