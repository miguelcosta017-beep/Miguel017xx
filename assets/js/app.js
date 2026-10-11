import {
  STORE_NAMES,
  initDB,
  getAll,
  getById,
  upsert,
  remove,
  deletePatient,
  clearAllData,
  readAllData,
} from "./db.js";
import {
  createBackup,
  parseBackup,
  validateBackup,
  restoreBackup,
  shareOrDownloadBackup,
} from "./backup.js";
import { shareOrDownloadExcel } from "./excel.js";

const APP_VERSION = "1.2.0";
const VALID_VIEWS = new Set(["dashboard", "agenda", "patients", "clinic", "finances"]);
const VIEW_META = Object.freeze({
  dashboard: { title: "Início", context: "Resumo da clínica" },
  agenda: { title: "Agenda", context: "Marcações e disponibilidade" },
  patients: { title: "Pacientes", context: "Base clínica local" },
  clinic: { title: "Clínica", context: "Sessões e avaliações" },
  finances: { title: "Finanças", context: "Receitas, despesas e pendentes" },
});
const STORE_LABELS = Object.freeze({
  patients: "Pacientes",
  appointments: "Marcações",
  packages: "Pacotes",
  sessions: "Sessões",
  evaluations: "Avaliações",
  transactions: "Transações",
  settings: "Definições",
});

const elements = {
  appTitle: document.querySelector("#app-title"),
  headerContext: document.querySelector("#header-context"),
  headerActions: document.querySelector("#header-actions"),
  viewRoot: document.querySelector("#view-root"),
  primaryNav: document.querySelector("#primary-nav"),
  fab: document.querySelector("#fab"),
  dialog: document.querySelector("#app-dialog"),
  dialogEyebrow: document.querySelector("#dialog-eyebrow"),
  dialogTitle: document.querySelector("#dialog-title"),
  dialogBody: document.querySelector("#dialog-body"),
  dialogActions: document.querySelector("#dialog-actions"),
  confirmDialog: document.querySelector("#confirm-dialog"),
  confirmTitle: document.querySelector("#confirm-title"),
  confirmMessage: document.querySelector("#confirm-message"),
  toastRegion: document.querySelector("#toast-region"),
  installBanner: document.querySelector("#install-banner"),
  updateBanner: document.querySelector("#update-banner"),
};

const state = {
  view: "dashboard",
  patientId: null,
  agendaDate: localISODate(),
  agendaStatus: "all",
  clinicTab: "sessions",
  financeMonth: localISODate().slice(0, 7),
  pendingBackup: null,
  installPrompt: null,
  serviceWorkerRegistration: null,
  updateWorker: null,
  storagePersistent: null,
  renderId: 0,
  reloadingForUpdate: false,
};

const currencyFormatter = new Intl.NumberFormat("pt-PT", {
  style: "currency",
  currency: "EUR",
});
const dateFormatter = new Intl.DateTimeFormat("pt-PT", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});
const longDateFormatter = new Intl.DateTimeFormat("pt-PT", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

function localISODate(date = new Date()) {
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return adjusted.toISOString().slice(0, 10);
}

function addDays(dateText, amount) {
  const date = new Date(`${dateText}T12:00:00`);
  date.setDate(date.getDate() + amount);
  return localISODate(date);
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function selected(value, expected) {
  return String(value ?? "") === String(expected ?? "") ? " selected" : "";
}

function checked(value) {
  return value ? " checked" : "";
}

function formatCurrency(value) {
  return currencyFormatter.format(Number(value) || 0);
}

function parseDate(value) {
  if (!value) return null;
  const text = String(value);
  const date = new Date(text.length === 10 ? `${text}T12:00:00` : text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value, fallback = "Sem data") {
  const date = parseDate(value);
  return date ? dateFormatter.format(date) : fallback;
}

function formatLongDate(value) {
  const date = parseDate(value);
  if (!date) return "Data inválida";
  const formatted = longDateFormatter.format(date);
  return formatted.charAt(0).toLocaleUpperCase("pt-PT") + formatted.slice(1);
}

function formatTime(value) {
  if (!value) return "—";
  const text = String(value);
  const match = text.match(/T(\d{2}:\d{2})/);
  if (match) return match[1];
  const date = parseDate(text);
  return date ? new Intl.DateTimeFormat("pt-PT", { hour: "2-digit", minute: "2-digit" }).format(date) : "—";
}

function formatDateTime(value) {
  if (!value) return "Sem data";
  return `${formatDate(value)} · ${formatTime(value)}`;
}

function toDateTimeLocal(value) {
  if (!value) return "";
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return text.slice(0, 16);
  const date = parseDate(text);
  if (!date) return "";
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return adjusted.toISOString().slice(0, 16);
}

function sortNewest(records, field = "date") {
  return [...records].sort((a, b) => String(b[field] || b.updatedAt || "").localeCompare(String(a[field] || a.updatedAt || "")));
}

function sortOldest(records, field = "start") {
  return [...records].sort((a, b) => String(a[field] || "").localeCompare(String(b[field] || "")));
}

function initials(name) {
  return String(name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("pt-PT") || "")
    .join("") || "?";
}

function normaliseSearch(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-PT")
    .trim();
}

function sum(records, getter) {
  return records.reduce((total, record) => total + (Number(getter(record)) || 0), 0);
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function patientMap(patients) {
  return new Map(patients.map((patient) => [patient.id, patient]));
}

function patientDisplay(map, patientId) {
  return map.get(patientId)?.name || "Paciente não identificado";
}

function packageUsageMap(sessions) {
  const usage = new Map();
  for (const session of sessions) {
    if (session.packageId) usage.set(session.packageId, (usage.get(session.packageId) || 0) + 1);
  }
  return usage;
}

function packageRemaining(packageRecord, usage) {
  return Math.max(0, (Number(packageRecord.totalSessions) || 0) - (usage.get(packageRecord.id) || 0));
}

function packageStatus(packageRecord, usage) {
  if (packageRecord.paymentStatus === "cancelled") return "cancelled";
  return packageRemaining(packageRecord, usage) > 0 ? "active" : "completed";
}

async function getSetting(key, fallback = undefined) {
  const record = await getById("settings", key);
  return record ? record.value : fallback;
}

async function setSetting(key, value) {
  await upsert("settings", { key, value });
  return value;
}

async function loadCollections(...names) {
  const result = await Promise.all(names.map((name) => getAll(name)));
  return Object.fromEntries(names.map((name, index) => [name, result[index]]));
}

function statusLabel(status) {
  return ({
    scheduled: "Agendada",
    confirmed: "Confirmada",
    completed: "Concluída",
    cancelled: "Cancelada",
    no_show: "Faltou",
    paid: "Pago",
    pending: "Pendente",
    waived: "Isento",
    package: "Pacote",
    active: "Ativo",
    inactive: "Inativo",
  })[status] || status || "—";
}

function appointmentTypeLabel(type) {
  return ({ session: "Sessão", assessment: "Avaliação", followup: "Reavaliação", other: "Outro" })[type] || "Sessão";
}

function transactionTypeLabel(type) {
  return type === "expense" ? "Despesa" : "Receita";
}

function patientOptions(patients, current = "", { allowEmpty = false } = {}) {
  const options = [...patients]
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "pt-PT"))
    .map((patient) => `<option value="${escapeHTML(patient.id)}"${selected(patient.id, current)}>${escapeHTML(patient.name)}</option>`)
    .join("");
  return `${allowEmpty ? `<option value=""${selected("", current)}>Sem paciente associado</option>` : ""}${options}`;
}

function metricCard(label, value, meta = "", tone = "") {
  return `<article class="metric-card${tone ? ` metric-card--${tone}` : ""}">
    <span class="metric-card__label">${escapeHTML(label)}</span>
    <strong class="metric-card__value">${escapeHTML(value)}</strong>
    ${meta ? `<span class="metric-card__meta">${escapeHTML(meta)}</span>` : ""}
  </article>`;
}

function emptyState(title, message, action = "", label = "Adicionar") {
  return `<section class="empty-state empty-state--compact">
    <div class="empty-state__icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 6h16v14H4zM8 3h8v3M8 11h8M8 15h5" /></svg></div>
    <h2>${escapeHTML(title)}</h2>
    <p>${escapeHTML(message)}</p>
    ${action ? `<button class="button button--primary" type="button" data-action="${escapeHTML(action)}">${escapeHTML(label)}</button>` : ""}
  </section>`;
}

function setHeader(title, context) {
  elements.appTitle.textContent = title;
  elements.headerContext.textContent = context;
}

function configureShell() {
  const meta = VIEW_META[state.view];
  setHeader(meta.title, meta.context);
  elements.primaryNav.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  const fabActions = {
    agenda: ["add-appointment", "Nova marcação"],
    patients: ["add-patient", "Novo paciente"],
    clinic: [state.clinicTab === "evaluations" ? "add-evaluation" : "add-session", state.clinicTab === "evaluations" ? "Nova avaliação" : "Nova sessão"],
    finances: ["add-transaction", "Nova transação"],
  };
  const config = fabActions[state.view];
  elements.fab.hidden = !config || Boolean(state.patientId);
  if (config) {
    elements.fab.dataset.action = config[0];
    elements.fab.setAttribute("aria-label", config[1]);
    elements.fab.title = config[1];
    const label = elements.fab.querySelector(".fab__label");
    if (label) label.textContent = config[1];
  }
}

function renderLoading() {
  elements.viewRoot.setAttribute("aria-busy", "true");
  elements.viewRoot.innerHTML = `<section class="view view--loading"><div class="loading-state">
    <div class="loading-state__mark" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M7.5 16h17M16 7.5v17" /></svg></div>
    <h2>A preparar os dados…</h2><p>Tudo permanece neste dispositivo.</p><span class="loading-state__bar" aria-hidden="true"></span>
  </div></section>`;
}

async function renderCurrentView({ focus = false, showLoading = false } = {}) {
  const renderId = ++state.renderId;
  configureShell();
  if (showLoading) renderLoading();
  try {
    const renderer = {
      dashboard: renderDashboard,
      agenda: renderAgenda,
      patients: renderPatients,
      clinic: renderClinic,
      finances: renderFinances,
    }[state.view];
    const markup = await renderer();
    if (renderId !== state.renderId) return;
    elements.viewRoot.innerHTML = markup;
    elements.viewRoot.removeAttribute("aria-busy");
    configureShell();
    if (focus) elements.viewRoot.focus({ preventScroll: true });
  } catch (error) {
    console.error(error);
    if (renderId !== state.renderId) return;
    elements.viewRoot.removeAttribute("aria-busy");
    elements.viewRoot.innerHTML = `<section class="view">${emptyState("Não foi possível abrir esta área", error.message || "Ocorreu um erro ao ler os dados locais.", "retry-render", "Tentar novamente")}</section>`;
    showToast(error.message || "Não foi possível ler os dados.", "error");
  }
}

async function renderDashboard() {
  const { patients, appointments, packages, sessions, transactions } = await loadCollections("patients", "appointments", "packages", "sessions", "transactions");
  const today = localISODate();
  const nowText = new Date().toISOString();
  const month = today.slice(0, 7);
  const todaysAppointments = sortOldest(appointments.filter((item) => String(item.start || "").slice(0, 10) === today));
  const upcoming = sortOldest(appointments.filter((item) => String(item.start || "") >= nowText.slice(0, 16) && !["cancelled", "completed"].includes(item.status))).slice(0, 5);
  const monthTransactions = transactions.filter((item) => String(item.date || "").startsWith(month) && item.status !== "cancelled");
  const paidIncome = sum(monthTransactions.filter((item) => item.type === "income" && item.status === "paid"), (item) => item.amount);
  const pendingIncome = sum(monthTransactions.filter((item) => item.type === "income" && item.status === "pending"), (item) => item.amount);
  const activePatients = patients.filter((patient) => patient.active !== false).length;
  const map = patientMap(patients);
  const reminderDays = Number(await getSetting("backupReminderDays", 14)) || 14;
  const lastBackupAt = await getSetting("lastBackupAt", null);
  const lastBackupAge = lastBackupAt ? (Date.now() - Date.parse(lastBackupAt)) / 86_400_000 : Infinity;
  const hasData = patients.length + appointments.length + packages.length + sessions.length + transactions.length > 0;
  const showBackupReminder = hasData && lastBackupAge >= reminderDays;

  const agendaMarkup = todaysAppointments.length
    ? `<div class="appointment-list">${todaysAppointments.map((appointment) => appointmentCard(appointment, map, { compact: true })).join("")}</div>`
    : `<div class="inline-empty"><strong>Agenda livre hoje</strong><span>Não existem marcações para ${formatDate(today)}.</span></div>`;
  const upcomingMarkup = upcoming.length
    ? `<div class="record-list">${upcoming.map((appointment) => `<button class="record-row" type="button" data-action="edit-appointment" data-id="${escapeHTML(appointment.id)}">
        <span class="date-tile"><strong>${escapeHTML(formatTime(appointment.start))}</strong><small>${escapeHTML(formatDate(appointment.start))}</small></span>
        <span class="record-row__main"><span class="record-row__title">${escapeHTML(patientDisplay(map, appointment.patientId))}</span><span class="record-row__meta">${escapeHTML(appointmentTypeLabel(appointment.type))}</span></span>
        <span class="status-badge status-badge--${escapeHTML(appointment.status)}">${escapeHTML(statusLabel(appointment.status))}</span>
      </button>`).join("")}</div>`
    : `<div class="inline-empty"><span>Sem próximas marcações.</span></div>`;

  return `<section class="view" aria-labelledby="dashboard-heading">
    <div class="welcome-panel">
      <div><p class="eyebrow">${escapeHTML(formatLongDate(today))}</p><h2 id="dashboard-heading">A clínica, num só lugar</h2><p>Privado, local e preparado para trabalhar sem internet.</p></div>
      <div class="privacy-pill"><span aria-hidden="true">✓</span><span><strong>Dados locais</strong><small>Sem login nem sincronização</small></span></div>
    </div>

    ${showBackupReminder ? `<aside class="notice notice--warning" aria-label="Lembrete de backup">
      <div><strong>${lastBackupAt ? "Está na altura de atualizar o backup" : "Ainda não existe um backup"}</strong><p>${lastBackupAt ? `Último backup: ${formatDate(lastBackupAt)}.` : "Proteja os dados da clínica com uma cópia integral."}</p></div>
      <button class="button button--small button--secondary" type="button" data-action="open-backup">Criar agora</button>
    </aside>` : ""}

    <div class="metrics-grid">
      ${metricCard("Pacientes ativos", String(activePatients), plural(patients.length, "registo"))}
      ${metricCard("Marcações hoje", String(todaysAppointments.length), todaysAppointments.length ? `${todaysAppointments.filter((item) => item.status === "completed").length} concluídas` : "Dia livre")}
      ${metricCard("Recebido este mês", formatCurrency(paidIncome), monthLabel(month))}
      ${metricCard("Por receber", formatCurrency(pendingIncome), "Sessões pendentes")}
    </div>

    <div class="quick-actions" aria-label="Ações rápidas">
      <button class="action-tile" type="button" data-action="add-patient"><span class="action-tile__icon">+</span><span><strong>Novo paciente</strong><small>Criar ficha clínica</small></span></button>
      <button class="action-tile" type="button" data-action="add-appointment"><span class="action-tile__icon">+</span><span><strong>Nova marcação</strong><small>Adicionar à agenda</small></span></button>
      <button class="action-tile" type="button" data-action="add-session"><span class="action-tile__icon">+</span><span><strong>Registar sessão</strong><small>Tratamento e pagamento</small></span></button>
      <button class="action-tile" type="button" data-action="add-transaction"><span class="action-tile__icon">+</span><span><strong>Movimento</strong><small>Receita ou despesa</small></span></button>
    </div>

    ${!hasData ? `<aside class="notice notice--info"><div><strong>Quer explorar uma clínica preenchida?</strong><p>Adicione dados fictícios de demonstração; pode apagá-los quando quiser.</p></div><button class="button button--small button--secondary" type="button" data-action="create-demo">Adicionar demonstração</button></aside>` : ""}

    <div class="dashboard-grid">
      <article class="card"><header class="card__header"><div><p class="eyebrow">Hoje</p><h3>Agenda do dia</h3></div><button class="button button--small button--ghost" type="button" data-action="go-view" data-target-view="agenda">Ver agenda</button></header><div class="card__body">${agendaMarkup}</div></article>
      <article class="card"><header class="card__header"><div><p class="eyebrow">A seguir</p><h3>Próximas marcações</h3></div></header><div class="card__body">${upcomingMarkup}</div></article>
    </div>
  </section>`;
}

async function renderAgenda() {
  const { appointments, patients } = await loadCollections("appointments", "patients");
  const map = patientMap(patients);
  const dayAppointments = sortOldest(appointments.filter((appointment) => {
    const sameDay = String(appointment.start || "").slice(0, 10) === state.agendaDate;
    return sameDay && (state.agendaStatus === "all" || appointment.status === state.agendaStatus);
  }));
  const counts = appointments.filter((appointment) => String(appointment.start || "").slice(0, 10) === state.agendaDate)
    .reduce((result, appointment) => ({ ...result, [appointment.status]: (result[appointment.status] || 0) + 1 }), {});
  const weekDays = Array.from({ length: 7 }, (_, index) => addDays(state.agendaDate, index - 3));

  return `<section class="view" aria-labelledby="agenda-heading">
    <div class="view-header"><div><h2 id="agenda-heading">${escapeHTML(formatLongDate(state.agendaDate))}</h2><p>${plural(dayAppointments.length, "marcação", "marcações")} visível nesta data.</p></div><div class="view-actions"><button class="button button--primary" type="button" data-action="add-appointment">Nova marcação</button></div></div>
    <div class="agenda-toolbar card">
      <button class="icon-button" type="button" data-action="agenda-prev" aria-label="Dia anterior"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg></button>
      <label class="date-control"><span class="visually-hidden">Data da agenda</span><input id="agenda-date" type="date" value="${escapeHTML(state.agendaDate)}"></label>
      <button class="icon-button" type="button" data-action="agenda-next" aria-label="Dia seguinte"><svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6" /></svg></button>
      <button class="button button--small button--ghost" type="button" data-action="agenda-today">Hoje</button>
      <label class="compact-select"><span>Estado</span><select id="agenda-status">
        <option value="all"${selected(state.agendaStatus, "all")}>Todos</option><option value="scheduled"${selected(state.agendaStatus, "scheduled")}>Agendadas</option><option value="confirmed"${selected(state.agendaStatus, "confirmed")}>Confirmadas</option><option value="completed"${selected(state.agendaStatus, "completed")}>Concluídas</option><option value="cancelled"${selected(state.agendaStatus, "cancelled")}>Canceladas</option>
      </select></label>
    </div>
    <div class="day-strip" aria-label="Dias próximos">${weekDays.map((date) => `<button class="day-button${date === state.agendaDate ? " is-active" : ""}" type="button" data-action="agenda-day" data-date="${date}" aria-pressed="${date === state.agendaDate}"><small>${escapeHTML(new Intl.DateTimeFormat("pt-PT", { weekday: "short" }).format(parseDate(date)))}</small><strong>${date.slice(-2)}</strong></button>`).join("")}</div>
    <div class="agenda-summary"><span class="badge">${counts.scheduled || 0} agendadas</span><span class="badge badge--info">${counts.confirmed || 0} confirmadas</span><span class="badge badge--success">${counts.completed || 0} concluídas</span></div>
    ${dayAppointments.length ? `<div class="timeline">${dayAppointments.map((appointment) => appointmentCard(appointment, map)).join("")}</div>` : emptyState("Sem marcações", "Não há marcações com este filtro.", "add-appointment", "Nova marcação")}
  </section>`;
}

function appointmentCard(appointment, map, { compact = false } = {}) {
  const name = patientDisplay(map, appointment.patientId);
  return `<article class="appointment appointment--${escapeHTML(appointment.type || "session")}">
    <time class="appointment__time" datetime="${escapeHTML(appointment.start)}">${escapeHTML(formatTime(appointment.start))}</time>
    <div class="appointment__content">
      <div class="appointment__header"><div><h3 class="appointment__title">${escapeHTML(name)}</h3><p class="appointment__meta">${escapeHTML(appointmentTypeLabel(appointment.type))} · ${Number(appointment.duration) || 60} min${appointment.room ? ` · ${escapeHTML(appointment.room)}` : ""}</p></div><span class="status-badge status-badge--${escapeHTML(appointment.status)}">${escapeHTML(statusLabel(appointment.status))}</span></div>
      ${appointment.notes && !compact ? `<p class="record-note">${escapeHTML(appointment.notes)}</p>` : ""}
      ${!compact ? `<div class="inline-actions inline-actions--end"><button class="button button--small button--ghost" type="button" data-action="edit-appointment" data-id="${escapeHTML(appointment.id)}">Editar</button>${!["completed", "cancelled"].includes(appointment.status) ? `<button class="button button--small button--secondary" type="button" data-action="complete-appointment" data-id="${escapeHTML(appointment.id)}">Concluir</button>` : ""}<button class="button button--small button--ghost text-danger" type="button" data-action="delete-record" data-store="appointments" data-id="${escapeHTML(appointment.id)}">Eliminar</button></div>` : ""}
    </div>
  </article>`;
}

async function renderPatients() {
  if (state.patientId) return renderPatientDetail(state.patientId);
  const patients = [...await getAll("patients")].sort((a, b) => String(a.name).localeCompare(String(b.name), "pt-PT"));
  const rows = patients.map((patient) => `<article class="record-row patient-row" data-search="${escapeHTML(normaliseSearch(`${patient.name} ${patient.phone || ""} ${patient.email || ""}`))}">
    <span class="avatar" aria-hidden="true">${escapeHTML(initials(patient.name))}</span>
    <button class="record-row__main record-row__button" type="button" data-action="open-patient" data-id="${escapeHTML(patient.id)}"><span class="record-row__title">${escapeHTML(patient.name)}</span><span class="record-row__meta">${escapeHTML([patient.phone, patient.email].filter(Boolean).join(" · ") || "Sem contacto")}</span></button>
    <div class="row-end"><span class="status-badge status-badge--${patient.active === false ? "inactive" : "active"}">${patient.active === false ? "Inativo" : "Ativo"}</span><button class="icon-button" type="button" data-action="edit-patient" data-id="${escapeHTML(patient.id)}" aria-label="Editar ${escapeHTML(patient.name)}"><svg viewBox="0 0 24 24"><path d="m4 20 4-.8L19 8.2a2 2 0 0 0-3-3L5 16.2Z" /></svg></button></div>
  </article>`).join("");
  return `<section class="view" aria-labelledby="patients-heading">
    <div class="view-header"><div><h2 id="patients-heading">Pacientes</h2><p>${plural(patients.length, "ficha clínica", "fichas clínicas")} neste dispositivo.</p></div><button class="button button--primary" type="button" data-action="add-patient">Novo paciente</button></div>
    <div class="filter-bar"><label class="search-field"><span class="visually-hidden">Pesquisar pacientes</span><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg><input id="patient-search" type="search" autocomplete="off" placeholder="Pesquisar nome ou contacto…"></label></div>
    ${patients.length ? `<div class="record-list" id="patient-list">${rows}</div><p class="filter-empty" id="patient-filter-empty" hidden>Nenhum paciente corresponde à pesquisa.</p>` : emptyState("Ainda não existem pacientes", "Crie a primeira ficha para começar a usar a clínica.", "add-patient", "Novo paciente")}
  </section>`;
}

async function renderPatientDetail(patientId) {
  const [patient, collections] = await Promise.all([
    getById("patients", patientId),
    loadCollections("appointments", "packages", "sessions", "evaluations", "transactions"),
  ]);
  if (!patient) {
    state.patientId = null;
    return `<section class="view">${emptyState("Paciente não encontrado", "A ficha pode ter sido eliminada.", "back-to-patients", "Voltar à lista")}</section>`;
  }
  setHeader(patient.name, "Ficha clínica");
  const appointments = sortNewest(collections.appointments.filter((item) => item.patientId === patientId), "start");
  const packages = sortNewest(collections.packages.filter((item) => item.patientId === patientId), "purchaseDate");
  const sessions = sortNewest(collections.sessions.filter((item) => item.patientId === patientId));
  const evaluations = sortNewest(collections.evaluations.filter((item) => item.patientId === patientId));
  const transactions = sortNewest(collections.transactions.filter((item) => item.patientId === patientId));
  const balance = sum(transactions.filter((item) => item.type === "income" && item.status === "paid"), (item) => item.amount) - sum(transactions.filter((item) => item.type === "expense" && item.status === "paid"), (item) => item.amount);
  const usage = packageUsageMap(sessions);
  const packageMap = new Map(packages.map((item) => [item.id, item]));
  const activePackages = packages.filter((item) => packageStatus(item, usage) === "active").length;

  return `<section class="view patient-detail" aria-labelledby="patient-heading">
    <button class="back-button" type="button" data-action="back-to-patients"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg>Pacientes</button>
    <article class="patient-hero card">
      <div class="avatar patient-hero__avatar" aria-hidden="true">${escapeHTML(initials(patient.name))}</div>
      <div class="patient-hero__main"><div class="patient-hero__title"><h2 id="patient-heading">${escapeHTML(patient.name)}</h2><span class="status-badge status-badge--${patient.active === false ? "inactive" : "active"}">${patient.active === false ? "Inativo" : "Ativo"}</span></div><p>${escapeHTML([patient.phone, patient.email].filter(Boolean).join(" · ") || "Sem contactos registados")}</p></div>
      <div class="patient-hero__actions"><button class="button button--secondary" type="button" data-action="edit-patient" data-id="${escapeHTML(patient.id)}">Editar ficha</button><button class="icon-button text-danger" type="button" data-action="delete-patient" data-id="${escapeHTML(patient.id)}" aria-label="Eliminar ficha"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" /></svg></button></div>
    </article>
    <div class="metrics-grid patient-metrics">${metricCard("Sessões", String(sessions.length))}${metricCard("Pacotes ativos", String(activePackages))}${metricCard("Avaliações", String(evaluations.length))}${metricCard("Marcações", String(appointments.length))}${metricCard("Total recebido", formatCurrency(balance))}</div>
    <div class="patient-actions"><button class="button button--primary" type="button" data-action="add-session" data-patient-id="${escapeHTML(patient.id)}">Nova sessão</button><button class="button button--secondary" type="button" data-action="add-package" data-patient-id="${escapeHTML(patient.id)}">Novo pacote</button><button class="button button--secondary" type="button" data-action="add-evaluation" data-patient-id="${escapeHTML(patient.id)}">Nova avaliação</button><button class="button button--secondary" type="button" data-action="add-appointment" data-patient-id="${escapeHTML(patient.id)}">Marcar</button><button class="button button--secondary" type="button" data-action="add-transaction" data-patient-id="${escapeHTML(patient.id)}">Movimento</button></div>
    <div class="view-grid view-grid--sidebar">
      <div class="card-stack">
        <article class="card"><header class="card__header"><div><p class="eyebrow">Histórico clínico</p><h3>Sessões</h3></div><button class="button button--small button--ghost" type="button" data-action="add-session" data-patient-id="${escapeHTML(patient.id)}">Adicionar</button></header><div class="card__body">${sessions.length ? sessions.slice(0, 8).map((session) => sessionCard(session, new Map([[patient.id, patient]]), packageMap, usage)).join("") : `<div class="inline-empty"><span>Sem sessões registadas.</span></div>`}</div></article>
        <article class="card"><header class="card__header"><div><p class="eyebrow">Avaliação</p><h3>Avaliações clínicas</h3></div><button class="button button--small button--ghost" type="button" data-action="add-evaluation" data-patient-id="${escapeHTML(patient.id)}">Adicionar</button></header><div class="card__body">${evaluations.length ? evaluations.slice(0, 6).map((evaluation) => evaluationCard(evaluation, new Map([[patient.id, patient]]))).join("") : `<div class="inline-empty"><span>Sem avaliações registadas.</span></div>`}</div></article>
      </div>
      <div class="card-stack">
        <article class="card"><header class="card__header"><div><p class="eyebrow">Pré-pagamento</p><h3>Pacotes de sessões</h3></div><button class="button button--small button--ghost" type="button" data-action="add-package" data-patient-id="${escapeHTML(patient.id)}">Adicionar</button></header><div class="card__body">${packages.length ? packages.map((item) => packageCard(item, usage)).join("") : `<div class="inline-empty"><span>Sem pacotes registados.</span></div>`}</div></article>
        <article class="card"><header class="card__header"><h3>Dados do paciente</h3></header><div class="card__body"><dl class="detail-list"><div><dt>Nascimento</dt><dd>${escapeHTML(formatDate(patient.birthDate, "Não indicado"))}</dd></div><div><dt>NIF</dt><dd>${escapeHTML(patient.nif || "Não indicado")}</dd></div><div><dt>Morada</dt><dd>${escapeHTML(patient.address || "Não indicada")}</dd></div><div><dt>Emergência</dt><dd>${escapeHTML(patient.emergencyContact || "Não indicado")}</dd></div></dl>${patient.clinicalNotes ? `<div class="clinical-note"><strong>Notas clínicas</strong><p>${escapeHTML(patient.clinicalNotes)}</p></div>` : ""}</div></article>
        <article class="card"><header class="card__header"><h3>Próximas marcações</h3></header><div class="card__body">${appointments.filter((item) => !["completed", "cancelled"].includes(item.status)).slice(0, 4).map((appointment) => `<button class="compact-record" type="button" data-action="edit-appointment" data-id="${escapeHTML(appointment.id)}"><span><strong>${escapeHTML(formatDateTime(appointment.start))}</strong><small>${escapeHTML(appointmentTypeLabel(appointment.type))}</small></span><span class="status-badge status-badge--${escapeHTML(appointment.status)}">${escapeHTML(statusLabel(appointment.status))}</span></button>`).join("") || `<div class="inline-empty"><span>Sem marcações futuras.</span></div>`}</div></article>
      </div>
    </div>
  </section>`;
}

async function renderClinic() {
  const { packages, sessions, evaluations, patients } = await loadCollections("packages", "sessions", "evaluations", "patients");
  const map = patientMap(patients);
  const packageMap = new Map(packages.map((item) => [item.id, item]));
  const usage = packageUsageMap(sessions);
  const records = state.clinicTab === "sessions" ? sortNewest(sessions) : sortNewest(evaluations);
  return `<section class="view" aria-labelledby="clinic-heading">
    <div class="view-header"><div><h2 id="clinic-heading">Registos clínicos</h2><p>Sessões, evolução e avaliações estruturadas.</p></div><button class="button button--primary" type="button" data-action="${state.clinicTab === "sessions" ? "add-session" : "add-evaluation"}">${state.clinicTab === "sessions" ? "Nova sessão" : "Nova avaliação"}</button></div>
    <div class="segmented-control clinic-tabs" role="tablist" aria-label="Tipo de registo"><button type="button" role="tab" data-action="clinic-tab" data-tab="sessions" aria-selected="${state.clinicTab === "sessions"}" class="${state.clinicTab === "sessions" ? "is-active" : ""}">Sessões <span>${sessions.length}</span></button><button type="button" role="tab" data-action="clinic-tab" data-tab="evaluations" aria-selected="${state.clinicTab === "evaluations"}" class="${state.clinicTab === "evaluations" ? "is-active" : ""}">Avaliações <span>${evaluations.length}</span></button></div>
    ${records.length ? `<div class="clinical-list">${state.clinicTab === "sessions" ? records.map((record) => sessionCard(record, map, packageMap, usage)).join("") : records.map((record) => evaluationCard(record, map)).join("")}</div>` : emptyState(state.clinicTab === "sessions" ? "Sem sessões" : "Sem avaliações", "Adicione o primeiro registo clínico.", state.clinicTab === "sessions" ? "add-session" : "add-evaluation", "Adicionar")}
  </section>`;
}

function sessionCard(session, map, packages = new Map(), usage = new Map()) {
  const packageRecord = session.packageId ? packages.get(session.packageId) : null;
  const packageMeta = packageRecord
    ? `${packageRecord.name || "Pacote"} · ${packageRemaining(packageRecord, usage)} de ${Number(packageRecord.totalSessions) || 0} disponíveis`
    : "";
  return `<article class="clinical-card card">
    <div class="clinical-card__date"><strong>${escapeHTML(String(session.date || "").slice(-2) || "—")}</strong><small>${escapeHTML(new Intl.DateTimeFormat("pt-PT", { month: "short" }).format(parseDate(session.date) || new Date()))}</small></div>
    <div class="clinical-card__main"><div class="clinical-card__heading"><button type="button" class="link-button" data-action="open-patient" data-id="${escapeHTML(session.patientId)}">${escapeHTML(patientDisplay(map, session.patientId))}</button><span class="status-badge status-badge--${session.paymentStatus === "paid" ? "paid" : session.paymentStatus === "package" ? "package" : "pending"}">${escapeHTML(statusLabel(session.paymentStatus))}</span></div><p>${escapeHTML(session.treatment || "Sessão sem descrição de tratamento")}</p><div class="clinical-card__meta"><span>Dor: ${session.painBefore ?? "—"} → ${session.painAfter ?? "—"}</span><span>${formatCurrency(session.value)}</span>${packageMeta ? `<span>${escapeHTML(packageMeta)}</span>` : ""}</div></div>
    <div class="clinical-card__actions"><button class="icon-button" type="button" data-action="edit-session" data-id="${escapeHTML(session.id)}" aria-label="Editar sessão"><svg viewBox="0 0 24 24"><path d="m4 20 4-.8L19 8.2a2 2 0 0 0-3-3L5 16.2Z" /></svg></button><button class="icon-button text-danger" type="button" data-action="delete-record" data-store="sessions" data-id="${escapeHTML(session.id)}" aria-label="Eliminar sessão"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14" /></svg></button></div>
  </article>`;
}

function packageCard(packageRecord, usage) {
  const used = usage.get(packageRecord.id) || 0;
  const remaining = packageRemaining(packageRecord, usage);
  const status = packageStatus(packageRecord, usage);
  return `<article class="package-record compact-record">
    <span><strong>${escapeHTML(packageRecord.name || `Pacote de ${packageRecord.totalSessions} sessões`)}</strong><small>${remaining} de ${Number(packageRecord.totalSessions) || 0} disponíveis · ${escapeHTML(formatCurrency(packageRecord.pricePerSession))}/sessão · ${escapeHTML(statusLabel(packageRecord.paymentStatus))}</small><span class="package-progress" aria-label="${used} de ${Number(packageRecord.totalSessions) || 0} sessões utilizadas"><i style="--package-progress:${Math.min(100, Math.round(used / Math.max(1, Number(packageRecord.totalSessions) || 1) * 100))}%"></i></span></span>
    <span class="package-record__actions"><span class="status-badge status-badge--${status}">${status === "completed" ? "Concluído" : status === "cancelled" ? "Anulado" : "Ativo"}</span><button class="icon-button" type="button" data-action="edit-package" data-id="${escapeHTML(packageRecord.id)}" aria-label="Editar pacote"><svg viewBox="0 0 24 24"><path d="m4 20 4-.8L19 8.2a2 2 0 0 0-3-3L5 16.2Z" /></svg></button><button class="icon-button text-danger" type="button" data-action="delete-record" data-store="packages" data-id="${escapeHTML(packageRecord.id)}" aria-label="Eliminar pacote"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14" /></svg></button></span>
  </article>`;
}

function evaluationCard(evaluation, map) {
  return `<article class="clinical-card card">
    <div class="clinical-card__date"><strong>${escapeHTML(String(evaluation.date || "").slice(-2) || "—")}</strong><small>${escapeHTML(new Intl.DateTimeFormat("pt-PT", { month: "short" }).format(parseDate(evaluation.date) || new Date()))}</small></div>
    <div class="clinical-card__main"><div class="clinical-card__heading"><button type="button" class="link-button" data-action="open-patient" data-id="${escapeHTML(evaluation.patientId)}">${escapeHTML(patientDisplay(map, evaluation.patientId))}</button><span class="badge badge--info">Avaliação</span></div><p>${escapeHTML(evaluation.reason || evaluation.diagnosis || "Avaliação clínica")}</p><div class="clinical-card__meta"><span>${escapeHTML(evaluation.diagnosis || "Sem diagnóstico indicado")}</span></div></div>
    <div class="clinical-card__actions"><button class="icon-button" type="button" data-action="view-evaluation" data-id="${escapeHTML(evaluation.id)}" aria-label="Ver avaliação"><svg viewBox="0 0 24 24"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="2.5" /></svg></button><button class="icon-button" type="button" data-action="edit-evaluation" data-id="${escapeHTML(evaluation.id)}" aria-label="Editar avaliação"><svg viewBox="0 0 24 24"><path d="m4 20 4-.8L19 8.2a2 2 0 0 0-3-3L5 16.2Z" /></svg></button><button class="icon-button text-danger" type="button" data-action="delete-record" data-store="evaluations" data-id="${escapeHTML(evaluation.id)}" aria-label="Eliminar avaliação"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14" /></svg></button></div>
  </article>`;
}

async function renderFinances() {
  const { transactions, patients } = await loadCollections("transactions", "patients");
  const map = patientMap(patients);
  const monthly = sortNewest(transactions.filter((item) => String(item.date || "").startsWith(state.financeMonth)));
  const active = monthly.filter((item) => item.status !== "cancelled");
  const income = sum(active.filter((item) => item.type === "income" && item.status === "paid"), (item) => item.amount);
  const expenses = sum(active.filter((item) => item.type === "expense" && item.status === "paid"), (item) => item.amount);
  const pending = sum(active.filter((item) => item.type === "income" && item.status === "pending"), (item) => item.amount);
  const balance = income - expenses;
  return `<section class="view" aria-labelledby="finances-heading">
    <div class="view-header"><div><h2 id="finances-heading">Finanças</h2><p>Visão mensal simples, sem faturação externa.</p></div><button class="button button--primary" type="button" data-action="add-transaction">Nova transação</button></div>
    <div class="month-toolbar card"><button class="icon-button" type="button" data-action="finance-prev" aria-label="Mês anterior"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg></button><label><span class="visually-hidden">Mês</span><input id="finance-month" type="month" value="${escapeHTML(state.financeMonth)}"></label><button class="icon-button" type="button" data-action="finance-next" aria-label="Mês seguinte"><svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6" /></svg></button><strong>${escapeHTML(monthLabel(state.financeMonth))}</strong></div>
    <div class="metrics-grid finance-metrics">${metricCard("Receitas", formatCurrency(income), "Recebidas", "success")}${metricCard("Despesas", formatCurrency(expenses), "Pagas", "danger")}${metricCard("Pendentes", formatCurrency(pending), "Por receber", "warning")}${metricCard("Saldo", formatCurrency(balance), "Receitas − despesas", balance >= 0 ? "success" : "danger")}</div>
    <article class="card"><header class="card__header"><div><p class="eyebrow">${escapeHTML(monthLabel(state.financeMonth))}</p><h3>Movimentos</h3></div><span class="badge">${plural(monthly.length, "movimento")}</span></header><div class="card__body card__body--flush">${monthly.length ? `<div class="transaction-list">${monthly.map((transaction) => transactionRow(transaction, map)).join("")}</div>` : `<div class="inline-empty inline-empty--roomy"><strong>Sem movimentos neste mês</strong><span>Adicione uma receita ou despesa.</span></div>`}</div></article>
  </section>`;
}

function monthLabel(month) {
  const date = parseDate(`${month}-01`);
  if (!date) return month;
  const text = new Intl.DateTimeFormat("pt-PT", { month: "long", year: "numeric" }).format(date);
  return text.charAt(0).toLocaleUpperCase("pt-PT") + text.slice(1);
}

function shiftMonth(month, amount) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(year, monthNumber - 1 + amount, 1, 12);
  return localISODate(date).slice(0, 7);
}

function transactionRow(transaction, map) {
  const automaticLabel = transaction.packageId ? "Pacote" : transaction.sessionId ? "Sessão" : "";
  return `<article class="transaction-row">
    <span class="transaction-row__icon transaction-row__icon--${escapeHTML(transaction.type)}" aria-hidden="true">${transaction.type === "expense" ? "−" : "+"}</span>
    <div class="transaction-row__main"><strong>${escapeHTML(transaction.description || transaction.category || transactionTypeLabel(transaction.type))}</strong><span>${escapeHTML(formatDate(transaction.date))}${transaction.patientId ? ` · ${escapeHTML(patientDisplay(map, transaction.patientId))}` : ""}${automaticLabel ? ` · ${automaticLabel}` : ""}</span></div>
    <div class="transaction-row__amount"><strong class="${transaction.type === "expense" ? "money--negative" : "money--positive"}">${transaction.type === "expense" ? "−" : "+"}${escapeHTML(formatCurrency(transaction.amount))}</strong><span class="status-badge status-badge--${escapeHTML(transaction.status)}">${escapeHTML(statusLabel(transaction.status))}</span></div>
    <div class="transaction-row__actions"><button class="icon-button" type="button" data-action="edit-transaction" data-id="${escapeHTML(transaction.id)}" aria-label="Editar movimento"><svg viewBox="0 0 24 24"><path d="m4 20 4-.8L19 8.2a2 2 0 0 0-3-3L5 16.2Z" /></svg></button><button class="icon-button text-danger" type="button" data-action="delete-record" data-store="transactions" data-id="${escapeHTML(transaction.id)}" aria-label="Eliminar movimento"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14" /></svg></button></div>
  </article>`;
}

function openDialog({ title, eyebrow = "", body = "", actions = "" }) {
  if (elements.dialog.open) elements.dialog.close();
  elements.dialogTitle.textContent = title;
  elements.dialogEyebrow.textContent = eyebrow;
  elements.dialogEyebrow.hidden = !eyebrow;
  elements.dialogBody.innerHTML = body;
  elements.dialogActions.innerHTML = actions;
  elements.dialog.showModal();
  requestAnimationFrame(() => {
    const first = elements.dialogBody.querySelector("input:not([type='hidden']), select, textarea, button")
      || elements.dialog.querySelector("button");
    first?.focus({ preventScroll: true });
  });
}

function closeDialog() {
  if (elements.dialog.open) elements.dialog.close();
  state.pendingBackup = null;
}

function formActions(label = "Guardar") {
  return `<button class="button button--secondary" type="button" data-action="close-dialog">Cancelar</button><button class="button button--primary" type="submit" form="entity-form">${escapeHTML(label)}</button>`;
}

async function openEntityForm(entity, id = null, defaults = {}) {
  const storeMap = { patient: "patients", appointment: "appointments", package: "packages", session: "sessions", evaluation: "evaluations", transaction: "transactions" };
  const storeName = storeMap[entity];
  const [record, patients, appointments, packages, sessions] = await Promise.all([
    id ? getById(storeName, id) : Promise.resolve(null),
    entity === "patient" ? Promise.resolve([]) : getAll("patients"),
    entity === "session" ? getAll("appointments") : Promise.resolve([]),
    entity === "session" ? getAll("packages") : Promise.resolve([]),
    ["session", "package"].includes(entity) ? getAll("sessions") : Promise.resolve([]),
  ]);
  if (id && !record) {
    showToast("O registo já não existe.", "warning");
    return;
  }
  if (entity !== "patient" && !patients.length && entity !== "transaction") {
    showToast("Crie primeiro uma ficha de paciente.", "warning");
    await openEntityForm("patient");
    return;
  }
  const value = { ...defaults, ...(record || {}) };
  const config = {
    patient: [id ? "Editar paciente" : "Novo paciente", patientForm(value)],
    appointment: [id ? "Editar marcação" : "Nova marcação", appointmentForm(value, patients)],
    package: [id ? "Editar pacote" : "Novo pacote", packageForm(value, patients, sessions, { editing: Boolean(id) })],
    session: [id ? "Editar sessão" : "Nova sessão", sessionForm(value, patients, appointments, packages, sessions)],
    evaluation: [id ? "Editar avaliação" : "Nova avaliação", evaluationForm(value, patients)],
    transaction: [id ? "Editar transação" : "Nova transação", transactionForm(value, patients)],
  }[entity];
  openDialog({
    title: config[0],
    eyebrow: id ? "Alterar registo" : "Novo registo local",
    body: `<form id="entity-form" class="entity-form" data-entity="${entity}" data-id="${escapeHTML(id || "")}" novalidate>${config[1]}<div class="form-errors" role="alert" hidden></div></form>`,
    actions: formActions(id ? "Guardar alterações" : "Guardar"),
  });
  if (entity === "session") updateSessionPackageFields();
  if (entity === "package") updatePackageTotalPreview();
}

function patientForm(patient) {
  return `<div class="form-sections"><fieldset class="form-section"><legend>Identificação</legend><div class="form-grid form-grid--two">
    <div class="field field--wide"><label for="patient-name">Nome completo *</label><input id="patient-name" name="name" required maxlength="160" autocomplete="name" value="${escapeHTML(patient.name)}"></div>
    <div class="field"><label for="patient-birth">Data de nascimento</label><input id="patient-birth" name="birthDate" type="date" value="${escapeHTML(patient.birthDate)}"></div>
    <div class="field"><label for="patient-nif">NIF</label><input id="patient-nif" name="nif" inputmode="numeric" maxlength="9" value="${escapeHTML(patient.nif)}"></div>
    <div class="field"><label for="patient-phone">Telefone</label><input id="patient-phone" name="phone" type="tel" autocomplete="tel" value="${escapeHTML(patient.phone)}"></div>
    <div class="field"><label for="patient-email">Email</label><input id="patient-email" name="email" type="email" autocomplete="email" value="${escapeHTML(patient.email)}"></div>
    <div class="field field--wide"><label for="patient-address">Morada</label><input id="patient-address" name="address" autocomplete="street-address" value="${escapeHTML(patient.address)}"></div>
    <div class="field field--wide"><label for="patient-emergency">Contacto de emergência</label><input id="patient-emergency" name="emergencyContact" value="${escapeHTML(patient.emergencyContact)}"></div>
    <label class="switch field--wide"><span>Ficha ativa</span><input name="active" type="checkbox"${checked(patient.active !== false)}></label>
  </div></fieldset><fieldset class="form-section"><legend>Informação clínica</legend><div class="field"><label for="patient-notes">Notas clínicas gerais</label><textarea id="patient-notes" name="clinicalNotes" rows="5" placeholder="Antecedentes, alertas ou observações relevantes…">${escapeHTML(patient.clinicalNotes)}</textarea><p class="field__hint">Esta informação fica apenas neste dispositivo e no backup que exportar.</p></div></fieldset></div>`;
}

function appointmentForm(appointment, patients) {
  const defaultStart = `${state.agendaDate || localISODate()}T09:00`;
  return `<div class="form-sections"><fieldset class="form-section"><legend>Marcação</legend><div class="form-grid form-grid--two">
    <div class="field field--wide"><label for="appointment-patient">Paciente *</label><select id="appointment-patient" name="patientId" required><option value="">Selecionar…</option>${patientOptions(patients, appointment.patientId)}</select></div>
    <div class="field"><label for="appointment-start">Data e hora *</label><input id="appointment-start" name="start" type="datetime-local" required value="${escapeHTML(toDateTimeLocal(appointment.start) || defaultStart)}"></div>
    <div class="field"><label for="appointment-duration">Duração (min)</label><input id="appointment-duration" name="duration" type="number" min="10" max="300" step="5" value="${escapeHTML(appointment.duration ?? 60)}"></div>
    <div class="field"><label for="appointment-type">Tipo</label><select id="appointment-type" name="type"><option value="session"${selected(appointment.type || "session", "session")}>Sessão</option><option value="assessment"${selected(appointment.type, "assessment")}>Avaliação</option><option value="followup"${selected(appointment.type, "followup")}>Reavaliação</option><option value="other"${selected(appointment.type, "other")}>Outro</option></select></div>
    <div class="field"><label for="appointment-status">Estado</label><select id="appointment-status" name="status"><option value="scheduled"${selected(appointment.status || "scheduled", "scheduled")}>Agendada</option><option value="confirmed"${selected(appointment.status, "confirmed")}>Confirmada</option><option value="completed"${selected(appointment.status, "completed")}>Concluída</option><option value="cancelled"${selected(appointment.status, "cancelled")}>Cancelada</option><option value="no_show"${selected(appointment.status, "no_show")}>Faltou</option></select></div>
    <div class="field"><label for="appointment-room">Sala/local</label><input id="appointment-room" name="room" value="${escapeHTML(appointment.room)}" placeholder="Ex.: Consultório 1"></div>
    <div class="field field--wide"><label for="appointment-notes">Notas</label><textarea id="appointment-notes" name="notes" rows="4">${escapeHTML(appointment.notes)}</textarea></div>
  </div></fieldset></div>`;
}

function packageForm(packageRecord, patients, sessions, { editing = false } = {}) {
  const used = sessions.filter((session) => session.packageId === packageRecord.id).length;
  const totalSessions = Math.max(1, Number(packageRecord.totalSessions) || 6);
  const pricePerSession = Math.max(0, Number(packageRecord.pricePerSession) || 30);
  const patientField = editing
    ? `<input type="hidden" name="patientId" value="${escapeHTML(packageRecord.patientId)}"><select id="package-patient" disabled>${patientOptions(patients, packageRecord.patientId)}</select>`
    : `<select id="package-patient" name="patientId" required><option value="">Selecionar…</option>${patientOptions(patients, packageRecord.patientId)}</select>`;
  return `<div class="form-sections"><fieldset class="form-section"><legend>Pacote de sessões</legend><div class="form-grid form-grid--two">
    <div class="field"><label for="package-patient">Paciente *</label>${patientField}</div>
    <div class="field"><label for="package-date">Data da compra *</label><input id="package-date" name="purchaseDate" type="date" required value="${escapeHTML(packageRecord.purchaseDate || localISODate())}"></div>
    <div class="field field--wide"><label for="package-name">Nome do pacote *</label><input id="package-name" name="name" required maxlength="120" value="${escapeHTML(packageRecord.name || "Pacote de fisioterapia")}" placeholder="Ex.: Pacote de 6 sessões"></div>
    <div class="field"><label for="package-sessions">Número de sessões *</label><input id="package-sessions" name="totalSessions" type="number" min="${Math.max(1, used)}" max="200" step="1" required inputmode="numeric" value="${escapeHTML(totalSessions)}">${used ? `<p class="field__hint">Já utilizadas: ${used}. O total não pode ser inferior.</p>` : ""}</div>
    <div class="field"><label for="package-price">Preço por sessão (€) *</label><input id="package-price" name="pricePerSession" type="number" min="0" step="0.01" required inputmode="decimal" value="${escapeHTML(pricePerSession)}"></div>
  </div><div class="package-total-preview"><span>Total do pacote</span><strong id="package-total-preview">${escapeHTML(formatCurrency(totalSessions * pricePerSession))}</strong></div></fieldset>
  <fieldset class="form-section"><legend>Recebimento</legend><div class="form-grid form-grid--two">
    <div class="field"><label for="package-payment">Estado</label><select id="package-payment" name="paymentStatus"><option value="paid"${selected(packageRecord.paymentStatus || "paid", "paid")}>Pago</option><option value="pending"${selected(packageRecord.paymentStatus, "pending")}>Pendente</option><option value="cancelled"${selected(packageRecord.paymentStatus, "cancelled")}>Anulado</option></select></div>
    <div class="field"><label for="package-method">Método</label><select id="package-method" name="paymentMethod"><option value=""${selected(packageRecord.paymentMethod, "")}>Não indicado</option><option value="cash"${selected(packageRecord.paymentMethod, "cash")}>Numerário</option><option value="card"${selected(packageRecord.paymentMethod, "card")}>Cartão</option><option value="transfer"${selected(packageRecord.paymentMethod, "transfer")}>Transferência</option><option value="mbway"${selected(packageRecord.paymentMethod, "mbway")}>MB WAY</option></select></div>
    <div class="field field--wide"><label for="package-notes">Notas</label><textarea id="package-notes" name="notes" rows="3" placeholder="Condições ou observações do pacote…">${escapeHTML(packageRecord.notes)}</textarea></div>
  </div><p class="form-footnote">A receita é registada uma única vez pelo valor total do pacote. As sessões utilizadas não criam novas receitas.</p></fieldset></div>`;
}

function sessionForm(session, patients, appointments, packages, sessions) {
  const selectedPatient = session.patientId || "";
  const patientNames = patientMap(patients);
  const usage = packageUsageMap(sessions.filter((item) => item.id !== session.id));
  const linkedAppointments = appointments
    .filter((appointment) => !selectedPatient || appointment.patientId === selectedPatient)
    .sort((a, b) => String(b.start).localeCompare(String(a.start)))
    .slice(0, 30)
    .map((appointment) => `<option value="${escapeHTML(appointment.id)}"${selected(appointment.id, session.appointmentId)}>${escapeHTML(`${formatDateTime(appointment.start)} — ${patientDisplay(patientNames, appointment.patientId)}`)}</option>`).join("");
  const packageOptions = sortNewest(packages, "purchaseDate").map((item) => {
    const remaining = packageRemaining(item, usage);
    const belongsToPatient = !selectedPatient || item.patientId === selectedPatient;
    const isCurrent = item.id === session.packageId;
    const disabled = (!belongsToPatient || packageStatus(item, usage) === "cancelled" || (remaining <= 0 && !isCurrent)) ? " disabled" : "";
    const patientSuffix = selectedPatient ? "" : ` — ${patientDisplay(patientNames, item.patientId)}`;
    return `<option value="${escapeHTML(item.id)}" data-patient-id="${escapeHTML(item.patientId)}" data-price="${escapeHTML(item.pricePerSession)}" data-total="${escapeHTML(item.totalSessions)}" data-remaining="${remaining}"${selected(item.id, session.packageId)}${disabled}>${escapeHTML(`${item.name || "Pacote"} — ${remaining} disponíveis${patientSuffix}`)}</option>`;
  }).join("");
  return `<div class="form-sections"><fieldset class="form-section"><legend>Sessão clínica</legend><div class="form-grid form-grid--two">
    <div class="field"><label for="session-patient">Paciente *</label><select id="session-patient" name="patientId" required><option value="">Selecionar…</option>${patientOptions(patients, selectedPatient)}</select></div>
    <div class="field"><label for="session-date">Data *</label><input id="session-date" name="date" type="date" required value="${escapeHTML(session.date || localISODate())}"></div>
    <div class="field field--wide"><label for="session-appointment">Marcação associada</label><select id="session-appointment" name="appointmentId"><option value="">Nenhuma</option>${linkedAppointments}</select></div>
    <div class="field"><label for="pain-before">Dor antes (0–10)</label><input id="pain-before" name="painBefore" type="number" min="0" max="10" step="1" value="${escapeHTML(session.painBefore ?? "")}"></div>
    <div class="field"><label for="pain-after">Dor depois (0–10)</label><input id="pain-after" name="painAfter" type="number" min="0" max="10" step="1" value="${escapeHTML(session.painAfter ?? "")}"></div>
    <div class="field field--wide"><label for="session-treatment">Tratamento realizado *</label><textarea id="session-treatment" name="treatment" rows="5" required placeholder="Técnicas, resposta e evolução…">${escapeHTML(session.treatment)}</textarea></div>
    <div class="field field--wide"><label for="session-exercises">Exercícios / plano domiciliário</label><textarea id="session-exercises" name="exercises" rows="4" placeholder="Exercícios, séries, frequência e progressões…">${escapeHTML(session.exercises)}</textarea></div>
    <div class="field field--wide"><label for="session-notes">Notas adicionais</label><textarea id="session-notes" name="notes" rows="3">${escapeHTML(session.notes)}</textarea></div>
  </div></fieldset><fieldset class="form-section"><legend>Pagamento</legend><div class="form-grid form-grid--three">
    <div class="field field--wide"><label for="session-package">Pacote</label><select id="session-package" name="packageId"><option value="">Sessão avulsa</option>${packageOptions}</select><p class="field__hint" id="session-package-hint">Escolha um pacote ativo para descontar automaticamente uma utilização.</p></div>
    <div class="field"><label for="session-value">Valor (€)</label><input id="session-value" name="value" type="number" min="0" step="0.01" inputmode="decimal" value="${escapeHTML(session.value ?? "")}"></div>
    <div class="field"><label for="session-payment">Estado</label><select id="session-payment" name="paymentStatus"><option value="pending"${selected(session.paymentStatus || "pending", "pending")}>Pendente</option><option value="paid"${selected(session.paymentStatus, "paid")}>Pago</option><option value="waived"${selected(session.paymentStatus, "waived")}>Isento</option><option value="package"${selected(session.paymentStatus, "package")}>Incluída no pacote</option></select></div>
    <div class="field"><label for="session-method">Método</label><select id="session-method" name="paymentMethod"><option value=""${selected(session.paymentMethod, "")}>Não indicado</option><option value="cash"${selected(session.paymentMethod, "cash")}>Numerário</option><option value="card"${selected(session.paymentMethod, "card")}>Cartão</option><option value="transfer"${selected(session.paymentMethod, "transfer")}>Transferência</option><option value="mbway"${selected(session.paymentMethod, "mbway")}>MB WAY</option></select></div>
  </div><p class="form-footnote">Numa sessão avulsa é criado o respetivo movimento financeiro. Numa sessão incluída num pacote é descontada uma utilização sem duplicar a receita.</p></fieldset></div>`;
}

function updatePackageTotalPreview() {
  const form = elements.dialogBody.querySelector("#entity-form[data-entity='package']");
  if (!form) return;
  const total = Math.max(0, Number(form.elements.totalSessions?.value) || 0) * Math.max(0, Number(form.elements.pricePerSession?.value) || 0);
  const output = form.querySelector("#package-total-preview");
  if (output) output.textContent = formatCurrency(total);
}

function updateSessionPackageFields() {
  const form = elements.dialogBody.querySelector("#entity-form[data-entity='session']");
  if (!form) return;
  const patientId = form.elements.patientId?.value || "";
  const packageSelect = form.elements.packageId;
  for (const option of packageSelect?.options || []) {
    if (!option.value) continue;
    const wrongPatient = Boolean(patientId && option.dataset.patientId !== patientId);
    const unavailable = Number(option.dataset.remaining) <= 0 && option.value !== packageSelect.value;
    option.disabled = wrongPatient || unavailable;
  }
  const selectedOption = packageSelect?.selectedOptions?.[0];
  const hasPackage = Boolean(selectedOption?.value && !selectedOption.disabled);
  const valueInput = form.elements.value;
  const statusSelect = form.elements.paymentStatus;
  const methodSelect = form.elements.paymentMethod;
  const hint = form.querySelector("#session-package-hint");
  if (hasPackage) {
    valueInput.value = selectedOption.dataset.price || "0";
    statusSelect.value = "package";
    methodSelect.value = "";
    valueInput.readOnly = true;
    statusSelect.disabled = true;
    methodSelect.disabled = true;
    if (hint) hint.textContent = `${selectedOption.dataset.remaining} utilização(ões) disponível(eis). Esta sessão não cria uma nova receita.`;
  } else {
    if (packageSelect?.value && selectedOption?.disabled) packageSelect.value = "";
    valueInput.readOnly = false;
    statusSelect.disabled = false;
    methodSelect.disabled = false;
    if (statusSelect.value === "package") statusSelect.value = "pending";
    if (hint) hint.textContent = "Escolha um pacote ativo para descontar automaticamente uma utilização.";
  }
}

function evaluationForm(evaluation, patients) {
  return `<div class="form-sections"><fieldset class="form-section"><legend>Identificação</legend><div class="form-grid form-grid--two">
    <div class="field"><label for="evaluation-patient">Paciente *</label><select id="evaluation-patient" name="patientId" required><option value="">Selecionar…</option>${patientOptions(patients, evaluation.patientId)}</select></div>
    <div class="field"><label for="evaluation-date">Data *</label><input id="evaluation-date" name="date" type="date" required value="${escapeHTML(evaluation.date || localISODate())}"></div>
    <div class="field field--wide"><label for="evaluation-reason">Motivo / queixa principal *</label><textarea id="evaluation-reason" name="reason" rows="3" required>${escapeHTML(evaluation.reason)}</textarea></div>
    <div class="field field--wide"><label for="evaluation-diagnosis">Diagnóstico / referência médica</label><input id="evaluation-diagnosis" name="diagnosis" value="${escapeHTML(evaluation.diagnosis)}"></div>
    <div class="field field--wide"><label for="evaluation-history">História clínica</label><textarea id="evaluation-history" name="history" rows="4">${escapeHTML(evaluation.history)}</textarea></div>
  </div></fieldset><fieldset class="form-section"><legend>Exame objetivo</legend><div class="form-grid form-grid--two">
    <div class="field"><label for="evaluation-observation">Observação</label><textarea id="evaluation-observation" name="observation" rows="4">${escapeHTML(evaluation.observation)}</textarea></div>
    <div class="field"><label for="evaluation-posture">Postura / alinhamento</label><textarea id="evaluation-posture" name="posture" rows="4">${escapeHTML(evaluation.posture)}</textarea></div>
    <div class="field"><label for="evaluation-mobility">Mobilidade / amplitudes</label><textarea id="evaluation-mobility" name="mobility" rows="4">${escapeHTML(evaluation.mobility)}</textarea></div>
    <div class="field"><label for="evaluation-strength">Força / controlo motor</label><textarea id="evaluation-strength" name="strength" rows="4">${escapeHTML(evaluation.strength)}</textarea></div>
    <div class="field field--wide"><label for="evaluation-tests">Testes especiais / medidas</label><textarea id="evaluation-tests" name="specialTests" rows="4">${escapeHTML(evaluation.specialTests)}</textarea></div>
  </div></fieldset><fieldset class="form-section"><legend>Raciocínio e plano</legend><div class="form-grid form-grid--two">
    <div class="field field--wide"><label for="evaluation-reasoning">Raciocínio clínico</label><textarea id="evaluation-reasoning" name="clinicalReasoning" rows="4">${escapeHTML(evaluation.clinicalReasoning)}</textarea></div>
    <div class="field"><label for="evaluation-goals">Objetivos</label><textarea id="evaluation-goals" name="goals" rows="4">${escapeHTML(evaluation.goals)}</textarea></div>
    <div class="field"><label for="evaluation-plan">Plano de intervenção</label><textarea id="evaluation-plan" name="plan" rows="4">${escapeHTML(evaluation.plan)}</textarea></div>
    <div class="field field--wide"><label for="evaluation-notes">Notas</label><textarea id="evaluation-notes" name="notes" rows="3">${escapeHTML(evaluation.notes)}</textarea></div>
  </div></fieldset></div>`;
}

function transactionForm(transaction, patients) {
  return `<div class="form-sections"><fieldset class="form-section"><legend>Movimento financeiro</legend><div class="form-grid form-grid--two">
    <div class="field"><label for="transaction-type">Tipo *</label><select id="transaction-type" name="type" required><option value="income"${selected(transaction.type || "income", "income")}>Receita</option><option value="expense"${selected(transaction.type, "expense")}>Despesa</option></select></div>
    <div class="field"><label for="transaction-date">Data *</label><input id="transaction-date" name="date" type="date" required value="${escapeHTML(transaction.date || localISODate())}"></div>
    <div class="field"><label for="transaction-amount">Valor (€) *</label><input id="transaction-amount" name="amount" type="number" min="0" step="0.01" required inputmode="decimal" value="${escapeHTML(transaction.amount ?? "")}"></div>
    <div class="field"><label for="transaction-status">Estado</label><select id="transaction-status" name="status"><option value="paid"${selected(transaction.status || "paid", "paid")}>Pago</option><option value="pending"${selected(transaction.status, "pending")}>Pendente</option><option value="cancelled"${selected(transaction.status, "cancelled")}>Anulado</option></select></div>
    <div class="field"><label for="transaction-category">Categoria</label><input id="transaction-category" name="category" list="transaction-categories" value="${escapeHTML(transaction.category)}" placeholder="Ex.: Sessão"><datalist id="transaction-categories"><option value="Sessão"><option value="Pacote"><option value="Avaliação"><option value="Material"><option value="Renda"><option value="Formação"><option value="Outro"></datalist></div>
    <div class="field"><label for="transaction-patient">Paciente</label><select id="transaction-patient" name="patientId">${patientOptions(patients, transaction.patientId, { allowEmpty: true })}</select></div>
    <div class="field field--wide"><label for="transaction-description">Descrição *</label><input id="transaction-description" name="description" required maxlength="220" value="${escapeHTML(transaction.description)}"></div>
    <div class="field"><label for="transaction-method">Método</label><select id="transaction-method" name="paymentMethod"><option value=""${selected(transaction.paymentMethod, "")}>Não indicado</option><option value="cash"${selected(transaction.paymentMethod, "cash")}>Numerário</option><option value="card"${selected(transaction.paymentMethod, "card")}>Cartão</option><option value="transfer"${selected(transaction.paymentMethod, "transfer")}>Transferência</option><option value="mbway"${selected(transaction.paymentMethod, "mbway")}>MB WAY</option></select></div>
    <div class="field field--wide"><label for="transaction-notes">Notas</label><textarea id="transaction-notes" name="notes" rows="3">${escapeHTML(transaction.notes)}</textarea></div>
  </div></fieldset></div>`;
}

async function saveEntityForm(form) {
  if (!form.reportValidity()) return;
  const submitButton = elements.dialogActions.querySelector("[type='submit']");
  if (submitButton) submitButton.disabled = true;
  const errors = form.querySelector(".form-errors");
  errors.hidden = true;
  try {
    const entity = form.dataset.entity;
    const id = form.dataset.id || null;
    const data = Object.fromEntries(new FormData(form).entries());
    const stores = { patient: "patients", appointment: "appointments", package: "packages", session: "sessions", evaluation: "evaluations", transaction: "transactions" };
    const store = stores[entity];
    const current = id ? await getById(store, id) : {};
    let record = { ...(current || {}), ...data };
    if (id) record.id = id;
    if (entity === "patient") record.active = form.elements.active.checked;
    if (entity === "appointment") record.duration = Math.max(10, Number(data.duration) || 60);
    if (entity === "package") {
      record.patientId = data.patientId;
      record.totalSessions = Math.max(1, Math.floor(Number(data.totalSessions) || 1));
      record.pricePerSession = Math.max(0, Number(data.pricePerSession) || 0);
      record.totalAmount = Number((record.totalSessions * record.pricePerSession).toFixed(2));
      const used = id ? (await getAll("sessions")).filter((item) => item.packageId === id).length : 0;
      if (record.totalSessions < used) throw new Error(`Este pacote já tem ${used} sessões utilizadas.`);
    }
    if (entity === "session") {
      record.painBefore = data.painBefore === "" ? null : Number(data.painBefore);
      record.painAfter = data.painAfter === "" ? null : Number(data.painAfter);
      record.appointmentId = data.appointmentId || null;
      record.packageId = data.packageId || null;
      if (record.packageId) {
        const packageRecord = await getById("packages", record.packageId);
        if (!packageRecord) throw new Error("O pacote selecionado já não existe.");
        if (packageRecord.patientId !== data.patientId) throw new Error("O pacote selecionado pertence a outro paciente.");
        if (packageRecord.paymentStatus === "cancelled") throw new Error("O pacote selecionado está anulado.");
        const used = (await getAll("sessions")).filter((item) => item.packageId === record.packageId && item.id !== id).length;
        if (used >= Number(packageRecord.totalSessions)) throw new Error("Este pacote já não tem sessões disponíveis.");
        record.value = Math.max(0, Number(packageRecord.pricePerSession) || 0);
        record.paymentStatus = "package";
        record.paymentMethod = "";
      } else {
        record.value = Math.max(0, Number(data.value) || 0);
        record.paymentStatus = data.paymentStatus || "pending";
        record.paymentMethod = data.paymentMethod || "";
      }
    }
    if (entity === "transaction") {
      record.amount = Math.abs(Number(data.amount) || 0);
      record.patientId = data.patientId || null;
    }
    const saved = await upsert(store, record);
    if (entity === "package") await syncPackageTransaction(saved);
    if (entity === "session") await syncSessionTransaction(saved);
    closeDialog();
    showToast(id ? "Alterações guardadas." : "Registo criado.", "success");
    await renderCurrentView();
  } catch (error) {
    console.error(error);
    errors.textContent = error.message || "Não foi possível guardar o registo.";
    errors.hidden = false;
    errors.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

async function syncSessionTransaction(session) {
  const transactionId = `txn_${session.id}`;
  const amount = Number(session.value) || 0;
  if (session.packageId || amount <= 0 || session.paymentStatus === "waived") {
    await remove("transactions", transactionId);
    return;
  }
  const existing = await getById("transactions", transactionId);
  await upsert("transactions", {
    ...(existing || {}),
    id: transactionId,
    patientId: session.patientId,
    sessionId: session.id,
    date: session.date,
    type: "income",
    category: "Sessão",
    description: "Sessão de fisioterapia",
    amount,
    status: session.paymentStatus === "paid" ? "paid" : "pending",
    paymentMethod: session.paymentMethod || "",
    automatic: true,
  });
}

async function syncPackageTransaction(packageRecord) {
  const transactionId = `txn_pkg_${packageRecord.id}`;
  const amount = Number(packageRecord.totalAmount) || (Number(packageRecord.totalSessions) || 0) * (Number(packageRecord.pricePerSession) || 0);
  if (amount <= 0 || packageRecord.paymentStatus === "cancelled") {
    await remove("transactions", transactionId);
    return;
  }
  const existing = await getById("transactions", transactionId);
  await upsert("transactions", {
    ...(existing || {}),
    id: transactionId,
    patientId: packageRecord.patientId,
    packageId: packageRecord.id,
    sessionId: null,
    date: packageRecord.purchaseDate,
    type: "income",
    category: "Pacote",
    description: packageRecord.name || `Pacote de ${packageRecord.totalSessions} sessões`,
    amount: Number(amount.toFixed(2)),
    status: packageRecord.paymentStatus === "paid" ? "paid" : "pending",
    paymentMethod: packageRecord.paymentMethod || "",
    automatic: true,
  });
}

async function confirmAction({ title = "Confirmar ação", message, confirmLabel = "Confirmar", danger = true }) {
  if (elements.confirmDialog.open) elements.confirmDialog.close("cancel");
  elements.confirmDialog.returnValue = "";
  elements.confirmTitle.textContent = title;
  elements.confirmMessage.textContent = message;
  const button = elements.confirmDialog.querySelector("[value='confirm']");
  button.textContent = confirmLabel;
  button.className = `button ${danger ? "button--danger" : "button--primary"}`;
  elements.confirmDialog.showModal();
  return new Promise((resolve) => {
    elements.confirmDialog.addEventListener("close", () => resolve(elements.confirmDialog.returnValue === "confirm"), { once: true });
  });
}

function showToast(message, type = "info", duration = 4200) {
  for (const existing of elements.toastRegion.querySelectorAll(".toast")) {
    if (existing.querySelector(".toast__message")?.textContent === message) existing.remove();
  }
  while (elements.toastRegion.children.length >= 3) {
    elements.toastRegion.firstElementChild?.remove();
  }
  const toast = document.createElement("div");
  toast.className = `toast toast--${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  toast.innerHTML = `<span class="toast__icon" aria-hidden="true">${type === "success" ? "✓" : type === "error" ? "!" : "i"}</span><span class="toast__message">${escapeHTML(message)}</span><button class="toast__close" type="button" aria-label="Fechar">×</button>`;
  const close = () => toast.remove();
  toast.querySelector("button").addEventListener("click", close);
  elements.toastRegion.append(toast);
  setTimeout(close, duration);
}

async function deleteRecord(store, id) {
  if (store === "packages") {
    const used = (await getAll("sessions")).filter((item) => item.packageId === id).length;
    if (used > 0) {
      showToast(`Este pacote já tem ${used} sessão(ões) utilizada(s). Pode editá-lo, mas não eliminá-lo.`, "warning", 6500);
      return;
    }
  }
  const label = STORE_LABELS[store]?.toLocaleLowerCase("pt-PT") || "registo";
  const confirmed = await confirmAction({ title: "Eliminar registo?", message: `Esta ação elimina o registo de ${label} deste dispositivo.`, confirmLabel: "Eliminar" });
  if (!confirmed) return;
  if (store === "sessions") await remove("transactions", `txn_${id}`);
  if (store === "packages") await remove("transactions", `txn_pkg_${id}`);
  const removed = await remove(store, id);
  showToast(removed ? "Registo eliminado." : "O registo já não existia.", removed ? "success" : "warning");
  await renderCurrentView();
}

async function removePatientRecord(id) {
  const patient = await getById("patients", id);
  if (!patient) return;
  const confirmed = await confirmAction({ title: `Eliminar ${patient.name}?`, message: "A ficha, marcações, sessões, avaliações e transações associadas serão eliminadas deste dispositivo.", confirmLabel: "Eliminar tudo" });
  if (!confirmed) return;
  const result = await deletePatient(id, { cascade: true });
  state.patientId = null;
  showToast(result.found ? "Ficha e registos associados eliminados." : "A ficha já não existia.", "success");
  await renderCurrentView();
}

async function viewEvaluation(id) {
  const [evaluation, patients] = await Promise.all([getById("evaluations", id), getAll("patients")]);
  if (!evaluation) return showToast("A avaliação já não existe.", "warning");
  const patient = patientMap(patients).get(evaluation.patientId);
  const fields = [
    ["Motivo", evaluation.reason], ["Diagnóstico", evaluation.diagnosis], ["História clínica", evaluation.history],
    ["Observação", evaluation.observation], ["Postura", evaluation.posture], ["Mobilidade", evaluation.mobility],
    ["Força / controlo motor", evaluation.strength], ["Testes especiais", evaluation.specialTests],
    ["Raciocínio clínico", evaluation.clinicalReasoning], ["Objetivos", evaluation.goals],
    ["Plano de intervenção", evaluation.plan], ["Notas", evaluation.notes],
  ].filter(([, value]) => value);
  openDialog({
    title: `Avaliação · ${patient?.name || "Paciente"}`,
    eyebrow: formatDate(evaluation.date),
    body: `<div class="evaluation-readout">${fields.map(([label, value]) => `<section><h3>${escapeHTML(label)}</h3><p>${escapeHTML(value).replaceAll("\n", "<br>")}</p></section>`).join("") || `<p class="muted">Sem detalhe clínico.</p>`}</div>`,
    actions: `<button class="button button--secondary" type="button" data-action="close-dialog">Fechar</button><button class="button button--primary" type="button" data-action="edit-evaluation" data-id="${escapeHTML(id)}">Editar</button>`,
  });
}

async function openBackupDialog() {
  const lastBackupAt = await getSetting("lastBackupAt", null);
  state.pendingBackup = null;
  openDialog({
    title: "Backup e restauro",
    eyebrow: "Cópia integral dos dados",
    body: `<div class="backup-layout">
      <section class="backup-panel backup-panel--export"><div class="backup-panel__icon" aria-hidden="true">↓</div><div><h3>Exportar backup</h3><p>Guarda pacientes, agenda, pacotes, sessões, avaliações, finanças e definições num único ficheiro JSON.</p>${lastBackupAt ? `<small>Último backup: ${escapeHTML(formatDateTime(lastBackupAt))}</small>` : `<small>Ainda não foi criado nenhum backup.</small>`}</div><button class="button button--primary" type="button" data-action="export-backup">Partilhar ou guardar</button></section>
      <section class="backup-panel"><div class="backup-panel__icon" aria-hidden="true">X</div><div><h3>Exportar para Excel</h3><p>Cria um ficheiro XLSX para consulta, filtros e impressão, com folhas separadas para todos os registos.</p><small>O Excel não substitui o backup JSON.</small></div><button class="button button--secondary" type="button" data-action="export-excel">Criar Excel</button></section>
      <section class="backup-panel"><div class="backup-panel__icon" aria-hidden="true">↑</div><div><h3>Importar / restaurar</h3><p>Selecione um backup FISIO IF. O ficheiro é validado antes de qualquer alteração.</p></div><label class="file-picker"><span>Selecionar ficheiro JSON</span><input id="backup-file" type="file" accept="application/json,.json"></label><button class="button button--secondary" type="button" data-action="validate-backup-file">Validar ficheiro</button><div id="backup-validation" class="validation-report" aria-live="polite"></div>
        <fieldset class="restore-options"><legend>Modo de restauro</legend><label class="radio"><input type="radio" name="restore-mode" value="replace" checked><span><strong>Substituir</strong><small>Repõe exatamente o conteúdo do backup.</small></span></label><label class="radio"><input type="radio" name="restore-mode" value="merge"><span><strong>Combinar</strong><small>Junta registos e mantém a versão mais recente.</small></span></label></fieldset>
        <button class="button button--danger button--block" id="restore-backup-button" type="button" data-action="restore-backup" disabled>Restaurar backup validado</button>
      </section>
    </div>`,
    actions: `<button class="button button--secondary" type="button" data-action="close-dialog">Fechar</button>`,
  });
}

async function exportBackup() {
  const button = elements.dialog.querySelector("[data-action='export-backup']");
  if (button) { button.disabled = true; button.textContent = "A preparar…"; }
  try {
    const backup = await createBackup({ appVersion: APP_VERSION });
    const result = await shareOrDownloadBackup({ backup, preferShare: true });
    if (!result.ok && result.method === "cancelled") return;
    await setSetting("lastBackupAt", new Date().toISOString());
    showToast(result.method === "share" ? "Backup partilhado." : "Backup guardado.", "success");
    closeDialog();
    await renderCurrentView();
  } catch (error) {
    console.error(error);
    showToast(error.message || "Não foi possível criar o backup.", "error", 6500);
  } finally {
    if (button) { button.disabled = false; button.textContent = "Partilhar ou guardar"; }
  }
}

async function exportExcel() {
  const button = elements.dialog.querySelector("[data-action='export-excel']");
  if (button) button.disabled = true;
  try {
    const result = await shareOrDownloadExcel({ data: await readAllData() });
    if (result.ok) showToast("Ficheiro Excel criado.", "success");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Não foi possível criar o ficheiro Excel.", "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function validateSelectedBackup() {
  const input = elements.dialog.querySelector("#backup-file");
  const reportElement = elements.dialog.querySelector("#backup-validation");
  const restoreButton = elements.dialog.querySelector("#restore-backup-button");
  const file = input?.files?.[0];
  if (!file) return showToast("Selecione primeiro um ficheiro JSON.", "warning");
  reportElement.innerHTML = `<p class="muted">A validar integridade e relações…</p>`;
  restoreButton.disabled = true;
  state.pendingBackup = null;
  try {
    const parsed = await parseBackup(file);
    const report = await validateBackup(parsed);
    if (!report.valid) {
      reportElement.innerHTML = `<div class="validation-report__error"><strong>O backup não é válido.</strong><ul>${report.errors.map((error) => `<li>${escapeHTML(error)}</li>`).join("")}</ul></div>`;
      return;
    }
    state.pendingBackup = report.backup;
    const counts = report.summary.counts;
    reportElement.innerHTML = `<div class="validation-report__success"><strong>Backup válido</strong><p>${escapeHTML(formatDateTime(report.summary.createdAt))} · ${plural(report.summary.totalRecords, "registo")}</p><div class="backup-counts">${STORE_NAMES.filter((name) => name !== "settings").map((name) => `<span>${escapeHTML(STORE_LABELS[name])}: <strong>${counts[name]}</strong></span>`).join("")}</div>${report.warnings.length ? `<details><summary>${plural(report.warnings.length, "aviso")}</summary><ul>${report.warnings.map((warning) => `<li>${escapeHTML(warning)}</li>`).join("")}</ul></details>` : ""}</div>`;
    restoreButton.disabled = false;
  } catch (error) {
    console.error(error);
    reportElement.innerHTML = `<div class="validation-report__error"><strong>Não foi possível validar.</strong><p>${escapeHTML(error.message)}</p></div>`;
  }
}

async function restoreSelectedBackup() {
  if (!state.pendingBackup) return showToast("Valide primeiro o ficheiro.", "warning");
  const mode = elements.dialog.querySelector("input[name='restore-mode']:checked")?.value || "replace";
  const confirmed = await confirmAction({
    title: mode === "replace" ? "Substituir todos os dados?" : "Combinar os dados?",
    message: mode === "replace" ? "Os dados atuais serão substituídos integralmente pelo backup selecionado. Esta ação não pode ser anulada." : "Os dados do backup serão combinados com os atuais; em conflito, prevalece a versão mais recente.",
    confirmLabel: mode === "replace" ? "Substituir e restaurar" : "Combinar e restaurar",
  });
  if (!confirmed) return;
  const button = elements.dialog.querySelector("#restore-backup-button");
  if (button) { button.disabled = true; button.textContent = "A restaurar…"; }
  try {
    const result = await restoreBackup(state.pendingBackup, { mode, conflict: "newer" });
    closeDialog();
    state.patientId = null;
    await applySavedTheme();
    showToast(`Restauro concluído: ${result.totals.inserted + result.totals.updated} registos aplicados.`, "success", 6500);
    await renderCurrentView({ showLoading: true });
  } catch (error) {
    console.error(error);
    showToast(error.message || "O restauro falhou sem alterar os dados.", "error", 8000);
    if (button) { button.disabled = false; button.textContent = "Restaurar backup validado"; }
  }
}

async function openSettingsDialog() {
  const [theme, reminderDays, lastBackupAt] = await Promise.all([
    getSetting("theme", "auto"),
    getSetting("backupReminderDays", 14),
    getSetting("lastBackupAt", null),
  ]);
  const storageText = state.storagePersistent === true ? "Armazenamento persistente ativo" : state.storagePersistent === false ? "Persistência ainda não concedida" : "Estado não disponível";
  openDialog({
    title: "Definições",
    eyebrow: "Aplicação local",
    body: `<div class="settings-list">
      <section class="settings-section"><div><h3>Aparência</h3><p>Escolha o tema da aplicação neste dispositivo.</p></div><label class="compact-select"><span>Tema</span><select id="theme-select"><option value="auto"${selected(theme, "auto")}>Automático</option><option value="light"${selected(theme, "light")}>Claro</option><option value="dark"${selected(theme, "dark")}>Escuro</option></select></label></section>
      <section class="settings-section"><div><h3>Proteção do armazenamento</h3><p id="storage-status">${escapeHTML(storageText)}. O pedido reduz o risco de o navegador libertar dados locais automaticamente.</p></div><button class="button button--secondary" type="button" data-action="request-storage">Pedir persistência</button></section>
      <section class="settings-section"><div><h3>Lembrete de backup</h3><p>${lastBackupAt ? `Último backup em ${escapeHTML(formatDateTime(lastBackupAt))}.` : "Ainda não existe um backup."}</p></div><label class="compact-select"><span>Lembrar após</span><select id="backup-reminder"><option value="7"${selected(reminderDays, 7)}>7 dias</option><option value="14"${selected(reminderDays, 14)}>14 dias</option><option value="30"${selected(reminderDays, 30)}>30 dias</option><option value="90"${selected(reminderDays, 90)}>90 dias</option></select></label><button class="button button--secondary" type="button" data-action="open-backup">Abrir backup</button></section>
      <section class="settings-section"><div><h3>Dados de demonstração</h3><p>Adiciona pacientes e registos fictícios para testar a aplicação.</p></div><button class="button button--secondary" type="button" data-action="create-demo">Adicionar demonstração</button></section>
      <section class="settings-section settings-section--danger"><div><h3>Apagar todos os dados</h3><p>Remove definitivamente dados clínicos e preferências deste dispositivo. Exige duas confirmações.</p></div><button class="button button--danger" type="button" data-action="clear-all-data">Apagar tudo</button></section>
      <footer class="about-app"><strong>FISIO IF ${APP_VERSION}</strong><span>Offline · sem conta · sem sincronização · sem custos de serviço</span></footer>
    </div>`,
    actions: `<button class="button button--primary" type="button" data-action="close-dialog">Concluído</button>`,
  });
}

async function requestPersistentStorage({ quiet = false } = {}) {
  if (!navigator.storage?.persist || !navigator.storage?.persisted) {
    state.storagePersistent = null;
    if (!quiet) showToast("Este navegador não disponibiliza o pedido de persistência.", "warning");
    return null;
  }
  try {
    state.storagePersistent = await navigator.storage.persisted();
    if (!state.storagePersistent) state.storagePersistent = await navigator.storage.persist();
    if (!quiet) showToast(state.storagePersistent ? "Armazenamento persistente ativo." : "O navegador não concedeu persistência; mantenha backups regulares.", state.storagePersistent ? "success" : "warning", 6500);
    const status = elements.dialog.querySelector("#storage-status");
    if (status) status.textContent = state.storagePersistent ? "Armazenamento persistente ativo." : "Persistência não concedida. Mantenha backups regulares.";
    return state.storagePersistent;
  } catch (error) {
    console.error(error);
    state.storagePersistent = false;
    if (!quiet) showToast("Não foi possível pedir persistência de armazenamento.", "warning");
    return false;
  }
}

async function applySavedTheme() {
  const theme = await getSetting("theme", "auto");
  document.documentElement.dataset.theme = ["light", "dark"].includes(theme) ? theme : "auto";
}

async function createDemoData() {
  const existing = (await Promise.all([getAll("patients"), getAll("appointments"), getAll("sessions")])).some((records) => records.length);
  if (existing) {
    const confirmed = await confirmAction({ title: "Adicionar demonstração?", message: "Os registos fictícios serão adicionados aos dados atuais e ficam identificados pelos nomes de exemplo.", confirmLabel: "Adicionar", danger: false });
    if (!confirmed) return;
  }
  const today = localISODate();
  const patients = [
    { id: "demo_pat_ana", name: "Ana Martins (demonstração)", birthDate: "1989-04-14", phone: "910 000 101", email: "ana.exemplo@local.invalid", active: true, clinicalNotes: "Exemplo: lombalgia mecânica, sem sinais de alarme.", isDemo: true },
    { id: "demo_pat_joao", name: "João Silva (demonstração)", birthDate: "1976-09-02", phone: "910 000 202", active: true, clinicalNotes: "Exemplo: pós-operatório do joelho direito.", isDemo: true },
    { id: "demo_pat_beatriz", name: "Beatriz Costa (demonstração)", birthDate: "1997-12-21", phone: "910 000 303", active: true, isDemo: true },
  ];
  for (const patient of patients) await upsert("patients", patient);
  await upsert("appointments", { id: "demo_app_ana", patientId: patients[0].id, start: `${today}T10:00`, duration: 60, type: "session", status: "confirmed", room: "Consultório 1", isDemo: true });
  await upsert("appointments", { id: "demo_app_beatriz", patientId: patients[2].id, start: `${addDays(today, 1)}T15:30`, duration: 60, type: "assessment", status: "scheduled", isDemo: true });
  const session = await upsert("sessions", { id: "demo_ses_joao", patientId: patients[1].id, date: addDays(today, -2), painBefore: 5, painAfter: 2, treatment: "Mobilização, exercício terapêutico e educação.", exercises: "Agachamento assistido: 3 × 10.", value: 45, paymentStatus: "paid", paymentMethod: "card", isDemo: true });
  await syncSessionTransaction(session);
  await upsert("evaluations", { id: "demo_eva_ana", patientId: patients[0].id, date: addDays(today, -7), reason: "Dor lombar ao permanecer sentada.", diagnosis: "Lombalgia mecânica inespecífica", observation: "Sem sinais neurológicos.", mobility: "Flexão lombar limitada por dor.", goals: "Reduzir dor e retomar exercício.", plan: "Educação, controlo motor e progressão de carga.", isDemo: true });
  await upsert("transactions", { id: "demo_tx_expense", patientId: null, date: today, type: "expense", category: "Material", description: "Material clínico (demonstração)", amount: 18.5, status: "paid", paymentMethod: "card", isDemo: true });
  await setSetting("demoLoadedAt", new Date().toISOString());
  closeDialog();
  showToast("Dados de demonstração adicionados.", "success");
  await renderCurrentView({ showLoading: true });
}

async function clearEverything() {
  const first = await confirmAction({ title: "Apagar todos os dados?", message: "Serão removidos pacientes, agenda, sessões, avaliações, finanças e definições deste dispositivo.", confirmLabel: "Continuar" });
  if (!first) return;
  const second = await confirmAction({ title: "Confirmação final", message: "Esta operação é definitiva. Se precisar dos dados, cancele agora e crie primeiro um backup.", confirmLabel: "Apagar definitivamente" });
  if (!second) return;
  await clearAllData({ preserveSettings: false });
  state.patientId = null;
  state.view = "dashboard";
  closeDialog();
  document.documentElement.dataset.theme = "auto";
  showToast("Todos os dados foram apagados.", "success");
  await renderCurrentView({ showLoading: true });
}

function updateConnectionContext() {
  if (state.patientId && state.view === "patients") return;
  const meta = VIEW_META[state.view];
  elements.headerContext.textContent = navigator.onLine ? meta.context : `Offline · ${meta.context}`;
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

function showInstallBanner() {
  if (isStandalone() || localStorage.getItem("fisio-if-install-dismissed") === "1") return;
  elements.installBanner.hidden = false;
  if (isIOS() && !state.installPrompt) {
    elements.installBanner.querySelector(".system-banner__copy span").textContent = "No iPhone: Partilhar → Adicionar ao ecrã principal.";
    elements.installBanner.querySelector("[data-action='install-app']").textContent = "Como instalar";
  }
}

async function installApp() {
  if (state.installPrompt) {
    state.installPrompt.prompt();
    const choice = await state.installPrompt.userChoice;
    state.installPrompt = null;
    elements.installBanner.hidden = true;
    if (choice.outcome === "accepted") showToast("Instalação iniciada.", "success");
    return;
  }
  openDialog({
    title: "Instalar no iPhone ou iPad",
    eyebrow: "Safari",
    body: `<div class="install-steps"><ol><li>Abra esta página no <strong>Safari</strong>.</li><li>Toque no botão <strong>Partilhar</strong> da barra do Safari.</li><li>Escolha <strong>Adicionar ao ecrã principal</strong>.</li><li>Confirme em <strong>Adicionar</strong>.</li></ol><p class="notice-inline">Depois de abrir uma vez com internet, a aplicação e os dados ficam disponíveis offline neste dispositivo.</p></div>`,
    actions: `<button class="button button--primary" type="button" data-action="close-dialog">Entendi</button>`,
  });
}

async function setupServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register("./sw.js");
    state.serviceWorkerRegistration = registration;
    if (registration.waiting) announceUpdate(registration.waiting);
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) announceUpdate(worker);
      });
    });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (state.reloadingForUpdate) return;
      state.reloadingForUpdate = true;
      window.location.reload();
    });
  } catch (error) {
    console.warn("Service worker indisponível:", error);
  }
}

function announceUpdate(worker) {
  state.updateWorker = worker;
  elements.updateBanner.hidden = false;
}

function applyUpdate() {
  const worker = state.updateWorker || state.serviceWorkerRegistration?.waiting;
  if (!worker) return showToast("A atualização já não está pendente.", "warning");
  elements.updateBanner.querySelector("[data-action='apply-update']").disabled = true;
  worker.postMessage({ type: "SKIP_WAITING" });
}

async function handleAction(button) {
  const action = button.dataset.action;
  const patientId = button.dataset.patientId || state.patientId || "";
  switch (action) {
    case "close-dialog": closeDialog(); break;
    case "cancel-confirm": elements.confirmDialog.close("cancel"); break;
    case "accept-confirm": elements.confirmDialog.close("confirm"); break;
    case "retry-render": await renderCurrentView({ showLoading: true }); break;
    case "go-view": await navigate(button.dataset.targetView); break;
    case "add-patient": await openEntityForm("patient"); break;
    case "edit-patient": await openEntityForm("patient", button.dataset.id); break;
    case "open-patient":
      if (!button.dataset.id) break;
      closeDialog(); state.view = "patients"; state.patientId = button.dataset.id; await renderCurrentView({ focus: true, showLoading: true }); break;
    case "back-to-patients": state.patientId = null; await renderCurrentView({ focus: true }); break;
    case "delete-patient": await removePatientRecord(button.dataset.id); break;
    case "add-appointment": await openEntityForm("appointment", null, { patientId, start: `${state.agendaDate || localISODate()}T09:00` }); break;
    case "edit-appointment": await openEntityForm("appointment", button.dataset.id); break;
    case "add-package": await openEntityForm("package", null, { patientId, purchaseDate: localISODate(), totalSessions: 6, pricePerSession: 30, paymentStatus: "paid" }); break;
    case "edit-package": await openEntityForm("package", button.dataset.id); break;
    case "add-session": await openEntityForm("session", null, { patientId, date: localISODate() }); break;
    case "edit-session": await openEntityForm("session", button.dataset.id); break;
    case "add-evaluation": await openEntityForm("evaluation", null, { patientId, date: localISODate() }); break;
    case "edit-evaluation": await openEntityForm("evaluation", button.dataset.id); break;
    case "view-evaluation": await viewEvaluation(button.dataset.id); break;
    case "add-transaction": await openEntityForm("transaction", null, { patientId, date: localISODate(), type: "income", status: "paid" }); break;
    case "edit-transaction": await openEntityForm("transaction", button.dataset.id); break;
    case "delete-record": await deleteRecord(button.dataset.store, button.dataset.id); break;
    case "complete-appointment": await completeAppointment(button.dataset.id); break;
    case "agenda-prev": state.agendaDate = addDays(state.agendaDate, -1); await renderCurrentView(); break;
    case "agenda-next": state.agendaDate = addDays(state.agendaDate, 1); await renderCurrentView(); break;
    case "agenda-today": state.agendaDate = localISODate(); await renderCurrentView(); break;
    case "agenda-day": state.agendaDate = button.dataset.date; await renderCurrentView(); break;
    case "clinic-tab": state.clinicTab = button.dataset.tab; await renderCurrentView(); break;
    case "finance-prev": state.financeMonth = shiftMonth(state.financeMonth, -1); await renderCurrentView(); break;
    case "finance-next": state.financeMonth = shiftMonth(state.financeMonth, 1); await renderCurrentView(); break;
    case "open-backup": case "backup": await openBackupDialog(); break;
    case "settings": await openSettingsDialog(); break;
    case "export-backup": await exportBackup(); break;
    case "export-excel": await exportExcel(); break;
    case "validate-backup-file": await validateSelectedBackup(); break;
    case "restore-backup": await restoreSelectedBackup(); break;
    case "request-storage": await requestPersistentStorage(); break;
    case "create-demo": await createDemoData(); break;
    case "clear-all-data": await clearEverything(); break;
    case "install-app": await installApp(); break;
    case "dismiss-install": elements.installBanner.hidden = true; localStorage.setItem("fisio-if-install-dismissed", "1"); break;
    case "apply-update": applyUpdate(); break;
    case "dismiss-update": elements.updateBanner.hidden = true; break;
    default: break;
  }
}

async function completeAppointment(id) {
  const appointment = await getById("appointments", id);
  if (!appointment) return showToast("A marcação já não existe.", "warning");
  await upsert("appointments", { ...appointment, status: "completed" });
  await renderCurrentView();
  const createSession = await confirmAction({ title: "Marcação concluída", message: "Quer registar agora a sessão clínica e o respetivo pagamento?", confirmLabel: "Criar sessão", danger: false });
  if (createSession) await openEntityForm("session", null, { patientId: appointment.patientId, appointmentId: appointment.id, date: String(appointment.start).slice(0, 10) });
}

async function navigate(view) {
  if (!VALID_VIEWS.has(view)) return;
  state.view = view;
  state.patientId = null;
  await renderCurrentView({ focus: true, showLoading: true });
}

function bindEvents() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event;
    showInstallBanner();
  });
  window.addEventListener("appinstalled", () => {
    elements.installBanner.hidden = true;
    state.installPrompt = null;
    showToast("FISIO IF instalada.", "success");
  });
  window.addEventListener("online", updateConnectionContext);
  window.addEventListener("offline", updateConnectionContext);

  document.addEventListener("click", async (event) => {
    const navButton = event.target.closest("#primary-nav [data-view]");
    if (navButton) {
      event.preventDefault();
      await navigate(navButton.dataset.view);
      return;
    }
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    event.preventDefault();
    try { await handleAction(button); }
    catch (error) {
      console.error(error);
      showToast(error.message || "A operação não foi concluída.", "error", 6500);
    }
  });

  elements.dialogBody.addEventListener("submit", async (event) => {
    const form = event.target.closest("#entity-form");
    if (!form) return;
    event.preventDefault();
    await saveEntityForm(form);
  });

  elements.dialogBody.addEventListener("input", (event) => {
    if (["package-sessions", "package-price"].includes(event.target.id)) updatePackageTotalPreview();
  });

  elements.dialogBody.addEventListener("change", (event) => {
    if (["session-patient", "session-package"].includes(event.target.id)) updateSessionPackageFields();
  });

  elements.viewRoot.addEventListener("input", (event) => {
    if (event.target.id !== "patient-search") return;
    const query = normaliseSearch(event.target.value);
    let visible = 0;
    elements.viewRoot.querySelectorAll(".patient-row").forEach((row) => {
      const matches = !query || row.dataset.search.includes(query);
      row.hidden = !matches;
      if (matches) visible += 1;
    });
    const empty = elements.viewRoot.querySelector("#patient-filter-empty");
    if (empty) empty.hidden = visible > 0;
  });

  document.addEventListener("change", async (event) => {
    if (event.target.id === "agenda-date") {
      state.agendaDate = event.target.value || localISODate();
      await renderCurrentView();
    } else if (event.target.id === "agenda-status") {
      state.agendaStatus = event.target.value;
      await renderCurrentView();
    } else if (event.target.id === "finance-month") {
      state.financeMonth = event.target.value || localISODate().slice(0, 7);
      await renderCurrentView();
    } else if (event.target.id === "theme-select") {
      const theme = event.target.value;
      await setSetting("theme", theme);
      document.documentElement.dataset.theme = theme;
    } else if (event.target.id === "backup-reminder") {
      await setSetting("backupReminderDays", Number(event.target.value));
      showToast("Lembrete de backup atualizado.", "success");
    }
  });

  elements.dialog.addEventListener("click", (event) => {
    if (event.target === elements.dialog) closeDialog();
  });
}

async function boot() {
  bindEvents();
  try {
    await initDB();
    await applySavedTheme();
    await Promise.all([requestPersistentStorage({ quiet: true }), setupServiceWorker()]);
    await renderCurrentView({ showLoading: true });
    updateConnectionContext();
    if (isIOS() && !isStandalone()) setTimeout(showInstallBanner, 1600);
  } catch (error) {
    console.error(error);
    elements.viewRoot.innerHTML = `<section class="view">${emptyState("Não foi possível abrir o armazenamento local", error.message || "Verifique as definições do navegador e volte a tentar.", "retry-render", "Tentar novamente")}</section>`;
    showToast(error.message || "Falha ao iniciar a aplicação.", "error", 10_000);
  }
}

boot();


