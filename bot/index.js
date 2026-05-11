const { Client, GatewayIntentBits, Partials, ActivityType } = require("discord.js");
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const DEFAULT_GUILD_ID = "1490860307269161042";

const CONFIG = {
  TOKEN: process.env.DISCORD_TOKEN,
  GUILD_ID: process.env.GUILD_ID || DEFAULT_GUILD_ID,
  AFK_CHANNEL_ID: process.env.AFK_CHANNEL_ID || "1490863820699336705",
  PORT: Number(process.env.PORT || 3000),
  DATA_FILE: path.join(__dirname, "stats.json"),
  SAVE_INTERVAL_MS: 30_000,
  TRACK_INTERVAL_MS: 10_000,
  MAX_SESSIONS_PER_USER: 80
};

if (!CONFIG.TOKEN || !CONFIG.GUILD_ID) {
  console.warn("DISCORD_TOKEN/GUILD_ID ausentes. API e dashboard sobem em modo somente leitura de dados locais.");
}

function nowTs() {
  return Date.now();
}

function emptyDb() {
  return {
    users: {},
    messages: {},
    sessions: {},
    games: {},
    dailyStats: {},
    weeklyStats: {},
    monthlyStats: {},
    lastUpdated: nowTs()
  };
}

function loadData() {
  let loadedDb = emptyDb();
  try {
    if (fs.existsSync(CONFIG.DATA_FILE)) {
      const raw = fs.readFileSync(CONFIG.DATA_FILE, "utf8");
      loadedDb = { ...loadedDb, ...JSON.parse(raw) };
    }
  } catch (error) {
    console.error("Falha ao carregar stats.json:", error.message);
  }

  try {
    const fixedPath = path.join(__dirname, "fixed_stats.json");
    if (fs.existsSync(fixedPath) && !loadedDb._fixed_stats_applied) {
      console.log("Aplicando fixed_stats.json na memoria do bot...");
      const fixed = JSON.parse(fs.readFileSync(fixedPath, "utf8"));
      for (const [uid, freshUser] of Object.entries(fixed.users || {})) {
        if (!loadedDb.users[uid]) {
          loadedDb.users[uid] = freshUser;
        } else {
          const fields = [
            "totalOnlineTime", "totalVoiceTime", "totalActiveVoiceTime",
            "totalGameTime", "totalMessages", "totalVoiceSessions",
            "totalGameSessions", "longestVoiceSession", "longestGameSession"
          ];
          for (const f of fields) {
            if (typeof freshUser[f] === "number") {
              loadedDb.users[uid][f] = Math.max(Number(loadedDb.users[uid][f] || 0), freshUser[f]);
            }
          }
        }
      }
      Object.assign(loadedDb.dailyStats,   fixed.dailyStats   || {});
      Object.assign(loadedDb.weeklyStats,  fixed.weeklyStats  || {});
      Object.assign(loadedDb.monthlyStats, fixed.monthlyStats || {});
      loadedDb._fixed_stats_applied = true;
    }
  } catch(err) {
    console.error("Erro ao aplicar fixed_stats:", err.message);
  }

  return loadedDb;
}

const db = loadData();

const voiceSessions = new Map();
const gameSessions = new Map();
const onlineSessions = new Map();
const activeVoiceSessions = new Map();
let botConnected = false;
let botLastError = null;

function ensureUserShape(user) {
  return {
    id: user.id || null,
    tag: user.tag || "Desconhecido",
    avatar: user.avatar || null,
    totalMessages: Number(user.totalMessages || 0),
    totalVoiceTime: Number(user.totalVoiceTime || 0),
    totalActiveVoiceTime: Number(user.totalActiveVoiceTime || 0),
    totalGameTime: Number(user.totalGameTime || 0),
    totalOnlineTime: Number(user.totalOnlineTime || 0),
    totalVoiceSessions: Number(user.totalVoiceSessions || 0),
    totalGameSessions: Number(user.totalGameSessions || 0),
    longestVoiceSession: Number(user.longestVoiceSession || 0),
    longestGameSession: Number(user.longestGameSession || 0),
    firstSeen: Number(user.firstSeen || nowTs()),
    lastSeen: Number(user.lastSeen || nowTs())
  };
}

function ensureUser(userId, tag, avatar) {
  const current = db.users[userId];
  const merged = ensureUserShape({
    ...(current || {}),
    id: userId,
    tag: tag || current?.tag || "Desconhecido",
    avatar: avatar || current?.avatar || null,
    lastSeen: nowTs(),
    firstSeen: current?.firstSeen || nowTs()
  });
  db.users[userId] = merged;
  return merged;
}

function persistData() {
  db.lastUpdated = nowTs();
  try {
    fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(db, null, 2), "utf8");
  } catch (error) {
    console.error("Falha ao salvar stats.json:", error.message);
  }
}

function toDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function weekStartKey(date = new Date()) {
  const local = new Date(date);
  local.setHours(0, 0, 0, 0);
  const day = local.getDay();
  const distanceToMonday = (day + 6) % 7;
  local.setDate(local.getDate() - distanceToMonday);
  return toDateKey(local);
}

function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function ensurePeriodRow(store, key, userId) {
  if (!store[key]) store[key] = {};
  if (!store[key][userId]) {
    store[key][userId] = { messages: 0, voice: 0, activeVoice: 0, game: 0, online: 0 };
  } else {
    if (typeof store[key][userId].online !== "number") store[key][userId].online = 0;
    if (typeof store[key][userId].activeVoice !== "number") store[key][userId].activeVoice = 0;
  }
}

function incrementPeriodStat(userId, type, amount, ts = nowTs()) {
  const date = new Date(ts);
  const day = toDateKey(date);
  const week = weekStartKey(date);
  const month = monthKey(date);

  ensurePeriodRow(db.dailyStats, day, userId);
  ensurePeriodRow(db.weeklyStats, week, userId);
  ensurePeriodRow(db.monthlyStats, month, userId);

  db.dailyStats[day][userId][type] += amount;
  db.weeklyStats[week][userId][type] += amount;
  db.monthlyStats[month][userId][type] += amount;
}

function startOfNextDayTs(ts) {
  const date = new Date(ts);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

function incrementPeriodStatForRange(userId, type, startedAt, endedAt) {
  let cursor = Math.max(0, Number(startedAt || endedAt));
  const end = Math.max(cursor, Number(endedAt || cursor));

  while (cursor < end) {
    const nextBoundary = startOfNextDayTs(cursor);
    const segmentEnd = Math.min(end, nextBoundary);
    incrementPeriodStat(userId, type, segmentEnd - cursor, cursor);
    cursor = segmentEnd;
  }
}

function appendSession(userId, session) {
  if (!db.sessions[userId]) db.sessions[userId] = [];
  db.sessions[userId].push(session);
  if (db.sessions[userId].length > CONFIG.MAX_SESSIONS_PER_USER) {
    db.sessions[userId] = db.sessions[userId].slice(-CONFIG.MAX_SESSIONS_PER_USER);
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const sec = totalSeconds % 60;
  const min = Math.floor(totalSeconds / 60) % 60;
  const hrs = Math.floor(totalSeconds / 3600) % 24;
  const days = Math.floor(totalSeconds / 86400);
  return `${days}d ${hrs}h ${min}m ${sec}s`;
}

function findPlayingActivity(presence) {
  return presence?.activities?.find((item) => item.type === ActivityType.Playing) || null;
}

function getPresenceStatus(presence) {
  return presence?.status || "offline";
}

function isOnlinePresence(presence) {
  return ["online", "idle", "dnd"].includes(getPresenceStatus(presence));
}

function isAfkChannel(voiceState) {
  if (!voiceState?.channelId || !voiceState?.guild) return false;
  if (CONFIG.AFK_CHANNEL_ID && voiceState.channelId === CONFIG.AFK_CHANNEL_ID) return true;
  return Boolean(voiceState.guild.afkChannelId) && voiceState.channelId === voiceState.guild.afkChannelId;
}

function isMutedOrDeafened(voiceState) {
  return Boolean(
    voiceState?.selfMute
    || voiceState?.serverMute
    || voiceState?.selfDeaf
    || voiceState?.serverDeaf
  );
}

function hasSpeakerEnabled(voiceState) {
  return Boolean(voiceState?.channelId) && !voiceState.selfDeaf && !voiceState.serverDeaf;
}

function isTrackableActiveVoice(voiceState) {
  return Boolean(voiceState?.channelId) && !isAfkChannel(voiceState) && !isMutedOrDeafened(voiceState);
}

function isQualifiedOnline(presence, voiceState) {
  return isOnlinePresence(presence) && Boolean(voiceState?.channelId) && !isAfkChannel(voiceState) && hasSpeakerEnabled(voiceState);
}

function getCachedPresence(guild, userId, fallbackPresence = null) {
  return guild?.presences?.cache?.get(userId) || fallbackPresence || null;
}

function syncQualifiedOnlineSession(userId, ts, presence, voiceState) {
  const current = onlineSessions.get(userId);
  const status = getPresenceStatus(presence);
  const qualifies = isQualifiedOnline(presence, voiceState);

  if (!qualifies) {
    if (current) closeOnlineSession(userId, ts, status);
    return;
  }

  const roomId = voiceState.channel?.id || voiceState.channelId || null;
  const roomName = voiceState.channel?.name || "Canal de voz";
  if (!current) {
    onlineSessions.set(userId, {
      startedAt: ts,
      lastCommittedAt: ts,
      status,
      roomId,
      roomName
    });
    return;
  }

  current.status = status;
  current.roomId = roomId;
  current.roomName = roomName;
}

function updateUserMessageTotals(userId) {
  const direct = Number(db.users[userId]?.totalMessages || 0);
  const counter = Number(db.messages[userId] || 0);
  db.users[userId].totalMessages = Math.max(direct, counter);
}

function sessionStartTs(session) {
  return Number(session?.startedAt || session?.joinedAt || nowTs());
}

function pendingSessionDuration(session, ts) {
  const from = Number(session?.lastCommittedAt || sessionStartTs(session));
  return Math.max(0, ts - from);
}

function commitVoiceDelta(userId, session, ts) {
  if (!session || !db.users[userId]) return 0;
  const from = Number(session.lastCommittedAt || session.joinedAt || ts);
  const duration = Math.max(0, ts - from);
  if (duration <= 0) return 0;
  db.users[userId].totalVoiceTime += duration;
  incrementPeriodStatForRange(userId, "voice", from, ts);
  session.lastCommittedAt = ts;
  return duration;
}

function commitActiveVoiceDelta(userId, session, ts) {
  if (!session || !db.users[userId]) return 0;
  const from = Number(session.lastCommittedAt || session.joinedAt || ts);
  const duration = Math.max(0, ts - from);
  if (duration <= 0) return 0;
  db.users[userId].totalActiveVoiceTime += duration;
  incrementPeriodStatForRange(userId, "activeVoice", from, ts);
  session.lastCommittedAt = ts;
  return duration;
}

function commitGameDelta(userId, session, ts) {
  if (!session || !db.users[userId]) return 0;
  const from = Number(session.lastCommittedAt || session.startedAt || ts);
  const duration = Math.max(0, ts - from);
  const gameName = session.game || "Jogo desconhecido";
  if (duration <= 0) return 0;
  db.users[userId].totalGameTime += duration;
  incrementPeriodStatForRange(userId, "game", from, ts);
  if (!db.games[userId]) db.games[userId] = {};
  db.games[userId][gameName] = (db.games[userId][gameName] || 0) + duration;
  session.lastCommittedAt = ts;
  return duration;
}

function commitOnlineDelta(userId, session, ts) {
  if (!session || !db.users[userId]) return 0;
  const from = Number(session.lastCommittedAt || session.startedAt || ts);
  const duration = Math.max(0, ts - from);
  if (duration <= 0) return 0;
  db.users[userId].totalOnlineTime += duration;
  incrementPeriodStatForRange(userId, "online", from, ts);
  session.lastCommittedAt = ts;
  return duration;
}

function commitOpenSessionDeltas(ts = nowTs()) {
  for (const [userId, session] of voiceSessions.entries()) commitVoiceDelta(userId, session, ts);
  for (const [userId, session] of activeVoiceSessions.entries()) commitActiveVoiceDelta(userId, session, ts);
  for (const [userId, session] of gameSessions.entries()) commitGameDelta(userId, session, ts);
  for (const [userId, session] of onlineSessions.entries()) commitOnlineDelta(userId, session, ts);
}

function closeVoiceSession(userId, endedAt, channelInfo) {
  const session = voiceSessions.get(userId);
  if (!session) return;
  const duration = Math.max(0, endedAt - session.joinedAt);
  if (duration <= 0) {
    voiceSessions.delete(userId);
    return;
  }

  commitVoiceDelta(userId, session, endedAt);
  if (db.users[userId]) {
    db.users[userId].totalVoiceSessions += 1;
    db.users[userId].longestVoiceSession = Math.max(db.users[userId].longestVoiceSession, duration);
  }

  appendSession(userId, {
    type: "voice",
    channelId: channelInfo?.id || session.channelId || null,
    channelName: channelInfo?.name || session.channelName || "Canal de voz",
    startedAt: session.joinedAt,
    endedAt,
    duration
  });

  voiceSessions.delete(userId);
}

function closeActiveVoiceSession(userId, endedAt, channelInfo) {
  const session = activeVoiceSessions.get(userId);
  if (!session) return;
  const duration = Math.max(0, endedAt - session.joinedAt);
  if (duration <= 0) {
    activeVoiceSessions.delete(userId);
    return;
  }

  commitActiveVoiceDelta(userId, session, endedAt);

  appendSession(userId, {
    type: "active_voice",
    channelId: channelInfo?.id || session.channelId || null,
    channelName: channelInfo?.name || session.channelName || "Canal de voz",
    startedAt: session.joinedAt,
    endedAt,
    duration
  });

  activeVoiceSessions.delete(userId);
}

function closeGameSession(userId, endedAt, fallbackGame) {
  const session = gameSessions.get(userId);
  if (!session) return;
  const duration = Math.max(0, endedAt - session.startedAt);
  const gameName = session.game || fallbackGame || "Jogo desconhecido";
  if (duration <= 0) {
    gameSessions.delete(userId);
    return;
  }

  commitGameDelta(userId, session, endedAt);
  if (db.users[userId]) {
    db.users[userId].totalGameSessions += 1;
    db.users[userId].longestGameSession = Math.max(db.users[userId].longestGameSession, duration);
  }

  appendSession(userId, {
    type: "game",
    game: gameName,
    startedAt: session.startedAt,
    endedAt,
    duration
  });

  gameSessions.delete(userId);
}

function closeOnlineSession(userId, endedAt, fallbackStatus) {
  const session = onlineSessions.get(userId);
  if (!session) return;
  const duration = Math.max(0, endedAt - session.startedAt);
  if (duration <= 0) {
    onlineSessions.delete(userId);
    return;
  }

  commitOnlineDelta(userId, session, endedAt);

  appendSession(userId, {
    type: "online",
    status: session.status || fallbackStatus || "online",
    roomId: session.roomId || null,
    roomName: session.roomName || null,
    startedAt: session.startedAt,
    endedAt,
    duration
  });

  onlineSessions.delete(userId);
}

function flushAllSessions() {
  const ts = nowTs();
  for (const [userId, session] of voiceSessions.entries()) {
    closeVoiceSession(userId, ts, {
      id: session.channelId,
      name: session.channelName || "Canal de voz"
    });
  }
  for (const [userId, session] of gameSessions.entries()) {
    closeGameSession(userId, ts, session.game);
  }
  for (const userId of onlineSessions.keys()) {
    closeOnlineSession(userId, ts);
  }
  for (const [userId, session] of activeVoiceSessions.entries()) {
    closeActiveVoiceSession(userId, ts, {
      id: session.channelId,
      name: session.channelName || "Canal de voz"
    });
  }
}

function userLiveSnapshot(userId, user, ts) {
  const voiceSession = voiceSessions.get(userId);
  const activeVoiceSession = activeVoiceSessions.get(userId);
  const gameSession = gameSessions.get(userId);
  const onlineSession = onlineSessions.get(userId);

  const voiceTotal = user.totalVoiceTime + pendingSessionDuration(voiceSession, ts);
  const activeVoiceTotal = user.totalActiveVoiceTime + pendingSessionDuration(activeVoiceSession, ts);
  const gameTotal = user.totalGameTime + pendingSessionDuration(gameSession, ts);
  const onlineTotal = user.totalOnlineTime + pendingSessionDuration(onlineSession, ts);
  const totalMessages = Math.max(Number(db.messages[userId] || 0), Number(user.totalMessages || 0));

  const userGames = db.games[userId] || {};
  const topGame = Object.entries(userGames).sort((a, b) => b[1] - a[1])[0];
  const daysActive = Math.max(1, Math.ceil((ts - user.firstSeen) / 86_400_000));

  return {
    id: userId,
    tag: user.tag,
    avatar: user.avatar || null,
    totalMessages,
    totalVoiceTime: voiceTotal,
    totalActiveVoiceTime: activeVoiceTotal,
    totalGameTime: gameTotal,
    totalOnlineTime: onlineTotal,
    totalVoiceTimeFormatted: formatDuration(voiceTotal),
    totalActiveVoiceTimeFormatted: formatDuration(activeVoiceTotal),
    totalGameTimeFormatted: formatDuration(gameTotal),
    totalOnlineTimeFormatted: formatDuration(onlineTotal),
    avgMessagesPerDay: Math.round((totalMessages / daysActive) * 10) / 10,
    totalVoiceSessions: user.totalVoiceSessions || 0,
    totalGameSessions: user.totalGameSessions || 0,
    longestVoiceSession: user.longestVoiceSession || 0,
    longestGameSession: user.longestGameSession || 0,
    longestVoiceSessionFormatted: formatDuration(user.longestVoiceSession || 0),
    longestGameSessionFormatted: formatDuration(user.longestGameSession || 0),
    topGame: topGame ? topGame[0] : null,
    topGameTime: topGame ? formatDuration(topGame[1]) : null,
    firstSeen: user.firstSeen || null,
    lastSeen: user.lastSeen || null,
    isInVoice: Boolean(voiceSession),
    isGaming: Boolean(gameSession),
    isOnlineDiscord: Boolean(onlineSession),
    presenceStatus: onlineSession?.status || "offline",
    onlineSince: onlineSession?.startedAt || null,
    currentGame: gameSession?.game || null
  };
}

function getLiveStats() {
  const ts = nowTs();
  const users = [];
  for (const [userId, raw] of Object.entries(db.users)) {
    const user = ensureUserShape(raw);
    users.push(userLiveSnapshot(userId, user, ts));
  }
  users.sort((a, b) => b.totalMessages - a.totalMessages);
  return users;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

function syncVoiceSession(userId, ts, voiceState) {
  const current = voiceSessions.get(userId);
  const qualifies = Boolean(voiceState?.channelId) && !isAfkChannel(voiceState);
  const channelId = voiceState?.channel?.id || voiceState?.channelId || null;

  if (current && (!qualifies || current.channelId !== channelId)) {
    closeVoiceSession(userId, ts, {
      id: current.channelId,
      name: current.channelName || "Canal de voz"
    });
  }

  if (!qualifies) return;

  const active = voiceSessions.get(userId);
  if (!active) {
    voiceSessions.set(userId, {
      channelId,
      channelName: voiceState.channel?.name || "Canal de voz",
      joinedAt: ts,
      lastCommittedAt: ts
    });
    return;
  }

  active.channelId = channelId;
  active.channelName = voiceState.channel?.name || active.channelName || "Canal de voz";
}

function syncActiveVoiceSession(userId, ts, voiceState) {
  const current = activeVoiceSessions.get(userId);
  const qualifies = isTrackableActiveVoice(voiceState);
  const channelId = voiceState?.channel?.id || voiceState?.channelId || null;

  if (current && (!qualifies || current.channelId !== channelId)) {
    closeActiveVoiceSession(userId, ts, {
      id: current.channelId,
      name: current.channelName || "Canal de voz"
    });
  }

  if (!qualifies) return;

  const active = activeVoiceSessions.get(userId);
  if (!active) {
    activeVoiceSessions.set(userId, {
      channelId,
      channelName: voiceState.channel?.name || "Canal de voz",
      joinedAt: ts,
      lastCommittedAt: ts
    });
    return;
  }

  active.channelId = channelId;
  active.channelName = voiceState.channel?.name || active.channelName || "Canal de voz";
}

function syncGameSession(userId, ts, presence) {
  const gameName = findPlayingActivity(presence)?.name || null;
  const current = gameSessions.get(userId);

  if (current && current.game !== gameName) {
    closeGameSession(userId, ts, current.game);
  }

  const active = gameSessions.get(userId);
  if (gameName && (!active || active.game !== gameName)) {
    gameSessions.set(userId, {
      game: gameName,
      startedAt: ts,
      lastCommittedAt: ts
    });
  }
}

function syncMemberRuntimeState(guild, member, ts, fallbackPresence = null) {
  if (!member?.user) return;
  const userId = member.id;
  ensureUser(
    userId,
    member.user.tag,
    member.user.displayAvatarURL({ size: 128 })
  );

  const presence = getCachedPresence(guild, userId, fallbackPresence || member.presence);
  syncVoiceSession(userId, ts, member.voice);
  syncActiveVoiceSession(userId, ts, member.voice);
  syncGameSession(userId, ts, presence);
  syncQualifiedOnlineSession(userId, ts, presence, member.voice);
}

async function reconcileGuildLiveState({ fetchMembers = false } = {}) {
  if (!botConnected) return;
  let guild = client.guilds.cache.get(CONFIG.GUILD_ID);
  if (!guild) {
    try {
      guild = await client.guilds.fetch(CONFIG.GUILD_ID);
    } catch {
      guild = null;
    }
  }
  if (!guild) return;

  if (fetchMembers) {
    await guild.members.fetch();
  }

  const ts = nowTs();
  guild.members.cache.forEach((member) => {
    syncMemberRuntimeState(guild, member, ts);
  });

  guild.presences.cache.forEach((presence) => {
    const userId = presence.userId;
    const member = guild.members.cache.get(userId);
    if (member) {
      syncMemberRuntimeState(guild, member, ts, presence);
      return;
    }

    const user = presence.user;
    if (!user) return;
    ensureUser(
      userId,
      user.tag,
      user.displayAvatarURL({ size: 128 })
    );
    syncGameSession(userId, ts, presence);
    syncQualifiedOnlineSession(userId, ts, presence, null);
  });

  commitOpenSessionDeltas(ts);
}

client.once("clientReady", async () => {
  botConnected = true;
  botLastError = null;
  console.log(`Bot conectado como ${client.user.tag}`);
  try {
    let guild = client.guilds.cache.get(CONFIG.GUILD_ID);
    if (!guild) {
      try {
        guild = await client.guilds.fetch(CONFIG.GUILD_ID);
      } catch {
        guild = null;
      }
    }

    if (!guild) {
      const availableGuilds = [...client.guilds.cache.values()].map((g) => `${g.name} (${g.id})`);
      console.error(`Guild configurada não encontrada: ${CONFIG.GUILD_ID}`);
      if (availableGuilds.length > 0) {
        console.error(`Guilds disponíveis para o bot: ${availableGuilds.join(" | ")}`);
      } else {
        console.error("O bot não está em nenhuma guild ou não recebeu guilds no cache.");
      }
      return;
    }

    await reconcileGuildLiveState({ fetchMembers: true });
    persistData();
  } catch (error) {
    console.error("Falha ao sincronizar membros no boot:", error.message);
  }
});

client.on("messageCreate", (message) => {
  if (message.author.bot) return;
  if (message.guild?.id !== CONFIG.GUILD_ID) return;

  const userId = message.author.id;
  ensureUser(
    userId,
    message.author.tag,
    message.author.displayAvatarURL({ size: 128 })
  );

  db.messages[userId] = Number(db.messages[userId] || 0) + 1;
  updateUserMessageTotals(userId);
  incrementPeriodStat(userId, "messages", 1);
});

client.on("voiceStateUpdate", (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  const guildId = guild?.id;
  if (guildId !== CONFIG.GUILD_ID) return;

  const userId = newState.id;
  const member = newState.member || oldState.member;
  if (!member?.user) return;

  ensureUser(
    userId,
    member.user.tag,
    member.user.displayAvatarURL({ size: 128 })
  );

  const leftVoice = oldState.channelId && !newState.channelId;
  const joinedVoice = !oldState.channelId && newState.channelId;
  const movedVoice = oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId;
  const inAfkNow = isAfkChannel(newState);
  const wasActiveVoice = isTrackableActiveVoice(oldState);
  const isActiveVoice = isTrackableActiveVoice(newState);
  const ts = nowTs();
  const presence = getCachedPresence(guild, userId, member.presence);

  if (leftVoice || movedVoice) {
    closeVoiceSession(userId, ts, {
      id: oldState.channel?.id || oldState.channelId || null,
      name: oldState.channel?.name || "Canal de voz"
    });
  }

  if (leftVoice || (movedVoice && inAfkNow)) {
    const currentGameSession = gameSessions.get(userId);
    if (currentGameSession) {
      closeGameSession(userId, ts, currentGameSession.game);
    }
  }

  if ((joinedVoice || movedVoice) && !inAfkNow) {
    voiceSessions.set(userId, {
      channelId: newState.channel?.id || newState.channelId || null,
      channelName: newState.channel?.name || "Canal de voz",
      joinedAt: ts,
      lastCommittedAt: ts
    });

    const activeGame = findPlayingActivity(presence);
    const currentGameSession = gameSessions.get(userId);
    if (activeGame?.name && (!currentGameSession || currentGameSession.game !== activeGame.name)) {
      if (currentGameSession) closeGameSession(userId, ts, currentGameSession.game);
      gameSessions.set(userId, { game: activeGame.name, startedAt: ts, lastCommittedAt: ts });
    }
  }

  if (wasActiveVoice && (!isActiveVoice || movedVoice)) {
    closeActiveVoiceSession(userId, ts, {
      id: oldState.channel?.id || oldState.channelId || null,
      name: oldState.channel?.name || "Canal de voz"
    });
  }

  if (isActiveVoice && (!wasActiveVoice || movedVoice)) {
    activeVoiceSessions.set(userId, {
      channelId: newState.channel?.id || newState.channelId || null,
      channelName: newState.channel?.name || "Canal de voz",
      joinedAt: ts,
      lastCommittedAt: ts
    });
  }

  syncQualifiedOnlineSession(userId, ts, presence, newState);
});

client.on("presenceUpdate", (oldPresence, newPresence) => {
  const guild = newPresence?.guild || oldPresence?.guild;
  const guildId = guild?.id;
  if (guildId !== CONFIG.GUILD_ID) return;

  const userId = newPresence?.userId || oldPresence?.userId;
  const member = guild?.members.cache.get(userId) || newPresence?.member || oldPresence?.member;
  const user = member?.user || newPresence?.user || oldPresence?.user;
  if (!userId || !user) return;

  ensureUser(
    userId,
    user.tag,
    user.displayAvatarURL({ size: 128 })
  );

  const ts = nowTs();

  const newGame = findPlayingActivity(newPresence)?.name || null;
  const currentSession = gameSessions.get(userId);
  const voiceState = member?.voice;
  syncQualifiedOnlineSession(userId, ts, newPresence, voiceState);

  if (currentSession && currentSession.game !== newGame) {
    closeGameSession(userId, ts, currentSession.game);
  }
  if (newGame && (!currentSession || currentSession.game !== newGame)) {
    gameSessions.set(userId, { game: newGame, startedAt: ts, lastCommittedAt: ts });
  }
  if (!newGame && currentSession) {
    closeGameSession(userId, ts, currentSession.game);
  }
});

let trackingTickRunning = false;

async function runTrackingTick() {
  if (trackingTickRunning) return;
  trackingTickRunning = true;
  try {
    await reconcileGuildLiveState();
    persistData();
  } catch (error) {
    console.error("Falha ao atualizar estatisticas em tempo real:", error.message);
  } finally {
    trackingTickRunning = false;
  }
}

setInterval(runTrackingTick, CONFIG.TRACK_INTERVAL_MS);
setInterval(() => {
  commitOpenSessionDeltas();
  persistData();
}, CONFIG.SAVE_INTERVAL_MS);

process.on("SIGINT", () => {
  flushAllSessions();
  persistData();
  process.exit(0);
});

process.on("SIGTERM", () => {
  flushAllSessions();
  persistData();
  process.exit(0);
});

function keyToLabel(key) {
  const parts = key.split("-");
  if (parts.length === 3) return `${parts[2]}/${parts[1]}`;
  if (parts.length === 2) return `${parts[1]}/${parts[0].slice(2)}`;
  return key;
}

function getPeriodKeys(period) {
  const now = new Date();
  const keys = [];
  if (period === "daily") {
    for (let i = 29; i >= 0; i -= 1) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      keys.push(toDateKey(d));
    }
    return keys;
  }
  if (period === "weekly") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    for (let i = 11; i >= 0; i -= 1) {
      const d = new Date(start);
      d.setDate(d.getDate() - i * 7);
      keys.push(toDateKey(d));
    }
    return keys;
  }
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(monthKey(d));
  }
  return keys;
}

function aggregatePeriodData(keys, store) {
  const labels = [];
  const messages = [];
  const voice = [];
  const game = [];
  const online = [];
  const activeUsers = [];

  for (const key of keys) {
    const bucket = store[key] || {};
    let sumMessages = 0;
    let sumVoice = 0;
    let sumGame = 0;
    let sumOnline = 0;

    Object.values(bucket).forEach((entry) => {
      sumMessages += Number(entry.messages || 0);
      sumVoice += Number(entry.voice || 0);
      sumGame += Number(entry.game || 0);
      sumOnline += Number(entry.online || 0);
    });

    labels.push(keyToLabel(key));
    messages.push(sumMessages);
    voice.push(Math.round((sumVoice / 3_600_000) * 10) / 10);
    game.push(Math.round((sumGame / 3_600_000) * 10) / 10);
    online.push(Math.round((sumOnline / 3_600_000) * 10) / 10);
    activeUsers.push(Object.keys(bucket).length);
  }

  return { labels, messages, voice, game, online, activeUsers };
}

function normalizeLegacyPeriod(period) {
  if (period === "day" || period === "week" || period === "month") return period;
  return "month";
}

function getConfiguredGuildId() {
  return String(CONFIG.GUILD_ID || db.guild_id || "").trim();
}

function getRequestedGuildId(req) {
  return String(req.query.guild_id || getConfiguredGuildId() || "").trim();
}

function validateGuildScope(req, res) {
  const requestedGuildId = getRequestedGuildId(req);
  if (!requestedGuildId) {
    res.status(400).json({ success: false, error: "guild_id e obrigatorio." });
    return null;
  }

  let configuredGuildId = getConfiguredGuildId();
  if (!configuredGuildId) {
    db.guild_id = requestedGuildId;
    configuredGuildId = requestedGuildId;
    persistData();
  }

  if (configuredGuildId && requestedGuildId !== configuredGuildId) {
    res.status(403).json({ success: false, error: "guild_id nao autorizado para esta instancia." });
    return null;
  }

  return { guildId: requestedGuildId, configuredGuildId };
}

function getLegacyDailyKeys(period) {
  const daysByPeriod = { day: 1, week: 7, month: 30 };
  const days = daysByPeriod[period] || 30;
  const now = new Date();
  const keys = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    keys.push(toDateKey(d));
  }
  return keys;
}

function startOfTodayTs() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function liveDurationToday(session, ts = nowTs()) {
  const startedAt = Number(session?.lastCommittedAt || session?.startedAt || session?.joinedAt || ts);
  return Math.max(0, ts - Math.max(startedAt, startOfTodayTs()));
}

function ensureLegacyMemberRow(rows, userId) {
  if (!rows[userId]) {
    rows[userId] = {
      user_id: userId,
      online_minutes: 0,
      voice_minutes: 0,
      active_voice_minutes: 0,
      game_minutes: 0,
      messages: 0
    };
  }
  return rows[userId];
}

function addLiveDurationsToLegacyMembers(rows, period) {
  if (!getLegacyDailyKeys(period).includes(toDateKey())) return;
  const ts = nowTs();

  for (const [userId, session] of onlineSessions.entries()) {
    ensureLegacyMemberRow(rows, userId).online_minutes += liveDurationToday(session, ts) / 60_000;
  }
  for (const [userId, session] of voiceSessions.entries()) {
    ensureLegacyMemberRow(rows, userId).voice_minutes += liveDurationToday(session, ts) / 60_000;
  }
  for (const [userId, session] of activeVoiceSessions.entries()) {
    ensureLegacyMemberRow(rows, userId).active_voice_minutes += liveDurationToday(session, ts) / 60_000;
  }
  for (const [userId, session] of gameSessions.entries()) {
    ensureLegacyMemberRow(rows, userId).game_minutes += liveDurationToday(session, ts) / 60_000;
  }
}

function toIsoWithoutZ(ts) {
  return new Date(ts).toISOString().replace("Z", "");
}

function splitTag(tag) {
  const safeTag = tag || "Desconhecido";
  const hashAt = safeTag.indexOf("#");
  if (hashAt < 0) return { username: safeTag, displayName: safeTag };
  const username = safeTag.slice(0, hashAt);
  return { username, displayName: username || safeTag };
}

function buildLegacyMembers(period) {
  // Retorna SEMPRE os dados completos e acumulados de cada usuário
  // Ignora histórico diário para evitar sobrescrever a base consolidada.
  return getLiveStats()
    .map((user) => {
      const names = splitTag(user.tag);
      return {
        user_id: user.id,
        username: names.username,
        display_name: names.displayName,
        avatar_url: user.avatar || null,
        online_minutes: Math.round(Number(user.totalOnlineTime || 0) / 60_000),
        voice_minutes: Math.round(Number(user.totalVoiceTime || 0) / 60_000),
        active_voice_minutes: Math.round(Number(user.totalActiveVoiceTime || user.totalVoiceTime || 0) / 60_000),
        game_minutes: Math.round(Number(user.totalGameTime || 0) / 60_000),
        messages: Number(user.totalMessages || 0),
        last_seen: user.lastSeen ? toIsoWithoutZ(user.lastSeen) : null
      };
    })
    .filter((row) =>
      row.online_minutes > 0
      || row.voice_minutes > 0
      || row.active_voice_minutes > 0
      || row.game_minutes > 0
      || row.messages > 0
    )
    .sort((a, b) => b.online_minutes - a.online_minutes); // Ordena por tempo online total
}

function buildLegacyTimeline(period) {
  const keys = getLegacyDailyKeys(period);
  const todayKey = toDateKey();
  const ts = nowTs();
  const data = keys.map((key) => {
    const bucket = db.dailyStats[key] || {};
    let totalOnlineMinutes = 0;
    Object.values(bucket).forEach((stats) => {
      totalOnlineMinutes += Math.round(Number(stats.online || 0) / 60_000);
    });
    const activeMembers = new Set(Object.keys(bucket));
    if (key === todayKey) {
      for (const [userId, session] of onlineSessions.entries()) {
        totalOnlineMinutes += liveDurationToday(session, ts) / 60_000;
        activeMembers.add(userId);
      }
    }
    return {
      date: key,
      total_minutes: totalOnlineMinutes,
      members: activeMembers.size
    };
  });

  const hasActivity = data.some((item) => item.total_minutes > 0 || item.members > 0);
  if (hasActivity) return data;

  const fallbackMembers = getLiveStats().filter(
    (user) => Number(user.totalOnlineTime || 0) > 0 || Number(user.totalVoiceTime || 0) > 0
  );
  if (fallbackMembers.length === 0) return data;

  return data.map((item) =>
    item.date === todayKey
      ? {
        date: item.date,
        total_minutes: fallbackMembers.reduce(
          (sum, user) => sum + Math.round(Number(user.totalOnlineTime || 0) / 60_000),
          0
        ),
        members: fallbackMembers.length
      }
      : item
  );
}

const app = express();
app.use(cors());
app.use(express.json());
app.get(/^\/dashboard$/, (_req, res) => {
  res.redirect(302, "/dashboard/");
});

app.get("/dashboard/", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.sendFile(path.join(__dirname, "index.html"));
});

app.use(express.static(__dirname, {
  etag: false,
  lastModified: false,
  maxAge: 0
}));

app.get("/api/stats", (_req, res) => {
  const users = getLiveStats();
  const summary = {
    totalUsers: users.length,
    onlineNow: users.filter((u) => u.isOnlineDiscord).length,
    inVoiceNow: users.filter((u) => u.isInVoice).length,
    playingNow: users.filter((u) => u.isGaming).length,
    totalMessages: users.reduce((sum, u) => sum + u.totalMessages, 0),
    totalVoiceTime: users.reduce((sum, u) => sum + u.totalVoiceTime, 0),
    totalActiveVoiceTime: users.reduce((sum, u) => sum + Number(u.totalActiveVoiceTime || 0), 0),
    totalGameTime: users.reduce((sum, u) => sum + u.totalGameTime, 0),
    totalOnlineTime: users.reduce((sum, u) => sum + u.totalOnlineTime, 0)
  };

  res.json({
    success: true,
    count: users.length,
    users,
    summary,
    lastUpdated: db.lastUpdated || nowTs()
  });
});

app.get("/api/stats/:userId", (req, res) => {
  const user = getLiveStats().find((item) => item.id === req.params.userId);
  if (!user) {
    return res.status(404).json({ success: false, error: "Usuario nao encontrado" });
  }

  const sessions = (db.sessions[req.params.userId] || [])
    .slice(-30)
    .reverse()
    .map((session) => ({
      ...session,
      durationFormatted: formatDuration(Number(session.duration || 0))
    }));

  const games = Object.entries(db.games[req.params.userId] || {})
    .map(([name, time]) => ({
      name,
      time: Number(time || 0),
      formatted: formatDuration(Number(time || 0))
    }))
    .sort((a, b) => b.time - a.time);

  res.json({
    success: true,
    user,
    sessions,
    games
  });
});

app.get("/api/leaderboard", (req, res) => {
  const type = req.query.type || "messages";
  const users = getLiveStats();

  if (type === "voice") users.sort((a, b) => b.totalVoiceTime - a.totalVoiceTime);
  else if (type === "game") users.sort((a, b) => b.totalGameTime - a.totalGameTime);
  else if (type === "online") users.sort((a, b) => b.totalOnlineTime - a.totalOnlineTime);
  else users.sort((a, b) => b.totalMessages - a.totalMessages);

  res.json({
    success: true,
    type,
    leaderboard: users.slice(0, 25)
  });
});

app.get("/api/online-now", (_req, res) => {
  const ts = nowTs();
  const users = [];
  for (const [userId, session] of onlineSessions.entries()) {
    const user = db.users[userId];
    if (!user) continue;
    users.push({
      id: userId,
      tag: user.tag,
      avatar: user.avatar || null,
      status: session.status || "online",
      roomId: session.roomId || null,
      roomName: session.roomName || null,
      onlineSince: session.startedAt,
      onlineDuration: ts - session.startedAt,
      isInVoice: voiceSessions.has(userId),
      currentGame: gameSessions.get(userId)?.game || null
    });
  }

  res.json({
    success: true,
    count: users.length,
    users: users.sort((a, b) => b.onlineDuration - a.onlineDuration)
  });
});

app.get("/api/report/:period", (req, res) => {
  const period = req.params.period;
  if (!["daily", "weekly", "monthly"].includes(period)) {
    return res.status(400).json({ success: false, error: "Periodo invalido." });
  }

  const keys = getPeriodKeys(period);
  const store =
    period === "daily" ? db.dailyStats
      : period === "weekly" ? db.weeklyStats
        : db.monthlyStats;

  const data = aggregatePeriodData(keys, store);
  const periodUsers = {};

  keys.forEach((key) => {
    const row = store[key] || {};
    Object.entries(row).forEach(([userId, stats]) => {
      if (!periodUsers[userId]) {
        periodUsers[userId] = { messages: 0, voice: 0, game: 0, online: 0 };
      }
      periodUsers[userId].messages += Number(stats.messages || 0);
      periodUsers[userId].voice += Number(stats.voice || 0);
      periodUsers[userId].game += Number(stats.game || 0);
      periodUsers[userId].online += Number(stats.online || 0);
    });
  });

  const topUsers = Object.entries(periodUsers)
    .map(([id, stats]) => ({
      id,
      tag: db.users[id]?.tag || "Desconhecido",
      avatar: db.users[id]?.avatar || null,
      messages: stats.messages,
      voiceHours: Math.round((stats.voice / 3_600_000) * 10) / 10,
      gameHours: Math.round((stats.game / 3_600_000) * 10) / 10,
      onlineHours: Math.round((stats.online / 3_600_000) * 10) / 10
    }))
    .sort((a, b) => b.messages - a.messages)
    .slice(0, 15);

  const totals = {
    messages: data.messages.reduce((sum, n) => sum + n, 0),
    voiceHours: Math.round(data.voice.reduce((sum, n) => sum + n, 0) * 10) / 10,
    gameHours: Math.round(data.game.reduce((sum, n) => sum + n, 0) * 10) / 10,
    onlineHours: Math.round(data.online.reduce((sum, n) => sum + n, 0) * 10) / 10,
    activeUsers: Object.keys(periodUsers).length
  };

  res.json({
    success: true,
    period,
    data,
    topUsers,
    totals,
    dateRange: { from: keys[0], to: keys[keys.length - 1] }
  });
});

app.get("/api/compare", (_req, res) => {
  const now = new Date();
  const current = [];
  const previous = [];

  for (let i = 6; i >= 0; i -= 1) {
    const d1 = new Date(now);
    d1.setDate(d1.getDate() - i);
    current.push(toDateKey(d1));

    const d2 = new Date(now);
    d2.setDate(d2.getDate() - i - 7);
    previous.push(toDateKey(d2));
  }

  function summarize(keys) {
    let messages = 0;
    let voice = 0;
    let game = 0;
    let online = 0;
    const users = new Set();

    keys.forEach((key) => {
      const day = db.dailyStats[key] || {};
      Object.entries(day).forEach(([userId, stats]) => {
        users.add(userId);
        messages += Number(stats.messages || 0);
        voice += Number(stats.voice || 0);
        game += Number(stats.game || 0);
        online += Number(stats.online || 0);
      });
    });

    return {
      messages,
      voiceHours: Math.round((voice / 3_600_000) * 10) / 10,
      gameHours: Math.round((game / 3_600_000) * 10) / 10,
      onlineHours: Math.round((online / 3_600_000) * 10) / 10,
      activeUsers: users.size
    };
  }

  function pct(cur, prev) {
    if (prev === 0) return cur > 0 ? 100 : 0;
    return Math.round((((cur - prev) / prev) * 100) * 10) / 10;
  }

  const a = summarize(current);
  const b = summarize(previous);

  res.json({
    success: true,
    current: a,
    previous: b,
    change: {
      messages: pct(a.messages, b.messages),
      voiceHours: pct(a.voiceHours, b.voiceHours),
      gameHours: pct(a.gameHours, b.gameHours),
      onlineHours: pct(a.onlineHours, b.onlineHours),
      activeUsers: pct(a.activeUsers, b.activeUsers)
    }
  });
});

app.get("/api/daily", (_req, res) => {
  const keys = getPeriodKeys("daily");
  const data = aggregatePeriodData(keys, db.dailyStats);
  res.json({
    success: true,
    labels: keys,
    datasets: [{ label: "Mensagens", data: data.messages }]
  });
});

app.get("/api/overview", (req, res) => {
  const scope = validateGuildScope(req, res);
  if (!scope) return;

  const period = normalizeLegacyPeriod(req.query.period);
  const rows = buildLegacyMembers(period);

  const totalOnlineMinutes = rows.reduce((sum, row) => sum + Number(row.online_minutes || 0), 0);
  const totalVoiceMinutes = rows.reduce((sum, row) => sum + Number(row.voice_minutes || 0), 0);
  const totalActiveVoiceMinutes = rows.reduce((sum, row) => sum + Number(row.active_voice_minutes || 0), 0);
  const totalGameMinutes = rows.reduce((sum, row) => sum + Number(row.game_minutes || 0), 0);

  res.json({
    success: true,
    guild_id: scope.guildId,
    period,
    active_members: rows.length,
    total_online_minutes: totalOnlineMinutes,
    total_voice_minutes: totalVoiceMinutes,
    total_active_voice_minutes: totalActiveVoiceMinutes,
    total_game_minutes: totalGameMinutes
  });
});

app.get("/api/members", (req, res) => {
  const scope = validateGuildScope(req, res);
  if (!scope) return;

  const period = normalizeLegacyPeriod(req.query.period);
  const rows = buildLegacyMembers(period);

  res.json({
    success: true,
    guild_id: scope.guildId,
    period,
    count: rows.length,
    data: rows
  });
});

app.get("/api/timeline", (req, res) => {
  const scope = validateGuildScope(req, res);
  if (!scope) return;

  const period = normalizeLegacyPeriod(req.query.period);
  const data = buildLegacyTimeline(period);

  res.json({
    success: true,
    guild_id: scope.guildId,
    period,
    count: data.length,
    data
  });
});

// ── HOT-RELOAD: recarrega stats.json do disco para a memória ──────────────
app.post("/api/reload", (_req, res) => {
  try {
    // 1. Commita sessões abertas para não perder tempo em andamento
    commitOpenSessionDeltas();

    // 2. Lê o arquivo atualizado do disco
    const fresh = loadData();

    // 3. Mescla os totais do arquivo nos usuários em memória
    //    Preserva apenas os acumulados (totalOnlineTime, totalVoiceTime, etc.)
    //    sem apagar sessões ativas
    for (const [uid, freshUser] of Object.entries(fresh.users || {})) {
      if (!db.users[uid]) {
        db.users[uid] = freshUser;
      } else {
        // Sobrescreve somente os campos acumulados com o valor do disco (o maior)
        const fields = [
          "totalOnlineTime", "totalVoiceTime", "totalActiveVoiceTime",
          "totalGameTime", "totalMessages", "totalVoiceSessions",
          "totalGameSessions", "longestVoiceSession", "longestGameSession"
        ];
        for (const f of fields) {
          if (typeof freshUser[f] === "number") {
            db.users[uid][f] = Math.max(Number(db.users[uid][f] || 0), freshUser[f]);
          }
        }
      }
    }

    // 4. Recarrega dailyStats / weeklyStats / monthlyStats do disco
    Object.assign(db.dailyStats,   fresh.dailyStats   || {});
    Object.assign(db.weeklyStats,  fresh.weeklyStats  || {});
    Object.assign(db.monthlyStats, fresh.monthlyStats || {});

    console.log("[reload] stats.json recarregado do disco com sucesso.");
    res.json({ success: true, message: "Stats recarregados do disco.", ts: Date.now() });
  } catch (err) {
    console.error("[reload] Erro ao recarregar:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────

app.get("/", (_req, res) => res.redirect("/dashboard"));
app.get("/health", (_req, res) => {
  const configuredGuildId = getConfiguredGuildId();
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: nowTs(),
    guild: {
      configuredId: configuredGuildId || null,
      requiresGuildId: false
    },
    bot: {
      configured: Boolean(CONFIG.TOKEN && CONFIG.GUILD_ID),
      connected: botConnected,
      lastError: botLastError
    }
  });
});

function startHttpServer(preferredPort, maxAttempts = 15) {
  let attempt = 0;
  let port = preferredPort;

  function tryListen() {
    const server = app.listen(port, () => {
      console.log(`API online na porta ${port}`);
      console.log(`Dashboard: http://localhost:${port}/dashboard/`);
    });

    server.on("error", (error) => {
      if (error.code === "EADDRINUSE" && attempt < maxAttempts) {
        attempt += 1;
        port += 1;
        console.warn(`Porta em uso. Tentando porta ${port}...`);
        setTimeout(tryListen, 120);
        return;
      }
      console.error("Falha ao iniciar servidor HTTP:", error.message);
      process.exit(1);
    });
  }

  tryListen();
}

startHttpServer(CONFIG.PORT);

if (CONFIG.TOKEN && CONFIG.GUILD_ID) {
  client.login(CONFIG.TOKEN).catch((error) => {
    botConnected = false;
    botLastError = error?.message || "Falha desconhecida no login do bot.";
    console.error("Falha no login do bot Discord:", botLastError);
  });
} else {
  botConnected = false;
  botLastError = "Bot nao inicializado por falta de DISCORD_TOKEN/GUILD_ID.";
}
