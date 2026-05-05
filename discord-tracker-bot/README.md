# Discord Tracker Bot (Cloud Ready)

Bot Discord + API FastAPI + dashboard web para rastrear:
- presenca online/idle/dnd/offline
- tempo em voz
- mensagens
- tempo em jogos

Persistencia em PostgreSQL (`asyncpg`), pronto para deploy em nuvem.

## Estrutura

- `bot.py`: worker do Discord
- `api.py`: API + dashboard (`/`)
- `db.py`: pool e queries PostgreSQL
- `static/index.html`: frontend
- `Procfile`: processos web/worker
- `railway.toml`: exemplo de config compatível com deploy por serviços

## Variaveis de ambiente

Copie `.env.example` para `.env` e configure:

- `DISCORD_TOKEN`
- `GUILD_ID`
- `DATABASE_URL`
- `API_SECRET` (opcional, mas recomendado)
- `PORT` (default 8000)

## Rodar local

1. Instalar dependencias:
   - `pip install -r requirements.txt`
2. Subir API:
   - `uvicorn api:app --host 0.0.0.0 --port 8000`
3. Subir bot:
   - `python bot.py`

## Endpoints principais

- `GET /api/overview`
- `GET /api/top/online`
- `GET /api/top/messages`
- `GET /api/top/games`
- `GET /api/top/voice`
- `GET /api/games/ranking`
- `GET /api/timeline`
- `GET /api/members`

Todos aceitam `period=day|week|month` e `guild_id`.
Se `API_SECRET` estiver configurado, passe `secret=...`.

## Deploy na VertraCloud (`https://vertracloud.app/`)

Configure dois servicos no mesmo projeto:

1. Servico API (web):
   - Start command: `uvicorn api:app --host 0.0.0.0 --port $PORT`
2. Servico Worker (bot):
   - Start command: `python bot.py`

Nos dois servicos, configure as mesmas variaveis:
- `DISCORD_TOKEN`
- `GUILD_ID`
- `DATABASE_URL`
- `API_SECRET`
- `PORT` (somente API usa)

Banco PostgreSQL:
- Crie um banco PostgreSQL na propria VertraCloud (ou externo).
- Copie a connection string para `DATABASE_URL`.

## Notas de operacao

- Ative no Discord Developer Portal:
  - `SERVER MEMBERS INTENT`
  - `PRESENCE INTENT`
  - `MESSAGE CONTENT INTENT`
- Convide o bot com permissao de ler canais e mensagens.
- O worker precisa ficar sempre ativo para coletar eventos em tempo real.
