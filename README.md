# 🤖 Discord Stats Bot + Dashboard

Bot de estatísticas para Discord com dashboard interativo, 100% em formato API, sem banco de dados dedicado.

## ✨ Funcionalidades

- **📊 Estatísticas em tempo real:** mensagens, tempo em voz, tempo jogando
- **🎙️ Rastreamento de voz:** detecta quando usuários entram/saem de canais de voz
- **🎮 Rastreamento de jogos:** detecta atividades de jogo (Presence)
- **🏆 Rankings:** leaderboard por mensagens, tempo em voz e tempo jogando
- **📈 Gráficos interativos:** barras, doughnut e linha com Chart.js
- **🔴 Ao Vivo:** veja quem está em call no momento
- **👤 Perfil detalhado:** clique em qualquer usuário para ver histórico completo
- **💾 Persistência em JSON:** dados salvos em arquivo, sem DB necessário

## 📁 Estrutura

```
discord-stats-bot/
├── index.js          # Bot Discord + API REST (Express)
├── index.html        # Dashboard
├── style.css         # Estilos modernos
├── app.js            # Lógica interativa
├── stats.json        # "Banco de dados" (criado automaticamente)
└── package.json
```

## 🚀 Deploy na VertraCloud

### 1. Crie o Bot no Discord

1. Acesse [Discord Developer Portal](https://discord.com/developers/applications)
2. Clique em **New Application** → dê um nome
3. Vá em **Bot** → clique **Add Bot**
4. Ative estas **Privileged Gateway Intents**:
   - ☑️ Presence Intent
   - ☑️ Server Members Intent
   - ☑️ Message Content Intent
5. Copie o **Token** (vai precisar depois)
6. Vá em **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Administrator` (ou as mínimas: Read Messages, Send Messages, Connect, Speak, View Channels)
   - Copie a URL e adicione o bot no seu servidor

### 2. Prepare o Projeto

```bash
# Instale dependências
npm install
```

### 3. Variáveis de Ambiente (VertraCloud)

No painel da VertraCloud, configure estas variáveis de ambiente:

| Variável | Valor |
|----------|-------|
| `DISCORD_TOKEN` | Token do seu bot |
| `GUILD_ID` | ID do servidor Discord |
| `PORT` | `3000` (ou deixe padrão) |

**Como pegar o GUILD_ID:**
- No Discord, ative o Modo Desenvolvedor (Configurações → Avançado)
- Clique com botão direito no nome do servidor → **Copiar ID do Servidor**

### 4. Deploy

1. Compacte todos os arquivos em um `.zip`
2. No painel VertraCloud, faça upload do projeto
3. Defina o **Start Command** como: `npm start`
4. A porta será detectada automaticamente (usa `process.env.PORT`)

### 5. Acesse o Dashboard

Após o deploy, acesse:
```
https://seu-app.vertracloud.app/dashboard
```

Ou a raiz redireciona automaticamente:
```
https://seu-app.vertracloud.app/
```

## 🔌 Endpoints da API

| Endpoint | Descrição |
|----------|-----------|
| `GET /api/stats` | Todas as estatísticas dos usuários |
| `GET /api/stats/:userId` | Detalhes de um usuário específico |
| `GET /api/leaderboard?type=messages` | Ranking (messages, voice, game) |
| `GET /api/online-now` | Quem está em call no momento |
| `GET /api/daily` | Mensagens por dia (últimos 30 dias) |
| `GET /health` | Health check |

## 📝 Notas Importantes

- **Persistência:** Os dados são salvos em `stats.json`. Na VertraCloud, o disco geralmente persiste entre reinicializações, mas faça backup periodicamente.
- **Sem DB dedicado:** Se precisar de mais confiabilidade, considere usar uma API externa gratuita como JSONBin.io ou uma planilha Google Sheets como "DB".
- **Intents:** Sem os Privileged Intents ativados, o bot não conseguirá rastrear presença/jogos e conteúdo de mensagens.
- **Memória:** O arquivo JSON cresce conforme o uso. Para servidores muito grandes, considere limitar o histórico de sessões.

## 🎨 Personalização

O dashboard usa CSS puro com variáveis CSS. Edite `style.css` para mudar cores, bordas, etc.

## 📄 Licença

MIT
