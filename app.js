const API_BASE = window.location.origin;
const FALLBACK_AVATAR = "https://cdn.discordapp.com/embed/avatars/0.png";

const state = {
  users: [],
  charts: {},
  currentReportPeriod: "daily",
  currentReportMetric: "messages",
  reportPayload: null
};

const sectionMeta = {
  overview: { title: "Visao Geral", subtitle: "Metricas em tempo real da guild" },
  reports: { title: "Relatorios", subtitle: "Evolucao por periodo e comportamento" },
  leaderboard: { title: "Rankings", subtitle: "Comparativo por tipo de atividade" },
  users: { title: "Usuarios", subtitle: "Detalhamento por membro" },
  online: { title: "Online Agora", subtitle: "Presenca atual no Discord" }
};

const reportTitleByPeriod = {
  daily: "Evolucao diaria (30 dias)",
  weekly: "Evolucao semanal (12 semanas)",
  monthly: "Evolucao mensal (12 meses)"
};

function el(id) {
  return document.getElementById(id);
}

function formatHours(ms) {
  return `${Math.floor(ms / 3_600_000).toLocaleString("pt-BR")}h`;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const sec = total % 60;
  const min = Math.floor(total / 60) % 60;
  const hrs = Math.floor(total / 3600) % 24;
  const days = Math.floor(total / 86400);
  if (days > 0) return `${days}d ${hrs}h`;
  if (hrs > 0) return `${hrs}h ${min}m`;
  return `${min}m ${sec}s`;
}

function getTimeAgo(timestamp) {
  if (!timestamp) return "sem atividade";
  const diff = Date.now() - timestamp;
  const min = Math.floor(diff / 60_000);
  const hrs = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (min < 1) return "agora";
  if (min < 60) return `${min} min`;
  if (hrs < 24) return `${hrs} h`;
  return `${days} d`;
}

function setStatus(isOk) {
  el("statusDot").classList.toggle("online", isOk);
  el("statusText").textContent = isOk ? "Conectado" : "Desconectado";
}

function setError(show) {
  el("globalError").classList.toggle("hidden", !show);
}

function destroyChart(key) {
  if (!state.charts[key]) return;
  state.charts[key].destroy();
  delete state.charts[key];
}

function createChart(key, canvasId, config) {
  destroyChart(key);
  state.charts[key] = new Chart(el(canvasId).getContext("2d"), config);
}

async function fetchJson(path) {
  try {
    const response = await fetch(`${API_BASE}${path}`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function switchSection(section) {
  document.querySelectorAll(".menu-link").forEach((link) => {
    link.classList.toggle("active", link.dataset.section === section);
  });
  document.querySelectorAll(".section").forEach((node) => {
    node.classList.toggle("active", node.id === section);
  });
  const meta = sectionMeta[section];
  el("pageTitle").textContent = meta.title;
  el("pageSubtitle").textContent = meta.subtitle;

  if (section === "leaderboard") {
    const tab = document.querySelector(".tab-btn.active")?.dataset.tab || "messages";
    loadLeaderboard(tab);
  }
  if (section === "reports") {
    loadReport(state.currentReportPeriod);
  }
  if (section === "online") {
    loadOnlineNow();
  }
}

function renderOverviewSummary(stats) {
  const summary = stats.summary || {};
  el("totalUsers").textContent = Number(summary.totalUsers || 0).toLocaleString("pt-BR");
  el("totalOnlineNow").textContent = Number(summary.onlineNow || 0).toLocaleString("pt-BR");
  el("totalMessages").textContent = Number(summary.totalMessages || 0).toLocaleString("pt-BR");
  el("totalOnline").textContent = formatHours(Number(summary.totalOnlineTime || 0));
  el("totalVoice").textContent = formatHours(Number(summary.totalVoiceTime || 0));
  el("totalGame").textContent = formatHours(Number(summary.totalGameTime || 0));
}

function renderOverviewCharts(users) {
  const topMessages = [...users].sort((a, b) => b.totalMessages - a.totalMessages).slice(0, 10);
  createChart("messages", "messagesChart", {
    type: "bar",
    data: {
      labels: topMessages.map((u) => u.tag.split("#")[0]),
      datasets: [
        {
          label: "Mensagens",
          data: topMessages.map((u) => u.totalMessages),
          backgroundColor: "rgba(15, 118, 110, 0.75)",
          borderRadius: 6
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, grid: { color: "rgba(148, 163, 184, 0.25)" } }
      }
    }
  });

  const topTime = [...users]
    .sort((a, b) => b.totalOnlineTime - a.totalOnlineTime)
    .slice(0, 8);

  createChart("time", "timeChart", {
    type: "bar",
    data: {
      labels: topTime.map((u) => u.tag.split("#")[0]),
      datasets: [
        {
          label: "Online (h)",
          data: topTime.map((u) => Math.round((u.totalOnlineTime / 3_600_000) * 10) / 10),
          backgroundColor: "rgba(15, 118, 110, 0.75)"
        },
        {
          label: "Voz (h)",
          data: topTime.map((u) => Math.round((u.totalVoiceTime / 3_600_000) * 10) / 10),
          backgroundColor: "rgba(29, 78, 216, 0.7)"
        },
        {
          label: "Jogo (h)",
          data: topTime.map((u) => Math.round((u.totalGameTime / 3_600_000) * 10) / 10),
          backgroundColor: "rgba(245, 158, 11, 0.75)"
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" }
      },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, grid: { color: "rgba(148, 163, 184, 0.25)" } }
      }
    }
  });
}

function renderRecentActivity(users) {
  const target = el("activityList");
  const list = [...users]
    .filter((u) => u.lastSeen)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, 9);

  if (!list.length) {
    target.innerHTML = `<div class="empty-state">Ainda nao ha atividade registrada.</div>`;
    return;
  }

  target.innerHTML = list.map((user) => {
    let icon = "fa-comments";
    let action = "Atividade de mensagens";
    if (user.isOnlineDiscord) {
      icon = "fa-signal";
      action = `Online (${user.presenceStatus})`;
    }
    if (user.isInVoice) {
      icon = "fa-microphone";
      action = "Em canal de voz";
    }
    if (user.isGaming) {
      icon = "fa-gamepad";
      action = `Jogando ${user.currentGame || "agora"}`;
    }

    return `
      <div class="activity-item">
        <img class="activity-avatar" src="${user.avatar || FALLBACK_AVATAR}" alt="Avatar">
        <div>
          <p class="activity-title">${user.tag}</p>
          <p class="activity-desc"><i class="fa-solid ${icon}"></i> ${action}</p>
        </div>
        <p class="activity-time">${getTimeAgo(user.lastSeen)}</p>
      </div>
    `;
  }).join("");
}

function renderUsers(users) {
  const grid = el("usersGrid");
  if (!users.length) {
    grid.innerHTML = `<div class="empty-state">Nenhum usuario encontrado.</div>`;
    return;
  }

  grid.innerHTML = users.map((user) => `
    <article class="user-card" data-user-id="${user.id}">
      <div class="user-card-head">
        <img src="${user.avatar || FALLBACK_AVATAR}" alt="Avatar">
        <div>
          <h4>${user.tag}</h4>
          <p class="user-state">${user.isOnlineDiscord ? `Online (${user.presenceStatus})` : "Offline"}</p>
        </div>
      </div>
      <div class="stat-line">
        <article><p>Msgs</p><h5>${user.totalMessages.toLocaleString("pt-BR")}</h5></article>
        <article><p>Online</p><h5>${Math.round(user.totalOnlineTime / 3_600_000)}h</h5></article>
        <article><p>Voz</p><h5>${Math.round(user.totalVoiceTime / 3_600_000)}h</h5></article>
        <article><p>Jogo</p><h5>${Math.round(user.totalGameTime / 3_600_000)}h</h5></article>
      </div>
    </article>
  `).join("");

  grid.querySelectorAll(".user-card").forEach((card) => {
    card.addEventListener("click", () => openUserModal(card.dataset.userId));
  });
}

function renderCompare(compare) {
  const metrics = [
    { key: "messages", label: "Mensagens" },
    { key: "onlineHours", label: "Online (h)" },
    { key: "voiceHours", label: "Voz (h)" },
    { key: "gameHours", label: "Jogo (h)" },
    { key: "activeUsers", label: "Usuarios ativos" }
  ];

  el("compareDate").textContent = "Ultimos 7 dias x semana anterior";
  el("compareGrid").innerHTML = metrics.map((metric) => {
    const cur = Number(compare.current?.[metric.key] || 0);
    const prev = Number(compare.previous?.[metric.key] || 0);
    const change = Number(compare.change?.[metric.key] || 0);
    const css = change > 0 ? "up" : change < 0 ? "down" : "neutral";
    const icon = change > 0 ? "fa-arrow-up" : change < 0 ? "fa-arrow-down" : "fa-minus";
    const sign = change > 0 ? "+" : "";

    return `
      <article class="compare-item">
        <p class="compare-item-label">${metric.label}</p>
        <span class="compare-item-value">${cur.toLocaleString("pt-BR")}</span>
        <span class="compare-item-change ${css}">
          <i class="fa-solid ${icon}"></i> ${sign}${change}% (vs ${prev.toLocaleString("pt-BR")})
        </span>
      </article>
    `;
  }).join("");
}

async function loadOverview() {
  const stats = await fetchJson("/api/stats");
  if (!stats?.success) {
    setStatus(false);
    setError(true);
    return;
  }

  setStatus(true);
  setError(false);
  state.users = stats.users || [];

  renderOverviewSummary(stats);
  renderOverviewCharts(state.users);
  renderRecentActivity(state.users);
  renderUsers(state.users);

  const compare = await fetchJson("/api/compare");
  if (compare?.success) renderCompare(compare);
}

function leaderboardLabels(type) {
  if (type === "messages") return { title: "Mensagens", detail: "Online total" };
  if (type === "online") return { title: "Tempo online", detail: "Status atual" };
  if (type === "voice") return { title: "Tempo em voz", detail: "Mensagens" };
  return { title: "Tempo em jogos", detail: "Jogo principal" };
}

function leaderboardRowValue(type, user) {
  if (type === "messages") {
    return { value: user.totalMessages.toLocaleString("pt-BR"), detail: user.totalOnlineTimeFormatted };
  }
  if (type === "online") {
    return {
      value: user.totalOnlineTimeFormatted,
      detail: user.isOnlineDiscord ? `Online (${user.presenceStatus})` : "Offline"
    };
  }
  if (type === "voice") {
    return { value: user.totalVoiceTimeFormatted, detail: `${user.totalMessages.toLocaleString("pt-BR")} msgs` };
  }
  return { value: user.totalGameTimeFormatted, detail: user.topGame || "-" };
}

function renderLeaderboard(type, rows) {
  const labels = leaderboardLabels(type);
  const target = el("leaderboardContent");
  if (!rows.length) {
    target.innerHTML = `<div class="empty-state">Sem dados para leaderboard.</div>`;
    return;
  }

  target.innerHTML = `
    <div class="table-row leaderboard-row header">
      <span>#</span>
      <span>Usuario</span>
      <span>${labels.title}</span>
      <span class="extra-col">${labels.detail}</span>
    </div>
    ${rows.map((user, idx) => {
      const row = leaderboardRowValue(type, user);
      return `
        <div class="table-row leaderboard-row">
          <span class="rank">${idx + 1}</span>
          <span class="user-inline">
            <img src="${user.avatar || FALLBACK_AVATAR}" alt="Avatar">
            <span>${user.tag}</span>
          </span>
          <span>${row.value}</span>
          <span class="extra-col">${row.detail}</span>
        </div>
      `;
    }).join("")}
  `;
}

async function loadLeaderboard(type) {
  el("leaderboardContent").innerHTML = `<div class="loading-state"><i class="fa-solid fa-circle-notch fa-spin"></i> Carregando ranking...</div>`;
  const result = await fetchJson(`/api/leaderboard?type=${encodeURIComponent(type)}`);
  if (!result?.success) {
    el("leaderboardContent").innerHTML = `<div class="empty-state">Falha ao carregar ranking.</div>`;
    return;
  }
  renderLeaderboard(type, result.leaderboard || []);
}

function renderReportChart(data, metric) {
  const colorByMetric = {
    messages: "#0f766e",
    online: "#0891b2",
    voice: "#1d4ed8",
    game: "#f59e0b",
    activeUsers: "#dc2626"
  };
  const labelByMetric = {
    messages: "Mensagens",
    online: "Horas online",
    voice: "Horas em voz",
    game: "Horas em jogos",
    activeUsers: "Usuarios ativos"
  };

  createChart("report", "reportChart", {
    type: "line",
    data: {
      labels: data.labels,
      datasets: [
        {
          label: labelByMetric[metric],
          data: data[metric],
          borderColor: colorByMetric[metric],
          backgroundColor: `${colorByMetric[metric]}22`,
          borderWidth: 3,
          fill: true,
          tension: 0.35,
          pointRadius: 3,
          pointHoverRadius: 5
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, grid: { color: "rgba(148, 163, 184, 0.25)" } }
      }
    }
  });
}

function renderTopUsersInPeriod(users) {
  const target = el("topUsersTable");
  if (!users.length) {
    target.innerHTML = `<div class="empty-state">Sem dados para o periodo selecionado.</div>`;
    return;
  }

  target.innerHTML = `
    <div class="table-row period-row header">
      <span>#</span>
      <span>Usuario</span>
      <span>Msgs</span>
      <span>Online h</span>
      <span class="hide-mobile">Voz h</span>
      <span class="hide-mobile">Jogo h</span>
    </div>
    ${users.map((user, idx) => `
      <div class="table-row period-row">
        <span class="rank">${idx + 1}</span>
        <span class="user-inline">
          <img src="${user.avatar || FALLBACK_AVATAR}" alt="Avatar">
          <span>${user.tag}</span>
        </span>
        <span>${user.messages.toLocaleString("pt-BR")}</span>
        <span>${user.onlineHours.toFixed(1)}</span>
        <span class="hide-mobile">${user.voiceHours.toFixed(1)}</span>
        <span class="hide-mobile">${user.gameHours.toFixed(1)}</span>
      </div>
    `).join("")}
  `;
}

async function loadReport(period) {
  state.currentReportPeriod = period;
  document.querySelectorAll(".period-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.period === period);
  });

  const result = await fetchJson(`/api/report/${period}`);
  if (!result?.success) {
    el("topUsersTable").innerHTML = `<div class="empty-state">Falha ao carregar relatorio.</div>`;
    return;
  }

  state.reportPayload = result;
  el("periodMessages").textContent = result.totals.messages.toLocaleString("pt-BR");
  el("periodOnline").textContent = `${result.totals.onlineHours.toFixed(1)}h`;
  el("periodVoice").textContent = `${result.totals.voiceHours.toFixed(1)}h`;
  el("periodGame").textContent = `${result.totals.gameHours.toFixed(1)}h`;
  el("periodActive").textContent = result.totals.activeUsers.toLocaleString("pt-BR");
  el("reportChartTitle").textContent = reportTitleByPeriod[period] || "Evolucao";

  renderReportChart(result.data, state.currentReportMetric);
  renderTopUsersInPeriod(result.topUsers || []);
}

function changeReportMetric(metric) {
  state.currentReportMetric = metric;
  document.querySelectorAll(".metric-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.metric === metric);
  });
  if (state.reportPayload?.data) {
    renderReportChart(state.reportPayload.data, metric);
  }
}

function statusChip(status) {
  if (status === "em_sala") return "Em sala";
  if (status === "dnd") return "Nao perturbe";
  if (status === "idle") return "Ausente";
  if (status === "online") return "Online";
  return "Offline";
}

async function loadOnlineNow() {
  const grid = el("onlineGrid");
  grid.innerHTML = `<div class="loading-state"><i class="fa-solid fa-circle-notch fa-spin"></i> Carregando usuarios...</div>`;
  const result = await fetchJson("/api/online-now");

  if (!result?.success) {
    grid.innerHTML = `<div class="empty-state">Falha ao carregar usuarios online.</div>`;
    return;
  }

  el("onlineCount").textContent = `${result.users.length} online`;
  if (!result.users.length) {
    grid.innerHTML = `<div class="empty-state">Nenhum usuario online agora.</div>`;
    return;
  }

  grid.innerHTML = result.users.map((user) => `
    <article class="online-card">
      <div class="online-card-head">
        <img src="${user.avatar || FALLBACK_AVATAR}" alt="Avatar">
        <div>
          <h4>${user.tag}</h4>
          <p class="user-state">${statusChip(user.status)}</p>
        </div>
      </div>
      <span class="online-chip"><i class="fa-solid fa-clock"></i> ${formatDuration(user.onlineDuration)}</span>
      <div class="chip-status">
        ${user.isInVoice ? "Em voz" : "Sem voz"}${user.currentGame ? ` · Jogando ${user.currentGame}` : ""}
      </div>
    </article>
  `).join("");
}

async function openUserModal(userId) {
  const result = await fetchJson(`/api/stats/${userId}`);
  if (!result?.success) return;

  const user = result.user;
  el("modalAvatar").src = user.avatar || FALLBACK_AVATAR;
  el("modalTag").textContent = user.tag;
  el("modalId").textContent = user.id;
  el("modalMessages").textContent = user.totalMessages.toLocaleString("pt-BR");
  el("modalOnline").textContent = user.totalOnlineTimeFormatted;
  el("modalVoice").textContent = user.totalVoiceTimeFormatted;
  el("modalGame").textContent = user.totalGameTimeFormatted;
  el("modalAvgMessages").textContent = Number(user.avgMessagesPerDay || 0).toLocaleString("pt-BR");
  el("modalLongestVoice").textContent = user.longestVoiceSessionFormatted;
  el("modalLongestGame").textContent = user.longestGameSessionFormatted;

  const gamesRoot = el("modalGames");
  if (!result.games?.length) {
    gamesRoot.innerHTML = `<div class="empty-state">Nenhum jogo registrado.</div>`;
  } else {
    const max = Math.max(...result.games.map((g) => g.time), 1);
    gamesRoot.innerHTML = result.games.slice(0, 8).map((game) => `
      <div class="game-bar">
        <span>${game.name}</span>
        <div class="game-track"><div class="game-fill" style="width:${(game.time / max) * 100}%"></div></div>
        <span>${game.formatted}</span>
      </div>
    `).join("");
  }

  const sessionsRoot = el("modalSessions");
  if (!result.sessions?.length) {
    sessionsRoot.innerHTML = `<div class="empty-state">Nenhuma sessao registrada.</div>`;
  } else {
    sessionsRoot.innerHTML = result.sessions.map((session) => {
      let name = session.type === "voice" ? session.channelName : session.type === "game" ? session.game : `Online (${statusChip(session.status)})`;
      if (!name) name = session.type;
      const date = new Date(session.startedAt).toLocaleDateString("pt-BR");
      return `<div class="session-item"><span>${name}</span><span>${session.durationFormatted} - ${date}</span></div>`;
    }).join("");
  }

  el("userModal").classList.add("active");
}

function closeModal() {
  el("userModal").classList.remove("active");
}

function bindEvents() {
  document.querySelectorAll(".menu-link").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      switchSection(link.dataset.section);
    });
  });

  el("refreshButton").addEventListener("click", async () => {
    await loadOverview();
    const active = document.querySelector(".section.active")?.id;
    if (active === "reports") await loadReport(state.currentReportPeriod);
    if (active === "leaderboard") {
      const tab = document.querySelector(".tab-btn.active")?.dataset.tab || "messages";
      await loadLeaderboard(tab);
    }
    if (active === "online") await loadOnlineNow();
  });

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      document.querySelectorAll(".tab-btn").forEach((node) => node.classList.remove("active"));
      btn.classList.add("active");
      await loadLeaderboard(btn.dataset.tab);
    });
  });

  document.querySelectorAll(".period-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await loadReport(btn.dataset.period);
    });
  });

  document.querySelectorAll(".metric-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      changeReportMetric(btn.dataset.metric);
    });
  });

  el("userSearch").addEventListener("input", () => {
    const query = el("userSearch").value.trim().toLowerCase();
    const filtered = state.users.filter((user) => user.tag.toLowerCase().includes(query));
    renderUsers(filtered);
  });

  el("modalClose").addEventListener("click", closeModal);
  el("userModal").addEventListener("click", (event) => {
    if (event.target === el("userModal")) closeModal();
  });
}

async function init() {
  bindEvents();
  await loadOverview();
  await loadReport("daily");

  setInterval(async () => {
    await loadOverview();
    const active = document.querySelector(".section.active")?.id;
    if (active === "online") await loadOnlineNow();
  }, 10_000);
}

init();
