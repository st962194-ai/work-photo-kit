import {
  filterTodaySend,
  completionRate,
  todayYmd,
  isTodaySend,
  BUSINESS_TIME_ZONE,
} from "./filter.js";
import {
  LINE_CANVAS_MAX_WIDTH,
  LINE_CANVAS_MAX_HEIGHT,
  LINE_CANVAS_MAX_PIXELS,
  LINE_ALBUM_MAX_POINTS,
  LINE_HEADER_H,
  LINE_FOOTER_H,
  LINE_POINT_NAME_H,
  LINE_LABEL_BAND_H,
  LINE_POINT_IMAGE_H,
  LINE_POINT_GAP,
  EXCLUDED_LINE_H,
  EXCLUDED_HEADER_H,
  safeFilePart,
  lineAlbumFilename as lineAlbumFilenamePure,
  estimatePointBlockHeight,
  splitIncludedPoints,
  planLineAlbumPartsFromChunks,
  analyzeJobAlbumPointsFromPoints,
  planExcludedDisplay,
  resolveAlbumCanvasHeight,
  buildLineImageHeaderTexts,
  buildAlbumContentFingerprint,
  validateLineAlbumMessage,
  isAlbumShareEnabled,
  albumPreviewStatusLabel,
  LINE_MESSAGE_MAX_CHARS,
  LINE_POINT_COL_GAP,
} from "./lineAlbumLogic.js?v=20260601-01";

const APP_BUILD = globalThis.R1A_BUILD || "20260601-01";
const CUSTOMER_NAME_INPUT_PLACEHOLDER = "お客様名を入力";
const CUSTOMER_NAME_PLACEHOLDER_TOKENS = ["お客様名を入力", "お客様名未入力"];
const STORAGE_KEY = "photo_r1a_phase0";
const TRIAL_JOB_ID = "sample-001";
const SAMPLE_URL = "./data/dummy_jobs_phase0.json";
const MAX_PHASE0_JOBS = 30;
const MANUAL_JOB_SEQ_STORAGE_KEY = "photo_r1a_manual_job_seq_v1";
const PHOTO_DB_NAME = "photo_r1a_trial_photos";
const PHOTO_STORE = "photos";
const PHOTO_MAX_EDGE = 1280;
const PHOTO_JPEG_QUALITY = 0.82;
const PHOTO_MAX_INPUT_BYTES = 15 * 1024 * 1024;
const PHOTO_MAX_PIXELS = 24_000_000;
const LINE_TARGET_BYTES = 4 * 1024 * 1024;
const LINE_JPEG_QUALITIES = [0.9, 0.82, 0.74, 0.66, 0.58, 0.5];
const LABEL_BEFORE_BG = "#ffffff";
const LABEL_BEFORE_TEXT = "#1565C0";
const LABEL_AFTER_BG = "#1565C0";
const LABEL_AFTER_TEXT = "#ffffff";
const CANVAS_FILL = "#eef2f6";
const BETA_LOCAL_STORAGE_LABEL = "端末内";
const DEFAULT_SERVICE_CODE = "WM_DRUM";
const CUSTOMER_NAME_EMPTY_LABEL = "お客様名未入力";
const SERVICE_OPTION_GROUPS = [
  {
    label: "洗濯機",
    options: [
      { code: "WM_DRUM", label: "ドラム式洗濯機" },
      { code: "WM_VERT", label: "縦型洗濯機" },
      { code: "WM_OTHER", label: "コインランドリー/その他洗濯機" },
    ],
  },
  {
    label: "エアコン",
    options: [
      { code: "AC_WALL", label: "壁掛けエアコン" },
      { code: "AC_CEIL", label: "天井埋込/セントラルエアコン" },
    ],
  },
  {
    label: "その他",
    options: [{ code: "OTHER", label: "その他" }],
  },
];
const SERVICE_OPTIONS = SERVICE_OPTION_GROUPS.flatMap((group) => group.options);
const PHOTO_SLOTS = [
  { kind: "before", label: "Before", lineLabel: "Before" },
  { kind: "after", label: "After", lineLabel: "After" },
  { kind: "process", label: "作業中の写真", lineLabel: "作業中" },
];
const CUSTOMER_NAME_COLLATOR = new Intl.Collator("ja-JP", {
  numeric: true,
  sensitivity: "base",
});
const T = {
  tabToday: "今日 LINE で送る",
  tabJobs: "お客様一覧",
  tabData: "データ（開発者）",
  emptyToday: "本日、LINE で送るお客様はいません",
  badgeToday: "今日 LINE で送る",
  dirtPoint: "洗う場所",
  photoVerified: { 未: "写真未確認", 済: "写真確認済み" },
  linePhotoSent: { 未: "未送信", 済: "送信済み", 不要: "不要" },
  todaySendTarget: { yes: "対象", no: "対象外" },
};
const DELETE_CONFIRM_MS = 5000;
const LINE_TEST_TEMPLATE = "作業が完了しました。洗浄前後のお写真をお送りします。";
const LINE_LEGACY_SIGNATURE_PATTERNS = [];
const DETAIL_DRAFT_STORAGE_KEY = "photo_r1a_phase0_detail_draft_v1";
const DETAIL_DRAFT_RESET_BUILD_KEY = "photo_r1a_detail_draft_reset_build";
const DETAIL_DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
let detailAutoSaveTimer = 0;
let detailDraftsByJob = new Map();

function safeJsonParse(raw, fallback = null) {
  try {
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeLineMessageText(value) {
  let text = String(value || LINE_TEST_TEMPLATE);
  for (const pattern of LINE_LEGACY_SIGNATURE_PATTERNS) {
    text = text.replace(pattern, "");
  }
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return text || LINE_TEST_TEMPLATE;
}

function loadDetailDrafts() {
  try {
    const raw = localStorage.getItem(DETAIL_DRAFT_STORAGE_KEY);
    if (!raw) return;
    const data = safeJsonParse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    const now = Date.now();
    Object.entries(data).forEach(([jobId, rawDraft]) => {
      if (!jobId || !rawDraft || typeof rawDraft !== "object") return;
      const updatedAt = Number(rawDraft.updatedAt);
      if (!Number.isFinite(updatedAt) || now - updatedAt > DETAIL_DRAFT_TTL_MS) return;
      detailDraftsByJob.set(String(jobId), { ...rawDraft, jobId: String(jobId) });
    });
  } catch {
    detailDraftsByJob.clear();
  }
}

function persistDetailDrafts() {
  try {
    const payload = Object.fromEntries(detailDraftsByJob.entries());
    localStorage.setItem(DETAIL_DRAFT_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* no-op */
  }
}

function getDetailDraftForJob(jobId) {
  if (!jobId) return null;
  return detailDraftsByJob.get(String(jobId)) || null;
}

function getActiveDetailDraft(jobId) {
  const draft = getDetailDraftForJob(jobId);
  if (!draft) return null;
  const updatedAt = Number(draft.updatedAt);
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > DETAIL_DRAFT_TTL_MS) {
    clearDetailDraftForJob(jobId);
    return null;
  }
  return draft;
}

function clearDetailDraftForJob(jobId) {
  if (!jobId) return;
  detailDraftsByJob.delete(String(jobId));
  persistDetailDrafts();
}

function clearAllDetailDrafts() {
  detailDraftsByJob.clear();
  pendingDetailFormState = null;
  persistDetailDrafts();
}

function resetLegacyDetailDraftsOnce() {
  try {
    const resetBuild = localStorage.getItem(DETAIL_DRAFT_RESET_BUILD_KEY);
    if (resetBuild === APP_BUILD) return;
    clearAllDetailDrafts();
    localStorage.setItem(DETAIL_DRAFT_RESET_BUILD_KEY, APP_BUILD);
  } catch {
    clearAllDetailDrafts();
  }
}

function prepareFreshJobForDetail(job) {
  if (!job?.jobId) return;
  cancelDetailAutoSave();
  pendingDetailFormState = null;
  clearDetailDraftForJob(job.jobId);
}

function rememberCurrentDetailFormState(job) {
  const state = captureDetailFormState(job);
  if (!state?.jobId) return;
  pendingDetailFormState = state;
}

function setDetailDraftFromJob(job) {
  if (!job?.jobId) return;
  const draft = captureDetailDraft(job);
  draft.updatedAt = Date.now();
  draft.jobId = String(job.jobId);
  detailDraftsByJob.set(draft.jobId, draft);
  persistDetailDrafts();
}

function queueDetailAutoSave(job, delayMs = 120) {
  if (!job) return;
  if (detailAutoSaveTimer) {
    window.clearTimeout(detailAutoSaveTimer);
  }
  detailAutoSaveTimer = window.setTimeout(() => {
    syncDetailForm(job);
    setDetailDraftFromJob(job);
    saveLocal();
  }, delayMs);
}

function cancelDetailAutoSave() {
  if (!detailAutoSaveTimer) return;
  window.clearTimeout(detailAutoSaveTimer);
  detailAutoSaveTimer = 0;
}

function syncDetailForm(job) {
  if (!job) return;
  syncTopFormToJob(job);
  syncPointsFromForm(job);
}

function blurActiveDetailInput() {
  const active = document.activeElement;
  if (!detailJobId || !active || !main.contains(active) || typeof active.blur !== "function") {
    return;
  }
  active.blur();
}

function commitActiveDetailFormNow() {
  const currentJob = findJob(detailJobId);
  if (!currentJob) return false;
  cancelDetailAutoSave();
  syncDetailForm(currentJob);
  rememberCurrentDetailFormState(currentJob);
  setDetailDraftFromJob(currentJob);
  saveLocal();
  return true;
}

function commitActiveDetailFormBeforeLeaving() {
  blurActiveDetailInput();
  return commitActiveDetailFormNow();
}

function persistDetailFormState(job) {
  if (!job) return;
  syncDetailForm(job);
  rememberCurrentDetailFormState(job);
  setDetailDraftFromJob(job);
  saveLocal();
}

function hydrateDetailFormState(job) {
  if (!job?.jobId) return null;
  const draft = getActiveDetailDraft(job.jobId);
  const state = draft && draft.jobId === job.jobId ? draft : null;
  const fallback = pendingDetailFormState;
  const active = state || (fallback && fallback.jobId === job.jobId ? fallback : null);
  if (!active) return null;
  applyDetailFormStateToJob(job, active);
  return active;
}

function createEmptyState() {
  return {
    schemaVersion: "1.0",
    exportedAt: null,
    note: "",
    jobs: [],
  };
}

let state = createEmptyState();

let currentView = "jobs";
let detailJobId = null;
let lastSaveError = "";
let lastSaveMessage = "";
let photoRenderSeq = 0;
let activePhotoUrls = [];
/** @type {Map<string, { status: string, fingerprint: string, blobs: object[], previewUrls: string[], checkedAt: string|null }>} */
const albumCheckCache = new Map();
const albumSaveFallbackVisible = new Set();
let pendingDetailFormState = null;
let lastPointAddRunAt = 0;
let customerNameInputComposing = false;
let lastManualJobCreateAt = 0;

const main = document.getElementById("app-main");
const footer = document.getElementById("footer-status");
const saveToast = document.getElementById("save-toast");
const versionBanner = document.getElementById("version-banner");

function captureDetailFormState(job) {
  const customerEl = document.getElementById("f-customerName");
  const serviceEl = document.getElementById("f-serviceCode");
  const workDateEl = document.getElementById("f-workDate");
  const sendPlannedDateEl = document.getElementById("f-sendPlannedDate");
  const messageEl = document.getElementById("f-line-album-message");
  const points = [...main.querySelectorAll("[data-point-row]")].map((row) => {
    const pointIndex = Number(row.dataset.pointRow);
    const point = job?.dirtPoints?.[pointIndex];
    const pointNameEl = row.querySelector("[data-point-name-idx]");
    const pointCheckedEl = row.querySelector("[data-point-idx]");
    return {
      pointId: point?.pointId || `${job?.jobId || ""}-P${String(pointIndex + 1).padStart(2, "0")}`,
      name: pointNameEl ? pointNameEl.value : point?.name || `ポイント${pointIndex + 1}`,
      manualCompletedChecked: pointCheckedEl ? pointCheckedEl.checked : false,
    };
  });
  return {
    jobId: job?.jobId || "",
    customerName:
      customerEl?.value !== undefined ? customerEl.value : (job?.customerName || ""),
    serviceCode: serviceEl ? serviceEl.value : "",
    workDate: workDateEl ? workDateEl.value : "",
    sendPlannedDate: sendPlannedDateEl ? sendPlannedDateEl.value : "",
    messageText: normalizeLineMessageText(messageEl ? messageEl.value : (job?.lineAlbum?.messageText || "")),
    points,
  };
}

function applyDetailFormStateToJob(job, formState) {
  if (!job || !formState) return;
  const customerInputValue = normalizeCustomerNameInput(formState.customerName);
  if (customerInputValue) {
    job.customerName = customerInputValue;
  }
  if (formState.serviceCode) {
    job.serviceCode = formState.serviceCode;
  }
  const fallbackWorkDate = normalizeDateInputValue(job.workDate, todayYmd());
  const formWorkDate = normalizeDateInputValue(formState.workDate, fallbackWorkDate);
  const formSendDate = normalizeDateInputValue(formState.sendPlannedDate, formWorkDate);
  job.workDate = formWorkDate;
  job.sendPlannedDate = formSendDate < formWorkDate ? formWorkDate : formSendDate;
  if (!job.lineAlbum) job.lineAlbum = {};
  if (formState.messageText) {
    job.lineAlbum.messageText = normalizeLineMessageText(formState.messageText);
  }
  if (Array.isArray(formState.points)) {
    formState.points.forEach((pointState) => {
      const point = job.dirtPoints?.find((item) => item.pointId === pointState.pointId);
      if (!point) return;
      point.name = pointState.name || point.name;
      point.manualCompletedChecked = pointState.manualCompletedChecked === true;
    });
  }
}

function applyDetailFormStateToDom(job, formState) {
  if (!formState || !job || formState.jobId !== job.jobId) return;
  const topCustomerInput = document.getElementById("f-customerName");
  if (topCustomerInput) {
    topCustomerInput.value = formState.customerName || "";
    if (!topCustomerInput.value) {
      topCustomerInput.value = "";
    }
  }
  const serviceEl = document.getElementById("f-serviceCode");
  if (serviceEl && formState.serviceCode) {
    serviceEl.value = formState.serviceCode;
  }
  const workDateEl = document.getElementById("f-workDate");
  if (workDateEl) {
    const workDate = normalizeDateInputValue(formState.workDate, job.workDate || todayYmd());
    workDateEl.value = workDate;
  }
  const sendDateEl = document.getElementById("f-sendPlannedDate");
  if (sendDateEl) {
    const workDate = normalizeDateInputValue(workDateEl?.value, job.workDate || todayYmd());
    const sendDate = normalizeDateInputValue(formState.sendPlannedDate, job.sendPlannedDate || workDate);
    sendDateEl.value = sendDate < workDate ? workDate : sendDate;
  }
  const messageEl = document.getElementById("f-line-album-message");
  if (messageEl && formState.messageText) {
    messageEl.value = normalizeLineMessageText(formState.messageText);
  }
  const pointNames = [...main.querySelectorAll("[data-point-name-idx]")];
  const pointChecks = [...main.querySelectorAll("[data-point-idx]")];
  if (Array.isArray(formState.points)) {
    formState.points.forEach((pointState) => {
      const row = job.dirtPoints?.find((item) => item.pointId === pointState.pointId);
      if (!row) return;
      const pointIndex = job.dirtPoints.indexOf(row);
      const nameEl = pointNames[pointIndex];
      const checkEl = pointChecks[pointIndex];
      if (nameEl) nameEl.value = pointState.name || nameEl.value;
      if (checkEl) checkEl.checked = pointState.manualCompletedChecked;
    });
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isDevMode() {
  return new URLSearchParams(globalThis.location?.search || "").get("dev") === "1";
}

function isPcDevCopyEnabled() {
  return isDevMode() && globalThis.matchMedia?.("(pointer: fine)")?.matches;
}

function assertCanvasLimits(width, height) {
  const pixels = width * height;
  if (width > LINE_CANVAS_MAX_WIDTH) {
    throw new Error(`画像幅が上限 ${LINE_CANVAS_MAX_WIDTH}px を超えます`);
  }
  if (height > LINE_CANVAS_MAX_HEIGHT) {
    throw new Error(`画像高さが上限 ${LINE_CANVAS_MAX_HEIGHT}px を超えます`);
  }
  if (pixels > LINE_CANVAS_MAX_PIXELS) {
    throw new Error(`総ピクセル数が上限 ${LINE_CANVAS_MAX_PIXELS.toLocaleString()}px を超えます`);
  }
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function trimOrEmpty(value) {
  return String(value || "").trim();
}

function normalizeDateInputValue(value, fallback = "") {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return /^\d{4}-\d{2}-\d{2}$/.test(String(fallback || "")) ? String(fallback) : "";
}

function normalizeCustomerNameInput(value) {
  const name = trimOrEmpty(value);
  return CUSTOMER_NAME_PLACEHOLDER_TOKENS.includes(name) ? "" : name;
}

function customerDisplayName(value) {
  const name = trimOrEmpty(value);
  if (!name) return CUSTOMER_NAME_EMPTY_LABEL;
  if (name.endsWith("様")) return name;
  return `${name}様`;
}

function renderCustomerName(value) {
  return escapeHtml(customerDisplayName(value));
}

function renderCustomerNameHint(value) {
  if (!trimOrEmpty(value)) {
    return `<p class="card-meta">お客様名が未入力です。案件を開いて入力してください。</p>`;
  }
  return "";
}

function syncDetailFormToJob(job) {
  if (!job) return;
  syncTopFormToJob(job);
  syncPointsFromForm(job);
}

function captureDetailDraft(job) {
  const customerEl = document.getElementById("f-customerName");
  const serviceEl = document.getElementById("f-serviceCode");
  const workDateEl = document.getElementById("f-workDate");
  const sendPlannedDateEl = document.getElementById("f-sendPlannedDate");
  const messageEl = document.getElementById("f-line-album-message");
  return {
    customerName: normalizeCustomerNameInput(customerEl ? customerEl.value : job?.customerName || ""),
    serviceCode: serviceEl ? serviceEl.value : job?.serviceCode || DEFAULT_SERVICE_CODE,
    workDate: workDateEl ? workDateEl.value : job?.workDate || "",
    sendPlannedDate: sendPlannedDateEl ? sendPlannedDateEl.value : job?.sendPlannedDate || "",
    messageText: normalizeLineMessageText(messageEl ? messageEl.value : job?.lineAlbum?.messageText || LINE_TEST_TEMPLATE),
    points: [...main.querySelectorAll("[data-point-row]")].map((row, order) => ({
      order,
      pointId: job?.dirtPoints?.[Number(row.dataset.pointRow)]?.pointId || "",
      name: row.querySelector("[data-point-name-idx]")?.value || `ポイント${order + 1}`,
      manualCompletedChecked: row.querySelector("[data-point-idx]")?.checked === true,
    })),
  };
}

function restoreDetailDraftToJob(job, draft) {
  if (!job || !draft) return;
  const hasCustomerField = Object.prototype.hasOwnProperty.call(draft, "customerName");
  const draftCustomer = normalizeCustomerNameInput(draft.customerName);
  if (hasCustomerField) {
    job.customerName = draftCustomer;
  }
  job.serviceCode = SERVICE_CODE_SET.has(draft.serviceCode) ? draft.serviceCode : DEFAULT_SERVICE_CODE;
  job.workDate = draft.workDate || "";
  job.sendPlannedDate = draft.sendPlannedDate || "";
  if (!job.lineAlbum) job.lineAlbum = {};
  job.lineAlbum.messageText = normalizeLineMessageText(draft.messageText || LINE_TEST_TEMPLATE);
  for (const savedPoint of draft.points || []) {
    const point =
      (savedPoint.pointId && job.dirtPoints?.find((item) => item.pointId === savedPoint.pointId)) ||
      job.dirtPoints?.[savedPoint.order];
    if (!point) continue;
    point.name = String(savedPoint.name || "").trim() || `ポイント${savedPoint.order + 1}`;
    point.manualCompletedChecked = savedPoint.manualCompletedChecked;
  }
}

function restoreAndPersistDetailDraft(job, draft) {
  if (!job || !draft) return false;
  restoreDetailDraftToJob(job, draft);
  draft.updatedAt = Date.now();
  draft.jobId = String(job.jobId);
  detailDraftsByJob.set(draft.jobId, draft);
  persistDetailDrafts();
  return saveLocal();
}

function hydrateDraftToJob(job) {
  const draft = getActiveDetailDraft(job?.jobId);
  if (!draft) return false;
  restoreDetailDraftToJob(job, draft);
  return true;
}

function clearCustomerPlaceholderValue(input) {
  if (!input) return;
  const value = trimOrEmpty(input.value);
  if (CUSTOMER_NAME_PLACEHOLDER_TOKENS.includes(value)) {
    input.value = "";
  }
}

function clearCustomerPlaceholderOnInteraction(input) {
  if (!input) return;
  const handler = () => {
    if (CUSTOMER_NAME_PLACEHOLDER_TOKENS.includes(trimOrEmpty(input.value))) {
      input.value = "";
    }
  };
  input.addEventListener("touchstart", handler, { passive: true });
  input.addEventListener("pointerdown", handler);
  input.addEventListener("focusin", handler);
  input.addEventListener("focus", handler);
  input.addEventListener("click", handler);
}

function wireCustomerNameInput(input, job) {
  if (!input || !job) return;
  clearCustomerPlaceholderOnInteraction(input);
  input.addEventListener("compositionstart", () => {
    customerNameInputComposing = true;
    input.dataset.composing = "1";
  });
  input.addEventListener("compositionend", () => {
    customerNameInputComposing = false;
    input.dataset.composing = "";
    persistDetailFormState(job);
    queueDetailAutoSave(job, 0);
    updateAlbumPanelUi(job);
  });
  input.addEventListener("change", () => {
    customerNameInputComposing = false;
    input.dataset.composing = "";
    persistDetailFormState(job);
    queueDetailAutoSave(job, 0);
    updateAlbumPanelUi(job);
  });
  input.addEventListener("blur", () => {
    if (customerNameInputComposing) return;
    persistDetailFormState(job);
    queueDetailAutoSave(job, 0);
    updateAlbumPanelUi(job);
  });
  input.addEventListener("input", () => {
    if (customerNameInputComposing || input.dataset.composing === "1") {
      return;
    }
    persistDetailFormState(job);
    queueDetailAutoSave(job, 0);
    updateAlbumPanelUi(job);
  });
}

function knownServiceCodeSet() {
  return new Set(SERVICE_OPTIONS.map((item) => item.code));
}

const SERVICE_CODE_SET = knownServiceCodeSet();

function newId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizePhotoRef(value, kind) {
  const p = asObject(value);
  if (!p.photoId) return null;
  const photoId = String(p.photoId);
  if (photoId.length > 120 || /^data:/i.test(photoId)) return null;
  return {
    photoId,
    kind,
    name: `${kind}.jpg`,
    mimeType: String(p.mimeType || "image/jpeg"),
    size: Number.isFinite(Number(p.size)) ? Number(p.size) : 0,
    createdAt: String(p.createdAt || new Date().toISOString()),
  };
}

function normalizePhotoRefs(value) {
  const src = asObject(value);
  return PHOTO_SLOTS.reduce((acc, slot) => {
    acc[slot.kind] = normalizePhotoRef(src[slot.kind], slot.kind);
    return acc;
  }, {});
}

function normalizePoint(point, index, jobId) {
  const p = asObject(point);
  const name = String(p.name || "").trim();
  return {
    pointId: String(p.pointId || `${jobId || "job"}-P${String(index + 1).padStart(2, "0")}`),
    jobId: String(p.jobId || jobId || ""),
    name: name || `ポイント${index + 1}`,
    displayOrder: Number.isFinite(Number(p.displayOrder)) ? Number(p.displayOrder) : index + 1,
    manualCompletedChecked: p.manualCompletedChecked === true,
    memo: String(p.memo || ""),
    photos: normalizePhotoRefs(p.photos),
  };
}

function normalizeJob(job, index) {
  const j = asObject(job);
  const rawJobId = String(j.jobId || "").trim();
  const jobId = rawJobId || `imported-${String(index + 1).padStart(3, "0")}`;
  const rawCustomerName = trimOrEmpty(j.customerName);
  const fallbackWorkDate = todayYmd();
  const workDate = normalizeDateInputValue(j.workDate, fallbackWorkDate);
  const sendPlannedDate = normalizeDateInputValue(j.sendPlannedDate, workDate);
  const dirtPoints = Array.isArray(j.dirtPoints)
    ? j.dirtPoints.map((p, i) => normalizePoint(p, i, jobId))
    : [];
  const la = asObject(j.lineAlbum);
  return {
    jobId,
    workDate,
    sendPlannedDate: sendPlannedDate < workDate ? workDate : sendPlannedDate,
    customerName: normalizeCustomerNameInput(rawCustomerName),
    serviceCode: String(j.serviceCode || ""),
    visitOrder: Number.isFinite(Number(j.visitOrder)) ? Number(j.visitOrder) : index + 1,
    status: String(j.status || ""),
    photoStorage: String(j.photoStorage || BETA_LOCAL_STORAGE_LABEL),
    photoVerified: j.photoVerified === "済" ? "済" : "未",
    linePhotoSent: ["済", "不要"].includes(j.linePhotoSent) ? j.linePhotoSent : "未",
    lineThanksSent: ["済", "不要"].includes(j.lineThanksSent) ? j.lineThanksSent : "未",
    lineAlbum: {
      messageText: normalizeLineMessageText(la.messageText || LINE_TEST_TEMPLATE),
      messageSource: la.messageSource === "template" ? "template" : "manual",
      templateId: la.templateId ?? null,
      layout: "job_before_after_grid_v1",
      checkedAt: la.checkedAt || null,
    },
    dirtPoints,
  };
}

function normalizeState(data) {
  const src = asObject(data);
  if (!Array.isArray(src.jobs)) {
    throw new Error("jobs 配列がありません");
  }
  if (src.jobs.length > MAX_PHASE0_JOBS) {
    throw new Error(`このアプリではお客様データは最大 ${MAX_PHASE0_JOBS} 件までです`);
  }
  return {
    ...createEmptyState(),
    ...src,
    schemaVersion: String(src.schemaVersion || "1.0"),
    exportedAt: src.exportedAt || null,
    note: String(src.note || ""),
    jobs: src.jobs.map(normalizeJob),
  };
}

function ensureState() {
  if (!Array.isArray(state.jobs)) {
    state = createEmptyState();
    return;
  }
  state.jobs = state.jobs.map((job, index) => {
    const normalized = normalizeJob(job, index);
    if (!job || typeof job !== "object" || Array.isArray(job)) {
      return normalized;
    }
    for (const key of Object.keys(job)) {
      delete job[key];
    }
    Object.assign(job, normalized);
    return job;
  });
}

function safeJobs() {
  ensureState();
  return state.jobs;
}

function safeTodaySend(today = todayYmd()) {
  return filterTodaySend(safeJobs(), today);
}

function countPhotoRefs() {
  return safeJobs().reduce((sum, job) => {
    const points = Array.isArray(job.dirtPoints) ? job.dirtPoints : [];
    return sum + points.reduce((n, point) => {
      const photos = normalizePhotoRefs(point.photos);
      return n + PHOTO_SLOTS.filter((slot) => photos[slot.kind]).length;
    }, 0);
  }, 0);
}

function countJobPhotoRefs(job) {
  const points = Array.isArray(job?.dirtPoints) ? job.dirtPoints : [];
  return points.reduce((sum, point) => {
    const photos = normalizePhotoRefs(point.photos);
    return sum + PHOTO_SLOTS.filter((slot) => photos[slot.kind]).length;
  }, 0);
}

function photoPairStatus(point) {
  const photos = normalizePhotoRefs(point?.photos);
  const hasBefore = Boolean(photos.before);
  const hasAfter = Boolean(photos.after);
  if (hasBefore && hasAfter) return { label: "Before / After OK", className: "badge-ok" };
  if (hasBefore && !hasAfter) return { label: "After未撮影", className: "badge-warn" };
  if (!hasBefore && hasAfter) return { label: "Before未撮影", className: "badge-warn" };
  return { label: "写真なし", className: "badge-muted" };
}

function jobPhotoSendWarnings(job) {
  const warnings = [];
  const points = Array.isArray(job?.dirtPoints) ? job.dirtPoints : [];
  if (points.length === 0) {
    warnings.push("洗う場所がありません。Before / After を登録してください。");
    return warnings;
  }
  const completePairs = points.filter((point) => {
    const photos = normalizePhotoRefs(point.photos);
    return photos.before && photos.after;
  }).length;
  if (completePairs === 0) {
    warnings.push(
      "Before と After が揃った場所がありません。未撮影の写真があるままでは送る写真の確認（済）にしないでください。"
    );
  }
  const partialOnly = points.some((point) => {
    const photos = normalizePhotoRefs(point.photos);
    return (photos.before && !photos.after) || (!photos.before && photos.after);
  });
  if (partialOnly) {
    warnings.push("一部の洗う場所に Before または After の未撮影があります。送る写真だけ選別できているか確認してください。");
  }
  const processCount = points.reduce((count, point) => {
    const photos = normalizePhotoRefs(point.photos);
    return count + (photos.process ? 1 : 0);
  }, 0);
  if (processCount > 2) {
    warnings.push(`作業中の写真が ${processCount} 枚あります。LINE では 1〜2 枚に絞る運用です。`);
  }
  return warnings;
}

function photoExportContextHint() {
  const ua = navigator.userAgent || "";
  const isAppleMobile = /iPhone|iPad|iPod/i.test(ua);
  if (isAppleMobile && window.isSecureContext) {
    return "iPhoneでは出力ボタンから共有シートを開き、LINEを選びます。LINEが出ない場合は、表示された保存先に従ってファイル保存、またはプレビューをスクリーンショットしてLINEへ添付してください。";
  }
  if (window.isSecureContext) {
    return "共有先にLINEが出ない場合は、出力後の保存先、またはプレビューのスクリーンショットからLINE添付で進めてください。";
  }
  return "HTTP接続のため共有が使えない場合があります。送信用画像を保存、またはスクリーンショットしてLINE添付を使ってください。";
}

function isAppleMobileDevice() {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent || "");
}

function shareButtonSpec() {
  if (canSharePhotoFiles()) {
    return { label: "共有", disabled: false, title: "LINE 等へ共有（JPEG）" };
  }
  return {
    label: "共有不可",
    disabled: true,
    title: "この接続では共有不可。保存してから LINE に添付してください。",
  };
}

function setDetailStatus(message, type = "info") {
  const el = document.getElementById("detail-status");
  if (!el) return;
  el.textContent = message;
  el.className = `save-status save-status-${type}`;
}

function updatePhotoVerifyHint(job) {
  const el = document.getElementById("photo-verify-hint");
  if (!el) return;
  syncPointsFromForm(job);
  const warnings = jobPhotoSendWarnings(job);
  if (warnings.length === 0) {
    el.textContent = "Before / After が1組以上あれば、送る写真の確認（済）にできます。";
    el.className = "hint";
    return;
  }
  el.textContent = warnings.join(" ");
  el.className = "hint hint-warn";
}

function revokePhotoUrls() {
  activePhotoUrls.forEach((url) => URL.revokeObjectURL(url));
  activePhotoUrls = [];
}

function setState(data) {
  state = normalizeState(data);
  detailJobId = null;
}

function setEmptyState() {
  state = createEmptyState();
  detailJobId = null;
}

function readStorageRaw() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function readStateFromStorage() {
  const raw = readStorageRaw();
  if (!raw) return null;
  try {
    return normalizeState(JSON.parse(raw));
  } catch {
    return null;
  }
}

function readJobFromStorage(jobId) {
  const stored = readStateFromStorage();
  if (!stored) return null;
  const idx = stored.jobs.findIndex((x) => x.jobId === jobId);
  if (idx < 0) return null;
  return stored.jobs[idx];
}

function testLocalStorageWritable() {
  const probe = "__r1a_ls_probe__";
  try {
    localStorage.setItem(probe, "1");
    const ok = localStorage.getItem(probe) === "1";
    localStorage.removeItem(probe);
    return ok;
  } catch {
    return false;
  }
}

function persistStateWithVerification(expectedChecks = []) {
  if (!saveLocal()) {
    return {
      ok: false,
      stage: "write",
      message: "localStorage への書き込みに失敗しました。",
    };
  }
  const stored = readStateFromStorage();
  if (!stored) {
    return {
      ok: false,
      stage: "readback",
      message: "保存後のデータ読み込みに失敗しました。",
    };
  }
  for (const check of expectedChecks) {
    const job = stored.jobs.find((x) => x.jobId === check.jobId);
    if (!job) {
      return {
        ok: false,
        stage: "verify",
        message: `${check.jobId} が保存済み一覧に見つかりません。`,
        actual: "(なし)",
      };
    }
    if (job[check.field] !== check.value) {
      return {
        ok: false,
        stage: "verify",
        message: `${check.jobId} の ${check.field} が「${check.value}」ではありません。`,
        actual: job[check.field],
      };
    }
  }
  state = stored;
  lastSaveError = "";
  updateFooter();
  return {
    ok: true,
    todayCount: filterTodaySend(stored.jobs, todayYmd()).length,
  };
}

function collectSaveDiagnostics() {
  const lsWritable = testLocalStorageWritable();
  const raw = readStorageRaw();
  const stored = readStateFromStorage();
  const yamadaMem = findJob(TRIAL_JOB_ID);
  const yamadaStore = readJobFromStorage(TRIAL_JOB_ID);
  const today = todayYmd();
  return {
    build: APP_BUILD,
    origin: globalThis.location?.origin || "(不明)",
    storageKey: STORAGE_KEY,
    lsWritable,
    hasStoredData: Boolean(raw),
    rawBytes: raw ? raw.length : 0,
    yamadaMemSent: yamadaMem?.linePhotoSent ?? "(なし)",
    yamadaStoreSent: yamadaStore?.linePhotoSent ?? "(なし)",
    todayFromMem: safeTodaySend(today).length,
    todayFromStore: stored ? filterTodaySend(stored.jobs, today).length : "(読取不可)",
    yamadaInTodayMem: yamadaMem ? isTodaySend(yamadaMem, today) : false,
    yamadaInTodayStore: yamadaStore ? isTodaySend(yamadaStore, today) : false,
  };
}

function renderSaveDiagnosticsHtml() {
  const d = collectSaveDiagnostics();
  const okClass = (ok) => (ok ? "save-status-ok" : "save-status-fail");
  return `
    <dl class="diag-list">
      <dt>実行中の版</dt><dd><code>${escapeHtml(d.build)}</code></dd>
      <dt>URL origin</dt><dd><code>${escapeHtml(d.origin)}</code></dd>
      <dt>保存キー</dt><dd><code>${escapeHtml(d.storageKey)}</code></dd>
      <dt>localStorage 書込</dt><dd class="${okClass(d.lsWritable)}">${d.lsWritable ? "OK" : "NG"}</dd>
      <dt>保存データ</dt><dd class="${okClass(d.hasStoredData)}">${d.hasStoredData ? `あり（${d.rawBytes} bytes）` : "なし"}</dd>
      <dt>サンプル顧客 linePhotoSent（メモリ）</dt><dd><code>${escapeHtml(String(d.yamadaMemSent))}</code></dd>
      <dt>サンプル顧客 linePhotoSent（保存実体）</dt><dd><code>${escapeHtml(String(d.yamadaStoreSent))}</code></dd>
      <dt>今日 LINE で送る件数（メモリ）</dt><dd><code>${d.todayFromMem}</code></dd>
      <dt>今日 LINE で送る件数（保存実体）</dt><dd><code>${escapeHtml(String(d.todayFromStore))}</code></dd>
      <dt>サンプル顧客が今日 LINE で送る（メモリ）</dt><dd class="${okClass(!d.yamadaInTodayMem)}">${d.yamadaInTodayMem ? "表示中" : "非表示"}</dd>
      <dt>サンプル顧客が今日 LINE で送る（保存実体）</dt><dd class="${okClass(!d.yamadaInTodayStore)}">${d.yamadaInTodayStore ? "表示中" : "非表示"}</dd>
    </dl>
  `;
}

async function checkDeployedVersion() {
  try {
    const res = await fetch(`./version.json?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const serverBuild = String(data.build || "");
    if (serverBuild && serverBuild !== APP_BUILD) {
      showVersionMismatchBanner(serverBuild);
    }
  } catch {
    /* オフライン等 */
  }
}

function showVersionMismatchBanner(serverBuild) {
  if (!versionBanner) return;
  versionBanner.hidden = false;
  versionBanner.innerHTML = `
    <p>新しい版があります（実行中: ${escapeHtml(APP_BUILD)} / サーバー: ${escapeHtml(serverBuild)}）</p>
    <button type="button" class="btn" id="btn-version-refresh">最新版を読み込む</button>
  `;
  document.getElementById("btn-version-refresh")?.addEventListener("click", () => {
    forceAppRefresh();
  });
}

function showSaveToast(message, type = "ok") {
  if (!saveToast) return;
  saveToast.textContent = message;
  saveToast.className = `save-toast save-toast-${type} save-toast-visible`;
  saveToast.hidden = false;
}

function hideSaveToast() {
  if (!saveToast) return;
  saveToast.hidden = true;
  saveToast.className = "save-toast";
  saveToast.textContent = "";
}

function showSaveFailure(message) {
  lastSaveMessage = "";
  lastSaveError = " · 保存未確認";
  showSaveToast(message, "fail");
  updateFooter();
}

function setFlashSaveMessage(message) {
  lastSaveError = "";
  lastSaveMessage = message;
  showSaveToast(message, "ok");
  updateFooter();
}

function showPersistFailure(result) {
  const detail =
    result.stage === "verify" && result.actual !== undefined
      ? ` 実値=${result.actual}`
      : "";
  const msg =
    result.stage === "verify"
      ? `保存確認に失敗しました。入力内容は画面に残しています。必要ならもう一度操作してください。（${result.message}${detail}）`
      : `保存できていません。${result.message} 入力内容は画面に残しています。`;
  showSaveFailure(msg);
  return msg;
}

function showSaveCanceled(message = "操作を取り消しました。保存していません。LINE写真は未送信のままです。") {
  showSaveToast(message, "warn");
  setDetailStatus(message, "warn");
  updateFooter();
}

function buildPersistEvidence(jobId, result) {
  const storedJob = readJobFromStorage(jobId);
  const sent = storedJob?.linePhotoSent ?? "(保存実体なし)";
  const verified = storedJob?.photoVerified ?? "(保存実体なし)";
  const todayVisible = storedJob ? isTodaySend(storedJob, todayYmd()) : true;
  return `保存確認OK。保存実体: LINE写真=${sent} / 送る写真=${verified} / 今日 LINE で送る=${todayVisible ? T.todaySendTarget.yes : T.todaySendTarget.no} / 今日 LINE で送る ${result.todayCount} 件`;
}

function navigateToTodayView() {
  detailJobId = null;
  if (window.location.hash.startsWith("#job=")) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  currentView = "today";
  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === "today");
  });
  render();
}

function syncTopFormToJob(job, options = {}) {
  const { persist = false } = options;
  const customerEl = document.getElementById("f-customerName");
  if (customerEl) {
    const input = trimOrEmpty(customerEl.value);
    job.customerName = normalizeCustomerNameInput(input);
  }
  const serviceEl = document.getElementById("f-serviceCode");
  if (serviceEl) {
    job.serviceCode = serviceEl.value || DEFAULT_SERVICE_CODE;
  }
  const workDateEl = document.getElementById("f-workDate");
  if (workDateEl) {
    job.workDate = workDateEl.value;
  }
  const sendPlannedDateEl = document.getElementById("f-sendPlannedDate");
  if (sendPlannedDateEl) {
    job.sendPlannedDate = sendPlannedDateEl.value;
  }
  const storageEl = document.getElementById("f-photoStorage");
  if (storageEl) {
    job.photoStorage = storageEl.value || BETA_LOCAL_STORAGE_LABEL;
  }
}

function syncSendPlannedDateToWorkDate(job, options = {}) {
  if (!job) return;
  const { force = false } = options;
  const workDateEl = document.getElementById("f-workDate");
  const sendDateEl = document.getElementById("f-sendPlannedDate");
  const workDate = workDateEl ? workDateEl.value : job.workDate || "";
  if (sendDateEl) {
    sendDateEl.min = workDate || "";
    if (workDate && (force || !sendDateEl.value || sendDateEl.value < workDate)) {
      sendDateEl.value = workDate;
    }
    job.sendPlannedDate = sendDateEl.value || workDate || "";
  } else if (workDate && (force || !job.sendPlannedDate || job.sendPlannedDate < workDate)) {
    job.sendPlannedDate = workDate;
  }
  if (workDate) {
    job.workDate = workDate;
  }
}

function applyDetailFormToJob(job) {
  syncTopFormToJob(job, { persist: true });
  const messageEl = document.getElementById("f-line-album-message");
  if (messageEl) {
    if (!job.lineAlbum) job.lineAlbum = {};
    job.lineAlbum.messageText = normalizeLineMessageText(messageEl.value);
    job.lineAlbum.messageSource = "manual";
    job.lineAlbum.layout = "job_before_after_grid_v1";
  }
  syncPointsFromForm(job);
}

function getLineAlbumMessageText(job) {
  const el = document.getElementById("f-line-album-message");
  if (el) return normalizeLineMessageText(el.value);
  return normalizeLineMessageText(job.lineAlbum?.messageText || LINE_TEST_TEMPLATE);
}

function albumFilesFromBlobs(job, blobs) {
  return (blobs || []).map(
    (item) =>
      new File([item.blob], item.filename || lineAlbumFilename(job, item.part, item.total), { type: "image/jpeg" })
  );
}

function canShareAlbumBlobs(job, blobs) {
  return canShareFiles(albumFilesFromBlobs(job, blobs));
}

function revokeAlbumPreviewUrls(entry) {
  (entry?.previewUrls || []).forEach((url) => URL.revokeObjectURL(url));
}

function getAlbumCheckEntry(jobId) {
  return (
    albumCheckCache.get(jobId) || {
      status: "not_checked",
      fingerprint: "",
      blobs: [],
      previewUrls: [],
      checkedAt: null,
    }
  );
}

function markAlbumStale(jobId) {
  const entry = getAlbumCheckEntry(jobId);
  if (entry.status === "not_checked") return;
  entry.status = "stale";
  entry.blobs = [];
  revokeAlbumPreviewUrls(entry);
  entry.previewUrls = [];
  entry.checkedAt = null;
  albumSaveFallbackVisible.delete(jobId);
  albumCheckCache.set(jobId, entry);
}

function computeAlbumFingerprint(job) {
  syncPointsFromForm(job);
  return buildAlbumContentFingerprint(job.dirtPoints, getLineAlbumMessageText(job));
}

function syncAlbumCheckEntry(job) {
  const entry = getAlbumCheckEntry(job.jobId);
  if (entry.status !== "checked") return entry;
  const fp = computeAlbumFingerprint(job);
  if (entry.fingerprint !== fp) {
    markAlbumStale(job.jobId);
    return getAlbumCheckEntry(job.jobId);
  }
  return entry;
}

function renderJobStatusBadges(job) {
  const today = todayYmd();
  const sendTarget = isTodaySend(job, today) ? T.todaySendTarget.yes : T.todaySendTarget.no;
  const sendClass = sendTarget === T.todaySendTarget.yes ? "badge-send" : "badge-muted";
  const verifiedLabel = T.photoVerified[job.photoVerified] || job.photoVerified;
  const sentLabel = T.linePhotoSent[job.linePhotoSent] || job.linePhotoSent;
  const verifiedClass = job.photoVerified === "済" ? "badge-ok" : "badge-warn";
  const sentClass = job.linePhotoSent === "済" ? "badge-ok" : "badge-muted";
  return `
    <div class="status-badges" aria-label="案件の状態">
      <span class="status-badge"><span class="status-badge-label">送信前チェック</span><span class="badge ${verifiedClass}">${escapeHtml(verifiedLabel)}</span></span>
      <span class="status-badge"><span class="status-badge-label">LINE送信</span><span class="badge ${sentClass}">${escapeHtml(sentLabel)}</span></span>
      <span class="status-badge"><span class="status-badge-label">本日の送信対象</span><span class="badge ${sendClass}">${escapeHtml(sendTarget)}</span></span>
    </div>
  `;
}

function sortDateValue(value) {
  const raw = trimOrEmpty(value);
  return raw || "9999-12-31";
}

function compareJobsForWorkDayList(a, b) {
  const dateA = sortDateValue(a?.workDate);
  const dateB = sortDateValue(b?.workDate);
  if (dateA !== dateB) return dateA < dateB ? -1 : 1;
  const nameA = customerDisplayName(a?.customerName || "");
  const nameB = customerDisplayName(b?.customerName || "");
  const byName = CUSTOMER_NAME_COLLATOR.compare(nameA, nameB);
  if (byName !== 0) return byName;
  return (a?.visitOrder || 0) - (b?.visitOrder || 0);
}

function isWorkDateOnOrBeforeToday(job) {
  const workDate = sortDateValue(job?.workDate);
  const today = todayYmd();
  return workDate !== "9999-12-31" && workDate <= today;
}

function isJobDoneForList(job) {
  return job?.status === "作業完了" || job?.linePhotoSent === "済";
}

function jobListCardState(job) {
  const done = isJobDoneForList(job);
  const pastOrToday = isWorkDateOnOrBeforeToday(job);
  const classes = ["card", "job-card"];
  if (done) classes.push("job-card-done");
  else if (pastOrToday) classes.push("job-card-due");
  const label = done ? "作業完了" : pastOrToday ? "当日以前" : "";
  return { classes: classes.join(" "), label };
}

function handleMarkPhotoVerified(job) {
  if (job.photoVerified === "済") {
    setDetailStatus("送る写真はすでに確認済みです。", "info");
    return;
  }
  syncPointsFromForm(job);
  const warnings = jobPhotoSendWarnings(job);
  if (warnings.length > 0) {
    const proceed = confirm(
      `送る写真の確認（済）にしますか？\n\n${warnings.join("\n\n")}\n\n送ってよい写真だけ選別できていることを確認してください。`
    );
    if (!proceed) {
      showSaveCanceled("送る写真の確認をキャンセルしました。");
      return;
    }
  }
  applyDetailFormToJob(job);
  const prev = job.photoVerified;
  job.photoVerified = "済";
  const result = persistStateWithVerification([
    { jobId: job.jobId, field: "photoVerified", value: "済" },
  ]);
  if (!result.ok) {
    job.photoVerified = prev;
    const msg = showPersistFailure(result);
    setDetailStatus(msg, "warn");
    return;
  }
  const msg = "送る写真を確認済みに保存しました。";
  setFlashSaveMessage(msg);
  setDetailStatus(msg, "ok");
  renderDetail();
}

function verifySavedJobField(jobId, field, expected) {
  const job = readJobFromStorage(jobId);
  return Boolean(job && job[field] === expected);
}

function persistSimpleJobUpdate(message = "更新しました。") {
  if (!saveLocal()) {
    showSaveToast("更新内容を保存できませんでした。画面の内容は残しています。もう一度お試しください。", "warn");
    return false;
  }
  setFlashSaveMessage(message);
  return true;
}

function setSelectedJobsLinePhotoSent(jobIds, value) {
  const ids = [...new Set((jobIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  const jobs = ids.map((id) => findJob(id)).filter(Boolean);
  if (!jobs.length) {
    showSaveToast("対象のお客様が選択されていません。", "warn");
    return;
  }
  for (const job of jobs) {
    job.linePhotoSent = value;
  }
  const verb = value === "済" ? "今日 LINE で送る一覧から消しました。" : "今日 LINE で送る一覧に残しました。";
  const saved = persistSimpleJobUpdate(`${jobs.length}件を${verb}`);
  renderJobs();
  if (saved) showSaveToast(`${jobs.length}件を${verb}`, "ok");
}

function markTodayJobComplete(jobId) {
  const job = findJob(jobId);
  if (!job) {
    showSaveToast("対象のお客様が見つかりませんでした。", "warn");
    renderToday();
    return;
  }
  job.linePhotoSent = "済";
  job.status = "作業完了";
  const saved = persistSimpleJobUpdate(`${customerDisplayName(job.customerName)}を作業完了として今日の一覧から消しました。`);
  renderToday();
  if (saved) {
    showSaveToast(`${customerDisplayName(job.customerName)}を今日の一覧から消しました。`, "ok");
  }
}

function todayBannerHtml() {
  if (!lastSaveMessage) return "";
  return `<p class="save-status save-status-ok app-banner">${escapeHtml(lastSaveMessage)}</p>`;
}

function saveLocal() {
  ensureState();
  state.exportedAt = new Date().toISOString();
  try {
    const serialized = JSON.stringify(state);
    localStorage.setItem(STORAGE_KEY, serialized);
    if (localStorage.getItem(STORAGE_KEY) !== serialized) {
      throw new Error("保存直後の確認に失敗しました");
    }
    lastSaveError = "";
    updateFooter();
    return true;
  } catch (e) {
    console.warn("localStorage 保存失敗", e);
    lastSaveError = " · 保存未完了";
    updateFooter();
    return false;
  }
}

function loadLocal() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    console.warn("localStorage 読込失敗", e);
    return false;
  }
  if (!raw) return false;
  try {
    setState(JSON.parse(raw));
    return true;
  } catch (e) {
    console.warn("localStorage データ不正", e);
    return false;
  }
}

function openPhotoDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in globalThis)) {
      reject(new Error("このブラウザでは写真保存に対応していません"));
      return;
    }
    const req = indexedDB.open(PHOTO_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PHOTO_STORE)) {
        db.createObjectStore(PHOTO_STORE, { keyPath: "photoId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("写真DBを開けませんでした"));
  });
}

async function withPhotoStore(mode, fn) {
  const db = await openPhotoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE, mode);
    const store = tx.objectStore(PHOTO_STORE);
    let result;
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error("写真DB操作に失敗しました"));
    };
    try {
      result = fn(store);
    } catch (e) {
      tx.abort();
      reject(e);
    }
  });
}

function requestResult(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("写真DB読込に失敗しました"));
  });
}

async function putPhotoBlob(ref, blob) {
  await withPhotoStore("readwrite", (store) => {
    store.put({ photoId: ref.photoId, blob, ref });
  });
}

async function getPhotoBlob(photoId) {
  return withPhotoStore("readonly", async (store) => {
    const rec = await requestResult(store.get(photoId));
    return rec?.blob || null;
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("画像変換に失敗しました"));
    reader.readAsDataURL(blob);
  });
}

async function getPhotoDataUrl(photoId) {
  const blob = await getPhotoBlob(photoId);
  return blob ? blobToDataUrl(blob) : "";
}

async function deletePhotoBlob(photoId) {
  if (!photoId) return;
  await withPhotoStore("readwrite", (store) => {
    store.delete(photoId);
  });
}

async function clearPhotoDb() {
  await withPhotoStore("readwrite", (store) => {
    store.clear();
  });
}

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("画像を読み込めませんでした"));
    };
    img.src = url;
  });
}

async function compressPhoto(file) {
  if (!file?.type?.startsWith("image/")) {
    throw new Error("画像ファイルを選んでください");
  }
  if (file.size > PHOTO_MAX_INPUT_BYTES) {
    throw new Error("画像が大きすぎます。15MB以下にしてください");
  }
  const img = await loadImage(file);
  if (img.naturalWidth * img.naturalHeight > PHOTO_MAX_PIXELS) {
    throw new Error("画像の画素数が大きすぎます。別の写真を選んでください");
  }
  const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await new Promise((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", PHOTO_JPEG_QUALITY);
  });
  if (!blob) throw new Error("画像の圧縮に失敗しました");
  return blob;
}

async function loadSample() {
  const res = await fetch(SAMPLE_URL);
  if (!res.ok) throw new Error(`サンプル読込失敗: ${res.status}`);
  setState(await res.json());
  saveLocal();
}

async function initData() {
  loadDetailDrafts();
  resetLegacyDetailDraftsOnce();
  if (!loadLocal()) {
    await loadSample();
  }
}

function updateFooter() {
  const today = todayYmd();
  const jobs = safeJobs();
  const n = safeTodaySend(today).length;
  const build = ` · 版 ${APP_BUILD}`;
  const msg = lastSaveMessage ? ` · ${lastSaveMessage}` : "";
  footer.textContent = `今日 ${today}（${BUSINESS_TIME_ZONE}） · 今日 LINE で送る ${n} 件 · 全 ${jobs.length} 件${build}${msg}${lastSaveError}`;
}

function syncNavTabs() {
  document.querySelectorAll(".nav-tab").forEach((btn) => {
    const view = btn.dataset.view;
    if (view === "data") {
      btn.hidden = !isDevMode();
      btn.textContent = T.tabData;
      return;
    }
    if (view === "today") btn.textContent = T.tabToday;
    if (view === "jobs") btn.textContent = T.tabJobs;
  });
}

function setView(view) {
  if (!["today", "jobs", "data"].includes(view)) {
    view = "today";
  }
  if (view === "data" && !isDevMode()) {
    view = "today";
  }
  if (detailJobId) {
    commitActiveDetailFormBeforeLeaving();
  }
  currentView = view;
  detailJobId = null;
  if (window.location.hash.startsWith("#job=")) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  render();
}

function jobHash(jobId) {
  return `#job=${encodeURIComponent(jobId)}`;
}

function openJobFromHash() {
  const hash = window.location.hash || "";
  if (!hash.startsWith("#job=")) return false;
  const jobId = decodeURIComponent(hash.slice("#job=".length));
  if (!findJob(jobId)) return false;
  detailJobId = jobId;
  currentView = "today";
  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.classList.toggle("active", false);
  });
  renderDetail();
  return true;
}

function serviceLabel(code) {
  return SERVICE_OPTIONS.find((item) => item.code === code)?.label || code || "作業内容未設定";
}

function serviceOptionsHtml(selectedCode) {
  const safeSelected = selectedCode || "";
  const hasSelected = SERVICE_CODE_SET.has(safeSelected);
  const optionHtml = [];
  if (safeSelected && !hasSelected) {
    optionHtml.push(`<option value="${escapeHtml(safeSelected)}" selected>${escapeHtml(safeSelected)}（受け取った値）</option>`);
  }
  for (const group of SERVICE_OPTION_GROUPS) {
    const groupOptions = group.options
      .map(
        (item) =>
          `<option value="${escapeHtml(item.code)}" ${item.code === safeSelected ? "selected" : ""}>${escapeHtml(item.label)}</option>`
      )
      .join("");
    optionHtml.push(`<optgroup label="${escapeHtml(group.label)}">${groupOptions}</optgroup>`);
  }
  return `<option value="" disabled ${!safeSelected ? "selected" : ""}>作業内容を選択</option>${optionHtml.join("")}`;
}

function nextManualJobId(date = todayYmd()) {
  const prefix = String(date || todayYmd()).replace(/-/g, "");
  const seqMap = safeJsonParse(localStorage.getItem(MANUAL_JOB_SEQ_STORAGE_KEY), {});
  const savedNext = Number(seqMap?.[prefix] || 0);
  const nums = safeJobs()
    .map((job) => String(job.jobId || ""))
    .filter((id) => id.startsWith(`${prefix}-`))
    .map((id) => Number(id.slice(prefix.length + 1)))
    .filter((n) => Number.isFinite(n));
  let n = Math.max(savedNext, nums.length ? Math.max(...nums) + 1 : 1);
  let id = `${prefix}-${String(n).padStart(3, "0")}`;
  while (findJob(id)) {
    n += 1;
    id = `${prefix}-${String(n).padStart(3, "0")}`;
  }
  try {
    localStorage.setItem(
      MANUAL_JOB_SEQ_STORAGE_KEY,
      JSON.stringify({ ...seqMap, [prefix]: n + 1 })
    );
  } catch {
    /* no-op */
  }
  return id;
}

function createManualJob(initial = {}) {
  const workDate = todayYmd();
  const jobId = nextManualJobId(workDate);
  return normalizeJob(
    {
      jobId,
      workDate,
      sendPlannedDate: workDate,
      customerName: normalizeCustomerNameInput(initial.customerName || ""),
      serviceCode: SERVICE_CODE_SET.has(initial.serviceCode) ? initial.serviceCode : DEFAULT_SERVICE_CODE,
      visitOrder: safeJobs().length + 1,
      status: "作業中",
      photoStorage: BETA_LOCAL_STORAGE_LABEL,
      photoVerified: "未",
      linePhotoSent: "未",
      lineThanksSent: "未",
      lineAlbum: {
        messageText: LINE_TEST_TEMPLATE,
        messageSource: "manual",
        layout: "job_before_after_grid_v1",
        checkedAt: null,
      },
      dirtPoints: [
        {
          pointId: `${jobId}-P01`,
          jobId,
          name: "洗う場所1",
          displayOrder: 1,
          manualCompletedChecked: false,
          photos: {},
        },
      ],
    },
    safeJobs().length
  );
}

function manualJobSavePanelHtml() {
  return `
    <section class="card manual-create-panel">
      <h2>新しいお客様を追加</h2>
      <div class="field">
        <label>お客様名</label>
        <input type="text" id="f-new-customer-name" placeholder="例：サンプル様">
      </div>
      <button type="button" class="btn btn-primary" id="btn-save-new-manual-job">この内容で1件保存</button>
      <p class="hint">保存ボタンを押した時だけ、お客様一覧に1件追加します。</p>
    </section>
  `;
}

function wireManualJobSaveForm() {
  const input = document.getElementById("f-new-customer-name");
  const btn = document.getElementById("btn-save-new-manual-job");
  if (!input || !btn) return;
  clearCustomerPlaceholderOnInteraction(input);
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    saveNewManualJobFromForm();
  });
}

function saveNewManualJobFromForm() {
  const input = document.getElementById("f-new-customer-name");
  const btn = document.getElementById("btn-save-new-manual-job");
  if (!input || !btn) return;
  const now = Date.now();
  if (btn.disabled || now - lastManualJobCreateAt < 1500) return;
  const customerName = normalizeCustomerNameInput(input.value);
  if (!customerName) {
    showSaveToast("お客様名を入力してから保存してください。", "warn");
    input.focus();
    return;
  }
  lastManualJobCreateAt = now;
  btn.disabled = true;
  if (safeJobs().length >= MAX_PHASE0_JOBS) {
    alert(`このアプリで扱えるお客様データは最大 ${MAX_PHASE0_JOBS} 件です。送信済みデータを整理してください。`);
    btn.disabled = false;
    return;
  }
  const job = createManualJob({ customerName });
  prepareFreshJobForDetail(job);
  state.jobs.push(job);
  const saved = saveLocal();
  input.value = "";
  detailJobId = job.jobId;
  currentView = "jobs";
  if (window.location.hash.startsWith("#job=")) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  setFlashSaveMessage(
    saved
      ? `${customerDisplayName(customerName)}を1件保存しました。`
      : `${customerDisplayName(customerName)}を画面上に作成しましたが、ブラウザ保存を確認できませんでした。`
  );
  renderDetail();
}

function renderToday() {
  const today = todayYmd();
  const list = [...safeTodaySend(today)].sort(compareJobsForWorkDayList);
  if (list.length === 0) {
    main.innerHTML = `
      ${todayBannerHtml()}
      <p class="empty">${escapeHtml(T.emptyToday)}</p>
      <p class="hint">条件: LINE写真=未送信、送信予定日が今日以前</p>
    `;
    return;
  }
  main.innerHTML =
    todayBannerHtml() +
    `<p class="hint">今日 · ${today} / ${BUSINESS_TIME_ZONE}</p>` +
    list
      .map(
        (j) => `
      <div class="card job-card">
        <span class="badge badge-send">${escapeHtml(T.badgeToday)}</span>
        <h2>${renderCustomerName(j.customerName)}</h2>
        ${renderCustomerNameHint(j.customerName)}
        <p class="card-meta">作業内容: ${escapeHtml(serviceLabel(j.serviceCode))}</p>
        <p class="card-meta">${escapeHtml(j.workDate)} · ${escapeHtml(j.status || "")}</p>
        <p class="card-meta">LINE写真 ${escapeHtml(T.linePhotoSent[j.linePhotoSent] || j.linePhotoSent)} / 送る写真 ${escapeHtml(T.photoVerified[j.photoVerified] || j.photoVerified)}</p>
        <div class="btn-row job-card-actions">
          <button type="button" class="btn btn-primary" data-job="${escapeHtml(j.jobId)}">開く</button>
          <button type="button" class="btn" data-today-complete="${escapeHtml(j.jobId)}">作業完了として消す</button>
        </div>
      </div>`
      )
      .join("");
  main.querySelectorAll("[data-job]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      openDetail(el.dataset.job, { confirmSwitch: false });
      window.location.hash = jobHash(el.dataset.job);
    });
  });
  main.querySelectorAll("[data-today-complete]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      markTodayJobComplete(btn.dataset.todayComplete);
    });
  });
}

function renderJobs() {
  lastManualJobCreateAt = 0;
  const sorted = [...safeJobs()].sort(compareJobsForWorkDayList);
  if (sorted.length === 0) {
    main.innerHTML = `${manualJobSavePanelHtml()}<p class="empty">お客様データがありません</p>`;
    wireManualJobSaveForm();
    return;
  }
  main.innerHTML =
    manualJobSavePanelHtml() +
    `<div class="list-actions">
      <p class="hint">送信済みのお客様は、確認後に選択して削除できます。</p>
      <div class="btn-row" style="margin-bottom:0.6rem;">
        <button type="button" class="btn btn-danger" id="btn-delete-selected-jobs">選択したお客様を削除</button>
        <button type="button" class="btn btn-danger" id="btn-delete-all-jobs">お客様一覧を全削除</button>
      </div>
    </div>` +
    sorted
    .map((j) => {
      const cardState = jobListCardState(j);
      const send = isTodaySend(j) ? `<span class="badge badge-send">${escapeHtml(T.badgeToday)}</span> ` : "";
      const rate = completionRate(j);
      return `
      <div class="${escapeHtml(cardState.classes)}">
        <div class="job-card-head">
          <div>${send}<h2>${renderCustomerName(j.customerName)}</h2></div>
          ${cardState.label ? `<span class="badge badge-state">${escapeHtml(cardState.label)}</span>` : ""}
        </div>
        ${renderCustomerNameHint(j.customerName)}
      <p class="card-meta">作業内容: ${escapeHtml(serviceLabel(j.serviceCode))}</p>
      <p class="card-meta">${escapeHtml(j.workDate)} · ${escapeHtml(j.status || "")}</p>
      <p class="card-meta">送る写真 ${escapeHtml(T.photoVerified[j.photoVerified] || j.photoVerified)} / LINE写真 ${escapeHtml(T.linePhotoSent[j.linePhotoSent] || j.linePhotoSent)}</p>
      <p class="rate">洗う場所 作業完了 ${rate.done}/${rate.total}（${rate.pct}%）</p>
      <label class="confirm-check" style="margin-top:0.45rem;">
        <input type="checkbox" data-job-select="${escapeHtml(j.jobId)}" />
        <span>このお客様を選択</span>
      </label>
      <div class="btn-row job-card-actions">
        <button type="button" class="btn btn-primary" data-job="${escapeHtml(j.jobId)}">開く</button>
          <button type="button" class="btn btn-danger" data-job-delete="${escapeHtml(j.jobId)}">このお客様だけ削除</button>
        </div>
      </div>`;
    })
    .join("");
  main.querySelectorAll("[data-job]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      openDetail(el.dataset.job, { confirmSwitch: false });
      window.location.hash = jobHash(el.dataset.job);
    });
  });
  main.querySelectorAll("[data-job-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const job = findJob(btn.dataset.jobDelete);
      if (!job) return;
      if (!armDeleteButton(btn)) return;
      if (!confirm(`${customerDisplayName(job.customerName)} を削除しますか？\n\n写真も端末内から削除します。この操作は元に戻せません。`)) {
        btn.textContent = btn.dataset.originalText || "削除";
        btn.classList.remove("is-armed");
        return;
      }
      await deleteJobById(job.jobId);
    });
  });
  main.querySelectorAll("[data-job-select]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const selectedCount = main.querySelectorAll("[data-job-select]:checked").length;
      syncSelectedJobActionButtons(selectedCount);
    });
  });
  const syncSelectedJobActionButtons = (selectedCount) => {
    const deleteBtn = document.getElementById("btn-delete-selected-jobs");
    if (deleteBtn) {
      deleteBtn.disabled = selectedCount === 0;
      deleteBtn.textContent = `選択したお客様を削除（${selectedCount}件）`;
    }
  };
  const deleteSelectedBtn = document.getElementById("btn-delete-selected-jobs");
  const selectedIds = () => [...main.querySelectorAll("[data-job-select]:checked")].map((item) => item.dataset.jobSelect);
  syncSelectedJobActionButtons(0);
  if (deleteSelectedBtn) {
    deleteSelectedBtn.addEventListener("click", async () => {
      const ids = selectedIds();
      if (!ids.length) return;
      if (!confirm(`選択した ${ids.length} 件を削除しますか？\n\n端末内写真もまとめて削除されます。戻せません。`)) return;
      await deleteJobsByIds(ids);
    });
  }
  document.getElementById("btn-delete-all-jobs")?.addEventListener("click", deleteAllJobs);
  wireManualJobSaveForm();
}

function openDetail(jobId, options = {}) {
  const next = findJob(jobId);
  if (!next) return;
  const shouldConfirm = options.confirmSwitch !== false && detailJobId !== jobId;
  if (
    shouldConfirm &&
    !confirm(`${renderCustomerName(next.customerName)}\n${next.jobId}\n\nこの案件を開きますか？`)
  ) {
    return;
  }
  detailJobId = jobId;
  renderDetail();
}

function findJob(id) {
  return safeJobs().find((j) => j.jobId === id);
}

function collectJobPhotoIds(job) {
  const ids = [];
  for (const point of job?.dirtPoints || []) {
    const photos = normalizePhotoRefs(point.photos);
    for (const slot of PHOTO_SLOTS) {
      const photoId = photos[slot.kind]?.photoId;
      if (photoId) ids.push(photoId);
    }
  }
  return ids;
}

async function deleteJobPhotoBlobs(job) {
  const failed = [];
  for (const photoId of collectJobPhotoIds(job)) {
    try {
      await deletePhotoBlob(photoId);
    } catch (e) {
      console.warn("お客様写真本体の削除に失敗", photoId, e);
      failed.push(photoId);
    }
  }
  return failed;
}

async function deleteJobById(jobId) {
  const job = findJob(jobId);
  if (!job) return;
  const failedDeletes = await deleteJobPhotoBlobs(job);
  state.jobs = safeJobs().filter((item) => item.jobId !== jobId);
  clearDetailDraftForJob(jobId);
  albumCheckCache.delete(jobId);
  albumSaveFallbackVisible.delete(jobId);
  if (detailJobId === jobId) detailJobId = null;
  const saved = saveLocal();
  renderJobs();
  if (!saved) {
    alert("お客様は画面上で削除しましたが、ブラウザ保存に失敗しました。");
  } else if (failedDeletes.length > 0) {
    alert("お客様は削除しました。一部の写真本体だけ端末内に残った可能性があります。");
  } else {
    setFlashSaveMessage(`${customerDisplayName(job.customerName)} を削除しました。`);
    renderJobs();
  }
}

async function deleteJobsByIds(jobIds) {
  const ids = [...new Set((jobIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!ids.length) {
    showSaveToast("削除対象がありませんでした。", "warn");
    return;
  }

  const jobs = ids
    .map((id) => findJob(id))
    .filter((job) => job?.jobId)
    .filter((job, index, self) => self.findIndex((item) => item.jobId === job.jobId) === index);

  if (!jobs.length) {
    showSaveToast("削除対象が見つかりませんでした。", "warn");
    return;
  }

  const failedDeletes = [];
  for (const job of jobs) {
    failedDeletes.push(...(await deleteJobPhotoBlobs(job)));
  }

  const idSet = new Set(jobs.map((job) => job.jobId));
  state.jobs = safeJobs().filter((item) => !idSet.has(item.jobId));
  jobs.forEach((job) => {
    detailDraftsByJob.delete(job.jobId);
    albumCheckCache.delete(job.jobId);
    albumSaveFallbackVisible.delete(job.jobId);
  });
  persistDetailDrafts();
  if (detailJobId && idSet.has(detailJobId)) {
    detailJobId = null;
  }

  const saved = saveLocal();
  renderJobs();

  if (!saved) {
    alert("選択したお客様は画面上で削除しましたが、ブラウザ保存に失敗しました。写真再読み込み後は復元される可能性があります。");
    return;
  }

  const deletedCount = jobs.length;
  setFlashSaveMessage(`${deletedCount}件のお客様を削除しました。`);
  if (failedDeletes.length > 0) {
    alert("お客様は削除しました。一部の写真本体だけ端末内に残った可能性があります。");
  }
}

async function deleteAllJobs() {
  if (!confirm("お客様一覧をすべて削除しますか？\n\n端末内に保存した写真も削除します。この操作は元に戻せません。")) return;
  if (!confirm("本当に全削除しますか？\n\n必要なら先にJSONをダウンロードしてください。")) return;
  const jobs = [...safeJobs()];
  const failedDeletes = [];
  for (const job of jobs) {
    failedDeletes.push(...(await deleteJobPhotoBlobs(job)));
  }
  state.jobs = [];
  detailJobId = null;
  clearAllDetailDrafts();
  albumCheckCache.clear();
  albumSaveFallbackVisible.clear();
  const saved = saveLocal();
  setFlashSaveMessage(saved ? "お客様一覧をすべて削除しました。" : "全削除しましたが、ブラウザ保存に失敗しました。");
  renderJobs();
  if (failedDeletes.length > 0) {
    alert("全削除しました。一部の写真本体だけ端末内に残った可能性があります。");
  }
}

function renderPhotoSlots(point, pointIndex) {
  const photos = normalizePhotoRefs(point.photos);
  point.photos = photos;
  const status = photoPairStatus(point);
  const shareBtn = shareButtonSpec();
  const copyDev = isPcDevCopyEnabled();
  const rawShareDev = isPcDevCopyEnabled();
  const hasBeforeAfter = Boolean(photos.before && photos.after);
  const isProcess = (kind) => kind === "process";
  return `
    <p class="photo-status"><span class="badge ${status.className}">${escapeHtml(status.label)}</span></p>
    <div class="photo-slots" data-photo-row="${pointIndex}">
      ${PHOTO_SLOTS.map((slot) => {
        const ref = photos[slot.kind];
        const key = `${pointIndex}:${slot.kind}`;
        const processNote = isProcess(slot.kind)
          ? `<p class="hint">作業中の写真も画像チェックと一括画像に反映されます。</p>`
          : "";
        return `
        <div class="photo-slot">
          <div class="photo-slot-head">
            <span class="photo-label">${escapeHtml(slot.label)}</span>
            ${ref ? `<button type="button" class="photo-delete" data-photo-delete="${key}">削除</button>` : ""}
          </div>
          <div class="photo-preview" data-photo-preview="${key}">
            ${ref ? `<span class="photo-loading">読込中…</span>` : `<span class="photo-empty">未登録</span>`}
          </div>
          <div class="photo-input-row">
            <label class="btn btn-small photo-button">
              撮る
              <input type="file" accept="image/*" capture="environment" data-photo-capture="${key}" hidden>
            </label>
            <label class="btn btn-small photo-button">
              選ぶ
              <input type="file" accept="image/*" data-photo-pick="${key}" hidden>
            </label>
          </div>
          ${processNote}
        ${
          copyDev && ref
            ? `<div class="photo-export-row">
            <button type="button" class="btn btn-small" data-point-line-export="${key}" ${
              shareBtn.disabled ? "disabled" : ""
            } title="開発者モード: 生写真を共有/保存（お客様送付禁止）">送信用画像を共有/保存（開発者）</button>
            ${
              !isProcess(slot.kind)
                ? `<button type="button" class="btn btn-small" data-photo-copy="${key}" title="開発者モード: PC向けコピー">コピー（開発者）</button>`
                : ""
            }
          </div>`
                : ""
        }
      </div>`;
      }).join("")}
    </div>
    ${
      isDevMode()
        ? `<div class="line-image-panel">
      <h3>送る画像（この洗う場所）</h3>
      <p class="hint">開発者確認用。通常は「このお客様分を1枚にまとめる」だけを使います。</p>
      <div class="btn-row">
        <button type="button" class="btn btn-small" data-line-image-export="${pointIndex}" ${
          hasBeforeAfter ? "" : "disabled"
        } title="${escapeHtml(shareBtn.title)}">送信用画像を共有/保存</button>
      </div>
      ${hasBeforeAfter ? "" : `<p class="hint hint-warn">Before / After が揃うと作成できます。</p>`}
    </div>`
        : ""
    }
  `;
}

function parsePhotoActionKey(raw) {
  const [pointIndexText, kind] = String(raw || "").split(":");
  return { pointIndex: Number(pointIndexText), kind };
}

function wirePhotoExportHandlers(job) {
  main.querySelectorAll("[data-photo-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) {
        setDetailStatus("コピー不可です。保存してから LINE に添付してください。", "warn");
        return;
      }
      const { pointIndex, kind } = parsePhotoActionKey(btn.dataset.photoCopy);
      try {
        await copyPhotoForLine(job, pointIndex, kind);
        setDetailStatus("画像をクリップボードにコピーしました。LINE デスクトップへ貼り付けできます。", "ok");
      } catch (e) {
        setDetailStatus(`コピーに失敗しました: ${e.message}`, "warn");
      }
    });
  });

  main.querySelectorAll("[data-point-line-export]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) {
        setDetailStatus("Before / After が揃っていないため、送信用画像を作れません。", "warn");
        return;
      }
      try {
        const { pointIndex } = parsePhotoActionKey(btn.dataset.pointLineExport);
        const result = await shareLineCompositeForPoint(job, Number(pointIndex));
        if (result.mode === "share") {
          setDetailStatus("送信用画像の共有画面を開きました。送信前提で選択してください。", "ok");
        } else {
          setDetailStatus("共有が難しい端末のため保存しました。", "ok");
        }
      } catch (e) {
        setDetailStatus(`送信用画像の作成に失敗しました: ${e.message}`, "warn");
      }
    });
  });

  wireAlbumPanelHandlers(job);
}

async function hydratePhotoThumbs(job, seq) {
  for (const [pointIndex, point] of (job.dirtPoints || []).entries()) {
    const photos = normalizePhotoRefs(point.photos);
    for (const slot of PHOTO_SLOTS) {
      const ref = photos[slot.kind];
      if (!ref) continue;
      const target = main.querySelector(`[data-photo-preview="${pointIndex}:${slot.kind}"]`);
      if (!target) continue;
      try {
        const blob = await getPhotoBlob(ref.photoId);
        if (seq !== photoRenderSeq) return;
        if (!blob) {
          target.innerHTML = `<span class="photo-missing">写真データなし</span>`;
          continue;
        }
        const url = URL.createObjectURL(blob);
        activePhotoUrls.push(url);
        target.innerHTML = `<img src="${url}" alt="${escapeHtml(slot.label)} ${escapeHtml(point.name)}">`;
      } catch (e) {
        if (seq !== photoRenderSeq) return;
        target.innerHTML = `<span class="photo-missing">${escapeHtml(e.message)}</span>`;
      }
    }
  }
}

function syncPointsFromForm(job) {
  const rows = [...main.querySelectorAll("[data-point-row]")];
  if (rows.length === 0) return;
  job.dirtPoints = rows.map((row, order) => {
    const idx = Number(row.dataset.pointRow);
    const point = job.dirtPoints[idx] || normalizePoint({}, order, job.jobId);
    const nameEl = row.querySelector("[data-point-name-idx]");
    const checkEl = row.querySelector("[data-point-idx]");
    const name = nameEl ? String(nameEl.value || "").trim() : "";
    point.name = name || `ポイント${order + 1}`;
    point.manualCompletedChecked = checkEl ? checkEl.checked : false;
    point.displayOrder = order + 1;
    point.jobId = job.jobId;
    point.photos = normalizePhotoRefs(point.photos);
    return point;
  });
}

function verifyPhotoRefInStorage(jobId, pointIndex, kind, expectedPhotoId, pointId = "") {
  const stored = readStateFromStorage();
  if (!stored) return false;
  const job = stored.jobs.find((x) => x.jobId === jobId);
  const point =
    (pointId && job?.dirtPoints?.find((item) => item.pointId === pointId)) ||
    job?.dirtPoints?.[pointIndex];
  const ref = normalizePhotoRefs(point?.photos)[kind];
  return (ref?.photoId || null) === (expectedPhotoId || null);
}

function repairPhotoRefInStorage(job, pointIndex, kind, expectedRef, pointId = "") {
  const stored = readStateFromStorage();
  if (!stored || !expectedRef?.photoId) return false;
  const storedJob = stored.jobs.find((x) => x.jobId === job.jobId);
  if (!storedJob) return false;
  storedJob.customerName = job.customerName;
  storedJob.serviceCode = job.serviceCode;
  storedJob.workDate = job.workDate;
  storedJob.sendPlannedDate = job.sendPlannedDate;
  storedJob.photoStorage = job.photoStorage;
  storedJob.lineAlbum = { ...storedJob.lineAlbum, ...job.lineAlbum };
  const storedPoint =
    (pointId && storedJob.dirtPoints?.find((item) => item.pointId === pointId)) ||
    storedJob.dirtPoints?.[pointIndex];
  const sourcePoint =
    (pointId && job.dirtPoints?.find((item) => item.pointId === pointId)) ||
    job.dirtPoints?.[pointIndex];
  if (!storedPoint || !sourcePoint) return false;
  storedPoint.name = sourcePoint.name;
  storedPoint.manualCompletedChecked = sourcePoint.manualCompletedChecked;
  storedPoint.photos = normalizePhotoRefs(storedPoint.photos);
  storedPoint.photos[kind] = { ...expectedRef };
  state = stored;
  if (!saveLocal()) return false;
  return verifyPhotoRefInStorage(job.jobId, pointIndex, kind, expectedRef.photoId, pointId);
}

function ensurePhotoRefPersisted(job, pointIndex, kind, expectedRef, pointId = "") {
  if (verifyPhotoRefInStorage(job.jobId, pointIndex, kind, expectedRef?.photoId, pointId)) {
    return { ok: true, repaired: false };
  }
  const repaired = repairPhotoRefInStorage(job, pointIndex, kind, expectedRef, pointId);
  return { ok: repaired, repaired };
}

async function rollbackNewPhoto(job, pointIndex, point, kind, newRef, restoreRef) {
  point.photos = normalizePhotoRefs(point.photos);
  point.photos[kind] = restoreRef ? { ...restoreRef } : null;
  try {
    await deletePhotoBlob(newRef.photoId);
  } catch (e) {
    console.warn("新写真のロールバック削除に失敗", newRef.photoId, e);
  }
  if (!saveLocal()) return false;
  return verifyPhotoRefInStorage(job.jobId, pointIndex, kind, restoreRef?.photoId || null, point.pointId);
}

async function handlePhotoInput(job, pointIndex, kind, file) {
  cancelDetailAutoSave();
  const draft = captureDetailDraft(job);
  let point = null;
  let oldRef = null;
  let ref = null;
  let swapped = false;
  let pointId = "";
  try {
    syncDetailFormToJob(job);
    restoreDetailDraftToJob(job, draft);
    setDetailDraftFromJob(job);
    point = job.dirtPoints[pointIndex];
    if (!point || !PHOTO_SLOTS.some((slot) => slot.kind === kind)) return;
    pointId = point.pointId;
    const blob = await compressPhoto(file);
    point.photos = normalizePhotoRefs(point.photos);
    oldRef = point.photos[kind] ? { ...point.photos[kind] } : null;
    ref = {
      photoId: newId("photo"),
      kind,
      name: `${kind}.jpg`,
      mimeType: blob.type || "image/jpeg",
      size: blob.size,
      createdAt: new Date().toISOString(),
    };
    await putPhotoBlob(ref, blob);
    const savedBlob = await getPhotoBlob(ref.photoId);
    if (!savedBlob) throw new Error("写真本体の保存確認に失敗しました");

    point.photos[kind] = ref;
    swapped = true;

    if (!saveLocal()) {
      const restored = await rollbackNewPhoto(job, pointIndex, point, kind, ref, oldRef);
      restoreAndPersistDetailDraft(job, draft);
      alert(
        restored
          ? "写真本体は保存しましたが、メタ情報の保存に失敗しました。旧写真に戻しました。"
          : "写真本体は保存しましたが、メタ情報の保存に失敗しました。旧写真への復帰保存も確認できませんでした。"
      );
      renderDetail();
      return;
    }

    const persistResult = ensurePhotoRefPersisted(job, pointIndex, kind, ref, pointId);
    if (!persistResult.ok) {
      const restored = await rollbackNewPhoto(job, pointIndex, point, kind, ref, oldRef);
      restoreAndPersistDetailDraft(job, draft);
      alert(
        restored
          ? "写真の保存確認が完了できなかったため、写真だけ旧状態に戻しました。入力したお客様名は保持しています。"
          : "写真の保存確認が完了できず、旧写真への復帰保存も確認できませんでした。入力したお客様名は保持しています。"
      );
      renderDetail();
      return;
    }

    if (oldRef?.photoId) {
      try {
        await deletePhotoBlob(oldRef.photoId);
      } catch (e) {
        console.warn("旧写真の削除に失敗（新写真は保存済み）", oldRef.photoId, e);
      }
    }

    const stored = readStateFromStorage();
    if (stored) state = stored;
    const latestJob = findJob(job.jobId) || job;
    restoreAndPersistDetailDraft(latestJob, draft);
    markAlbumStale(job.jobId);
    if (persistResult.repaired) {
      setFlashSaveMessage("写真保存を自動修復して保存しました。");
    }
    renderDetail();
  } catch (e) {
    if (ref?.photoId) {
      if (swapped && point) {
        await rollbackNewPhoto(job, pointIndex, point, kind, ref, oldRef);
      } else {
        try {
          await deletePhotoBlob(ref.photoId);
        } catch (deleteError) {
          console.warn("保存失敗後の新写真削除に失敗", ref.photoId, deleteError);
        }
      }
    }
    restoreAndPersistDetailDraft(job, draft);
    alert("写真の保存に失敗しました: " + e.message);
    if (swapped) renderDetail();
  }
}

async function handlePhotoDelete(job, pointIndex, kind) {
  try {
    cancelDetailAutoSave();
    syncDetailFormToJob(job);
    const point = job.dirtPoints[pointIndex];
    if (!point) return;
    point.photos = normalizePhotoRefs(point.photos);
    const ref = point.photos[kind];
    if (!ref) return;
    await deletePhotoBlob(ref.photoId);
    point.photos[kind] = null;
    saveLocal();
    markAlbumStale(job.jobId);
    renderDetail();
  } catch (e) {
    alert("写真の削除に失敗しました: " + e.message);
  }
}

async function handlePointDelete(job, idx) {
  try {
    cancelDetailAutoSave();
    syncDetailFormToJob(job);
    const point = job.dirtPoints[idx];
    if (!point) return;
    const photoIds = PHOTO_SLOTS.map((slot) => point.photos?.[slot.kind]?.photoId).filter(Boolean);
    const failedDeletes = [];
    for (const photoId of photoIds) {
      try {
        await deletePhotoBlob(photoId);
      } catch (e) {
        console.warn("写真本体の削除に失敗", photoId, e);
        failedDeletes.push(photoId);
      }
    }
    job.dirtPoints.splice(idx, 1);
    job.dirtPoints.forEach((p, i) => {
      p.displayOrder = i + 1;
      p.jobId = job.jobId;
    });
    markAlbumStale(job.jobId);
    const saved = saveLocal();
    renderDetail();
    if (!saved) {
      alert("ポイントは画面上で削除しましたが、ブラウザ保存に失敗しました。");
    } else if (failedDeletes.length > 0) {
      alert("ポイントは削除しました。一部の写真本体だけ端末内に残った可能性があります。");
    }
  } catch (e) {
    alert("ポイントの削除に失敗しました: " + e.message);
  }
}

function handlePointAdd(job) {
  if (!job) return;
  cancelDetailAutoSave();
  const draft = captureDetailDraft(job);
  syncDetailForm(job);
  const idx = Array.isArray(job.dirtPoints) ? job.dirtPoints.length : 0;
  if (!Array.isArray(job.dirtPoints)) job.dirtPoints = [];
  const point = normalizePoint({ name: `洗う場所${idx + 1}` }, idx, job.jobId);
  job.dirtPoints.push(point);
  const nextDraft = {
    ...draft,
    jobId: String(job.jobId),
    updatedAt: Date.now(),
    points: [
      ...(Array.isArray(draft.points) ? draft.points : []),
      {
        order: idx,
        pointId: point.pointId,
        name: point.name,
        manualCompletedChecked: false,
      },
    ],
  };
  restoreDetailDraftToJob(job, nextDraft);
  detailDraftsByJob.set(nextDraft.jobId, nextDraft);
  persistDetailDrafts();
  markAlbumStale(job.jobId);
  saveLocal();
  renderDetail();
  window.setTimeout(() => {
    const latestJob = findJob(job.jobId);
    if (!latestJob) return;
    const expectedCount = nextDraft.points.length;
    const actualCount = Array.isArray(latestJob.dirtPoints) ? latestJob.dirtPoints.length : 0;
    if (actualCount >= expectedCount) return;
    restoreAndPersistDetailDraft(latestJob, nextDraft);
    if (detailJobId === latestJob.jobId) renderDetail();
  }, 0);
}

async function clearAllPhotoRefs() {
  await clearPhotoDb();
  for (const job of safeJobs()) {
    for (const point of job.dirtPoints || []) {
      point.photos = normalizePhotoRefs({});
    }
  }
  saveLocal();
}

function reportCss() {
  return `
    body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Segoe UI",sans-serif;margin:0;background:#f4f6f8;color:#1a1a1a;line-height:1.6}
    main{max-width:880px;margin:0 auto;padding:20px}
    header{background:#1565c0;color:#fff;padding:20px}
    h1{margin:0;font-size:24px}
    .meta{color:#5c6570;font-size:14px}
    .card{background:#fff;border:1px solid #dde3ea;border-radius:8px;padding:16px;margin:14px 0;break-inside:avoid}
    .grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
    .slot{border:1px solid #dde3ea;border-radius:8px;padding:8px;background:#f9fbfd}
    .slot h3{font-size:14px;margin:0 0 8px}
    img{display:block;width:100%;max-height:260px;object-fit:cover;border-radius:6px;background:#fff}
    .empty{min-height:120px;display:flex;align-items:center;justify-content:center;border:1px dashed #b8c4d1;border-radius:6px;color:#5c6570}
    @media(max-width:640px){main{padding:12px}.grid{grid-template-columns:1fr}}
    .report-dev-banner{background:#ffebee;border:2px solid #e53935;border-radius:8px;padding:12px;margin-bottom:12px;color:#b71c1c}
    .report-dev-banner strong{display:block;font-size:16px;margin-bottom:6px}
  `;
}

async function buildJobReportContentHtml(job) {
  const points = Array.isArray(job.dirtPoints) ? job.dirtPoints : [];
  const pointHtml = [];
  for (const point of points) {
    const photos = normalizePhotoRefs(point.photos);
    const slotHtml = [];
    for (const slot of PHOTO_SLOTS) {
      const ref = photos[slot.kind];
      let img = "";
      if (ref?.photoId) {
        try {
          const dataUrl = await getPhotoDataUrl(ref.photoId);
          img = dataUrl ? `<img src="${dataUrl}" alt="${escapeHtml(point.name)} ${escapeHtml(slot.label)}">` : "";
        } catch (_) {}
      }
      slotHtml.push(`
        <section class="slot">
          <h3>${escapeHtml(slot.label)}</h3>
          ${img || `<div class="empty">未撮影</div>`}
        </section>
      `);
    }
    pointHtml.push(`
      <section class="card">
        <h2>${escapeHtml(point.name)}</h2>
        <p class="meta">作業完了: ${point.manualCompletedChecked ? "済" : "未"}</p>
        <div class="grid">${slotHtml.join("")}</div>
      </section>
    `);
  }
  return `
    <section class="report-dev-banner">
      <strong>開発者確認用 · お客様送付禁止</strong>
      <p>この画面は ?dev=1 の確認HTMLです。LINE やお客様へ送らないでください。</p>
    </section>
    <section class="report-hero">
      <h1>作業写真確認（開発者）</h1>
      <p>${escapeHtml(job.customerName)} / ${escapeHtml(serviceLabel(job.serviceCode))}</p>
    </section>
    <section class="card">
      <p>作業日: ${escapeHtml(job.workDate || "-")}</p>
      <p>送る写真: ${escapeHtml(job.photoVerified)} / LINE写真: ${escapeHtml(job.linePhotoSent)}</p>
    </section>
    ${pointHtml.join("") || `<section class="card">洗う場所がありません</section>`}
  `;
}

async function buildJobReportHtml(job) {
  const content = await buildJobReportContentHtml(job);
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(job.customerName)} 作業写真確認</title>
  <style>${reportCss()}</style>
</head>
<body>
  <main>
    ${content}
  </main>
</body>
</html>`;
}

function lineAlbumFilename(job, part, total) {
  return lineAlbumFilenamePure(job.customerName, part, total);
}

async function loadPointImages(entry) {
  const beforeBlob = await getPhotoBlob(entry.photos.before.photoId);
  const afterBlob = await getPhotoBlob(entry.photos.after.photoId);
  if (!beforeBlob || !afterBlob) throw new Error(`${entry.point.name} の写真データがありません`);
  const processBlob = entry.photos.process?.photoId ? await getPhotoBlob(entry.photos.process.photoId) : null;
  const [beforeImg, afterImg, processImg] = await Promise.all([
    loadImage(beforeBlob),
    loadImage(afterBlob),
    processBlob ? loadImage(processBlob) : Promise.resolve(null),
  ]);
  return { beforeImg, afterImg, processImg };
}

function photoSlotLabel(kind) {
  return PHOTO_SLOTS.find((slot) => slot.kind === kind)?.label || kind;
}

function photoExportFilename(job, point, kind) {
  return `${safeFilePart(job.jobId)}_${safeFilePart(point.name)}_${safeFilePart(photoSlotLabel(kind))}.jpg`;
}

function lineCompositeFilename(job, point) {
  return `${safeFilePart(point.name || "作業写真")}.jpg`;
}

function drawContainImage(ctx, img, x, y, w, h, bg = CANVAS_FILL) {
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, h);
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const scale = Math.min(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function drawReadableLineImage(ctx, img, x, y, w, h, bg = CANVAS_FILL) {
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, h);
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const containScale = Math.min(w / iw, h / ih);
  const imageRatio = iw / ih;
  const frameRatio = w / h;
  const isTallPhoto = imageRatio < frameRatio * 0.72;
  const scale = isTallPhoto ? Math.min(Math.max(containScale * 1.28, containScale), w / iw) : containScale;
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}

function drawOutsideLabelBand(ctx, text, x, y, w, bgColor, textColor = "#ffffff", borderColor = "") {
  ctx.fillStyle = bgColor;
  ctx.fillRect(x, y, w, LINE_LABEL_BAND_H);
  if (borderColor) {
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 1.5, y + 1.5, w - 3, LINE_LABEL_BAND_H - 3);
  }
  ctx.fillStyle = textColor;
  ctx.font = "700 28px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + w / 2, y + LINE_LABEL_BAND_H / 2);
  return LINE_LABEL_BAND_H;
}

function drawCenteredText(ctx, text, x, y, maxWidth, font, color = "#1a1a1a") {
  ctx.save();
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const s = String(text || "");
  let size = Number((font.match(/(\d+)px/) || [])[1] || 30);
  while (ctx.measureText(s).width > maxWidth && size > 18) {
    size -= 2;
    ctx.font = font.replace(/\d+px/, `${size}px`);
  }
  ctx.fillText(s, x, y);
  ctx.restore();
}

async function canvasToSizedBlob(canvas, targetBytes = LINE_TARGET_BYTES) {
  let lastBlob = null;
  for (const quality of LINE_JPEG_QUALITIES) {
    const blob = await new Promise((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", quality);
    });
    if (!blob) throw new Error("JPEG 生成に失敗しました");
    lastBlob = blob;
    if (blob.size <= targetBytes) {
      return { blob, size: blob.size, quality, withinTarget: true };
    }
  }
  if (!lastBlob) throw new Error("JPEG 生成に失敗しました");
  return { blob: lastBlob, size: lastBlob.size, quality: LINE_JPEG_QUALITIES.at(-1), withinTarget: false };
}

function analyzeJobAlbumPoints(job) {
  syncPointsFromForm(job);
  return analyzeJobAlbumPointsFromPoints(job.dirtPoints);
}

async function renderJobAlbumCanvas(job, chunk, excluded, part, total, messageText) {
  const width = LINE_CANVAS_MAX_WIDTH;
  const splitLabel = total > 1;
  const excludedPlan = planExcludedDisplay(excluded, chunk.length, splitLabel, messageText);
  const height = resolveAlbumCanvasHeight(chunk.length, excludedPlan, splitLabel, messageText);
  assertCanvasLimits(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画像作成に対応していません");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = LABEL_AFTER_BG;
  ctx.fillRect(0, 0, width, 8);
  const header = buildLineImageHeaderTexts(job, serviceLabel(job.serviceCode));
  drawCenteredText(ctx, header.title, width / 2, 42, width - 80, "700 34px sans-serif");
  drawCenteredText(
    ctx,
    header.subtitle,
    width / 2,
    82,
    width - 80,
    "600 26px sans-serif",
    "#5c6570"
  );

  let y = LINE_HEADER_H;
  if (total > 1) {
    drawCenteredText(ctx, `${part}/${total}`, width / 2, y + 18, width - 80, "700 28px sans-serif", "#5c6570");
    y += 36;
  }

  const margin = 24;
  const innerW = width - margin * 2;

  for (const entry of chunk) {
    const { beforeImg, afterImg, processImg } = await loadPointImages(entry);
    ctx.fillStyle = LABEL_AFTER_BG;
    ctx.fillRect(margin, y, innerW, LINE_POINT_NAME_H);
    drawCenteredText(
      ctx,
      entry.point.name,
      width / 2,
      y + LINE_POINT_NAME_H / 2,
      innerW,
      "800 30px sans-serif",
      "#ffffff"
    );
    y += LINE_POINT_NAME_H;

    const slots = [
      { label: "Before", img: beforeImg, color: LABEL_BEFORE_BG, textColor: LABEL_BEFORE_TEXT, borderColor: LABEL_BEFORE_TEXT },
      { label: "After", img: afterImg, color: LABEL_AFTER_BG, textColor: LABEL_AFTER_TEXT },
    ];
    if (processImg) slots.push({ label: "作業中", img: processImg, color: "#5c6570" });
    const colW = (innerW - LINE_POINT_COL_GAP * (slots.length - 1)) / slots.length;
    const rowTop = y;

    slots.forEach((slot, index) => {
      const x = margin + index * (colW + LINE_POINT_COL_GAP);
      drawOutsideLabelBand(ctx, slot.label, x, rowTop, colW, slot.color, slot.textColor, slot.borderColor);
      drawReadableLineImage(ctx, slot.img, x, rowTop + LINE_LABEL_BAND_H, colW, LINE_POINT_IMAGE_H);
    });
    y = rowTop + LINE_LABEL_BAND_H + LINE_POINT_IMAGE_H + LINE_POINT_GAP;
  }

  if (excludedPlan.shown.length > 0 || excludedPlan.omitted > 0) {
    const lineCount =
      excludedPlan.omitted > 0 ? excludedPlan.shown.length + 1 : excludedPlan.shown.length;
    ctx.fillStyle = "#fff3e0";
    ctx.fillRect(margin, y, innerW, EXCLUDED_HEADER_H + lineCount * EXCLUDED_LINE_H);
    ctx.fillStyle = "#e65100";
    ctx.font = "700 24px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("未掲載:", margin + 8, y + 6);
    excludedPlan.shown.forEach((item, idx) => {
      ctx.font = "600 22px sans-serif";
      ctx.fillText(`${item.point.name}（${item.reason}）`, margin + 8, y + 30 + idx * EXCLUDED_LINE_H);
    });
    if (excludedPlan.omitted > 0) {
      ctx.font = "600 22px sans-serif";
      ctx.fillText(
        `他 ${excludedPlan.omitted} 件`,
        margin + 8,
        y + 30 + excludedPlan.shown.length * EXCLUDED_LINE_H
      );
    }
    y += EXCLUDED_HEADER_H + lineCount * EXCLUDED_LINE_H;
  }

  ctx.fillStyle = CANVAS_FILL;
  ctx.fillRect(0, height - LINE_FOOTER_H, width, LINE_FOOTER_H);
  drawCenteredText(
    ctx,
    "作業前後の比較写真です",
    width / 2,
    height - LINE_FOOTER_H / 2,
    width - 80,
    "700 26px sans-serif"
  );

  return canvas;
}

async function createJobAlbumBlobs(job, messageText) {
  const validation = validateLineAlbumMessage(messageText);
  if (!validation.ok) {
    throw new Error(validation.message);
  }
  const text = validation.text;
  syncPointsFromForm(job);
  const { included, excluded } = analyzeJobAlbumPointsFromPoints(job.dirtPoints);
  if (included.length === 0) {
    throw new Error("Before / After が揃った洗う場所がありません。");
  }

  let chunks = splitIncludedPoints(included);
  let blobs = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    blobs = [];
    const parts = planLineAlbumPartsFromChunks(chunks, excluded);
    for (let i = 0; i < parts.length; i += 1) {
      const partPlan = parts[i];
      const canvas = await renderJobAlbumCanvas(
        job,
        partPlan.included,
        partPlan.excluded,
        partPlan.part,
        partPlan.total,
        text
      );
      const sized = await canvasToSizedBlob(canvas);
      if (!sized.withinTarget) {
        if (partPlan.included.length > 1) {
          const mid = Math.ceil(partPlan.included.length / 2);
          const left = chunks.slice(0, i);
          const right = chunks.slice(i + 1);
          chunks = [...left, partPlan.included.slice(0, mid), partPlan.included.slice(mid), ...right];
          blobs = null;
          break;
        }
        throw new Error(
          `一括画像が大きすぎます（${Math.round(sized.size / 1024)}KB）。洗う場所を減らすか、写真を選び直してください。`
        );
      }
      blobs.push({
        blob: sized.blob,
        size: sized.size,
        part: partPlan.part,
        total: partPlan.total,
        filename: `${String(partPlan.part).padStart(2, "0")}_${safeFilePart(partPlan.included[0]?.point?.name || "作業写真")}.jpg`,
        withinTarget: sized.withinTarget,
      });
    }
    if (blobs) return { blobs, included, excluded, messageText: text };
  }
  throw new Error("一括画像の生成に失敗しました");
}

async function createLineCompositeBlob(job, pointIndex) {
  syncPointsFromForm(job);
  const point = job.dirtPoints[pointIndex];
  if (!point) throw new Error("洗う場所がありません");
  const photos = normalizePhotoRefs(point.photos);
  const beforeRef = photos.before;
  const afterRef = photos.after;
  if (!beforeRef?.photoId || !afterRef?.photoId) {
    throw new Error("Before と After の両方が必要です");
  }
  const beforeBlob = await getPhotoBlob(beforeRef.photoId);
  const afterBlob = await getPhotoBlob(afterRef.photoId);
  if (!beforeBlob || !afterBlob) {
    throw new Error("写真データが端末内にありません");
  }

  const [beforeImg, afterImg] = await Promise.all([loadImage(beforeBlob), loadImage(afterBlob)]);
  const width = LINE_CANVAS_MAX_WIDTH;
  const imageAreaH = 520;
  const height = LINE_HEADER_H + LINE_LABEL_BAND_H + imageAreaH + LINE_FOOTER_H;
  assertCanvasLimits(width, height);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画像作成に対応していません");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = LABEL_AFTER_BG;
  ctx.fillRect(0, 0, width, 8);
  const header = buildLineImageHeaderTexts(job, serviceLabel(job.serviceCode));
  drawCenteredText(ctx, header.title, width / 2, 42, width - 80, "700 34px sans-serif");
  drawCenteredText(
    ctx,
    `${point.name}  ${header.subtitle}`,
    width / 2,
    82,
    width - 80,
    "600 26px sans-serif",
    "#5c6570"
  );

  const margin = 28;
  const gap = 18;
  const imageY = LINE_HEADER_H;
  const imageW = (width - margin * 2 - gap) / 2;
  const beforeX = margin;
  const afterX = margin + imageW + gap;

  let rowY = imageY;
  rowY += drawOutsideLabelBand(ctx, "Before", beforeX, rowY, imageW, LABEL_BEFORE_BG, LABEL_BEFORE_TEXT, LABEL_BEFORE_TEXT);
  drawReadableLineImage(ctx, beforeImg, beforeX, rowY, imageW, imageAreaH - LINE_LABEL_BAND_H);
  rowY = imageY;
  rowY += drawOutsideLabelBand(ctx, "After", afterX, rowY, imageW, LABEL_AFTER_BG, LABEL_AFTER_TEXT);
  drawReadableLineImage(ctx, afterImg, afterX, rowY, imageW, imageAreaH - LINE_LABEL_BAND_H);

  ctx.fillStyle = CANVAS_FILL;
  ctx.fillRect(0, height - LINE_FOOTER_H, width, LINE_FOOTER_H);
  drawCenteredText(
    ctx,
    "作業前後の比較写真です",
    width / 2,
    height - LINE_FOOTER_H / 2,
    width - 80,
    "700 26px sans-serif"
  );

  const sized = await canvasToSizedBlob(canvas);
  if (!sized.withinTarget) {
    throw new Error(
      `送信用画像が ${Math.round(sized.size / 1024)}KB で 4MB を超えます。写真を選び直すか、一括画像の分割を検討してください。`
    );
  }
  return { blob: sized.blob, point, size: sized.size };
}

async function downloadLineCompositeForPoint(job, pointIndex) {
  const { blob, point, size } = await createLineCompositeBlob(job, pointIndex);
  const filename = lineCompositeFilename(job, point);
  await saveBlobForUser(blob, filename, {
    preferShare: isAppleMobileDevice(),
    disableShare: isAppleMobileDevice(),
    fallbackToDownloadOnShareError: true,
  });
  return { filename, size };
}

async function shareLineCompositeForPoint(job, pointIndex) {
  const { blob, point, size } = await createLineCompositeBlob(job, pointIndex);
  const filename = lineCompositeFilename(job, point);
  const file = buildImageFile(blob, filename);
  if (canShareFiles([file])) {
    await navigator.share({
      files: [file],
    });
    return { mode: "share", size };
  }
  await saveBlobForUser(blob, filename, {
    preferShare: isAppleMobileDevice(),
    disableShare: isAppleMobileDevice(),
    fallbackToDownloadOnShareError: true,
  });
  return { mode: "download_fallback", size };
}

async function downloadJobAlbumFromBlobs(job, blobs) {
  const names = [];
  for (const item of blobs) {
    const filename = lineAlbumFilename(job, item.part, item.total);
    await saveBlobForUser(item.blob, filename, {
      preferShare: isAppleMobileDevice(),
      disableShare: isAppleMobileDevice(),
      fallbackToDownloadOnShareError: true,
    });
    names.push(`${filename} (${Math.round(item.size / 1024)}KB)`);
    await new Promise((r) => setTimeout(r, 300));
  }
  return names;
}

async function downloadJobAlbum(job, messageText) {
  const text = messageText ?? getLineAlbumMessageText(job);
  const { blobs } = await createJobAlbumBlobs(job, text);
  return downloadJobAlbumFromBlobs(job, blobs);
}

function renderAlbumSummaryHtml(job) {
  const { included, excluded } = analyzeJobAlbumPoints(job);
  const includedNames = included.map((x) => escapeHtml(x.point.name)).join("、") || "—";
  const excludedHtml =
    excluded.length === 0
      ? ""
      : `<ul class="album-excluded-list">${excluded
          .map((x) => `<li>未掲載: ${escapeHtml(x.point.name)}（${escapeHtml(x.reason)}）</li>`)
          .join("")}</ul>`;
  return `
    <p class="album-preview-count"><strong>掲載: ${included.length}件 / 未掲載: ${excluded.length}件</strong></p>
    <p class="hint">掲載: ${includedNames}</p>
    ${excludedHtml}
  `;
}

function renderAlbumCheckPreviewHtml(job) {
  const entry = syncAlbumCheckEntry(job);
  if (entry.status === "checked" && entry.previewUrls.length > 0) {
    const imgs = entry.previewUrls
      .map(
        (url, index) => `
      <figure class="album-preview-figure">
        <img src="${url}" alt="一括画像プレビュー ${index + 1}">
        <figcaption>${index + 1} / ${entry.previewUrls.length}</figcaption>
      </figure>`
      )
      .join("");
    return `<div class="album-image-preview">${imgs}</div>`;
  }
  if (entry.status === "stale") {
    return `<p class="hint hint-warn">内容が変わりました。もう一度「画像チェック」を押してください。</p>`;
  }
  if (entry.status === "failed") {
    return `<p class="hint hint-warn">画像チェックに失敗しました。お礼文と写真を確認して、もう一度お試しください。</p>`;
  }
  return `<p class="hint">「画像チェック」で一括画像のプレビューを表示します。</p>`;
}

function updateAlbumPanelUi(job) {
  const entry = syncAlbumCheckEntry(job);
  const included = analyzeJobAlbumPoints(job).included.length;
  const messageValidation = validateLineAlbumMessage(getLineAlbumMessageText(job));
  const messageValid = messageValidation.ok;
  const canUseCheckedAlbum = isAlbumShareEnabled(entry.status) && entry.blobs.length > 0;
  const canShareCheckedAlbum = canUseCheckedAlbum && canShareAlbumBlobs(job, entry.blobs);
  const checkBtn = document.getElementById("btn-job-album-check");
  const shareSaveBtn = document.getElementById("btn-job-album-share-save");
  const statusEl = document.getElementById("album-check-status");
  const previewImages = document.getElementById("job-album-image-preview");
  const summary = document.getElementById("job-album-preview");

  if (summary) summary.innerHTML = renderAlbumSummaryHtml(job);
  if (previewImages) previewImages.innerHTML = renderAlbumCheckPreviewHtml(job);
  if (statusEl) {
    let statusText = `画像チェック: ${albumPreviewStatusLabel(entry.status)}`;
    let statusClass =
      entry.status === "checked"
        ? "ok"
        : entry.status === "stale" || entry.status === "failed"
          ? "warn"
          : "info";
    if (included === 0) {
      statusText = "画像チェック: Before / After が揃った洗う場所がありません";
      statusClass = "warn";
    } else if (!messageValid) {
      statusText = `画像チェック: ${messageValidation.message}`;
      statusClass = "warn";
    } else if (canUseCheckedAlbum && !canShareCheckedAlbum) {
      statusText = "画像チェック: 確認済み。ボタンを押すと保存用に開きます。写真アプリまたはファイルからLINEへ添付してください。";
      statusClass = "ok";
    }
    statusEl.textContent = statusText;
    statusEl.className = `save-status save-status-${statusClass}`;
  }
  if (checkBtn) checkBtn.disabled = !(included > 0 && messageValid);
  if (shareSaveBtn) {
    shareSaveBtn.disabled = !canUseCheckedAlbum;
    shareSaveBtn.textContent = "一括画像を出力";
    shareSaveBtn.title = canUseCheckedAlbum
      ? "確認済みの一括画像を共有シートまたは保存先へ出力します"
      : "先に画像チェックを完了してください";
  }
}

async function handleAlbumImageCheck(job) {
  applyDetailFormToJob(job);
  const messageText = getLineAlbumMessageText(job);
  const prev = getAlbumCheckEntry(job.jobId);
  revokeAlbumPreviewUrls(prev);

  setDetailStatus("一括画像を生成しています…", "info");
  try {
    const result = await createJobAlbumBlobs(job, messageText);
    const previewUrls = result.blobs.map((item) => URL.createObjectURL(item.blob));
    const fingerprint = buildAlbumContentFingerprint(job.dirtPoints, result.messageText);
    const checkedAt = new Date().toISOString();
    albumCheckCache.set(job.jobId, {
      status: "checked",
      fingerprint,
      blobs: result.blobs,
      previewUrls,
      checkedAt,
    });
    if (!job.lineAlbum) job.lineAlbum = {};
    job.lineAlbum.messageText = result.messageText;
    job.lineAlbum.messageSource = "manual";
    job.lineAlbum.layout = "job_before_after_grid_v1";
    job.lineAlbum.checkedAt = checkedAt;
    const saved = saveLocal();
    updateAlbumPanelUi(job);
    const sizeText = result.blobs.map((b) => `${Math.round(b.size / 1024)}KB`).join(" / ");
    setDetailStatus(
      `画像チェックOK。${result.blobs.length}枚（${sizeText}）。画像にはお礼文を入れず、出力時にLINE本文として先に渡します。${saved ? "" : " お礼文のブラウザ保存は未確認です。"}`,
      saved ? "ok" : "warn"
    );
    return result;
  } catch (e) {
    albumCheckCache.set(job.jobId, {
      status: "failed",
      fingerprint: "",
      blobs: [],
      previewUrls: [],
      checkedAt: null,
    });
    updateAlbumPanelUi(job);
    throw e;
  }
}

async function shareCachedJobAlbum(job) {
  const entry = syncAlbumCheckEntry(job);
  if (!isAlbumShareEnabled(entry.status)) {
    throw new Error("内容が変わりました。もう一度「画像チェック」を押してください。");
  }
  if (!entry.blobs.length) {
    throw new Error("共有する一括画像がありません。もう一度「画像チェック」を押してください。");
  }

  const files = albumFilesFromBlobs(job, entry.blobs);

  if (canShareFiles(files)) {
    const messageText = getLineAlbumMessageText(job).trim();
    await navigator.share({
      files,
      text: messageText,
    });
    return {
      mode: "share",
      count: files.length,
      sizes: entry.blobs.map((b) => b.size),
    };
  }
  const names = await downloadJobAlbumFromBlobs(job, entry.blobs);
  return {
    mode: "download",
    count: names.length,
    names,
    sizes: entry.blobs.map((b) => b.size),
  };
}

function wireAlbumPanelHandlers(job) {
  ["f-line-album-message", "f-customerName", "f-serviceCode", "f-workDate"].forEach((id) => {
    const el = document.getElementById(id);
    el?.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
      markAlbumStale(job.jobId);
      updateAlbumPanelUi(job);
    });
  });

  main.querySelectorAll("[data-point-name-idx]").forEach((input) => {
    input.addEventListener("input", () => {
      markAlbumStale(job.jobId);
      updateAlbumPanelUi(job);
    });
  });

  document.getElementById("btn-job-album-check")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-job-album-check");
    try {
      btn.disabled = true;
      await handleAlbumImageCheck(job);
    } catch (e) {
      setDetailStatus(e.message, "warn");
    } finally {
      updateAlbumPanelUi(job);
    }
  });

  document.getElementById("btn-job-album-share-save")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-job-album-share-save");
    if (btn.disabled) {
      setDetailStatus("先に「画像チェック」を完了してください。", "warn");
      return;
    }
    try {
      btn.disabled = true;
      const result = await shareCachedJobAlbum(job);
      if (result.mode === "share") {
        albumSaveFallbackVisible.delete(job.jobId);
        const sizeText =
          result.count === 1
            ? `${Math.round(result.sizes[0] / 1024)}KB`
            : `${result.count}枚`;
        setDetailStatus(
          `出力画面を開きました（${sizeText}）。LINE本文にお礼文、添付に画像が入る構成です。送信後、専用ボタンで送信済みにしてください。`,
          "ok"
        );
      } else {
        setDetailStatus(
          `保存用に出力しました。端末に表示された保存先、またはスクリーンショットからLINEへ添付してください: ${result.names.join(" / ")}`,
          "ok"
        );
      }
    } catch (e) {
      if (e?.name === "AbortError") {
        updateAlbumPanelUi(job);
        setDetailStatus("出力をキャンセルしました。もう一度同じボタンからやり直せます。", "warn");
        return;
      }
      updateAlbumPanelUi(job);
      setDetailStatus(`一括画像の出力に失敗しました: ${e.message}`, "warn");
    } finally {
      updateAlbumPanelUi(job);
    }
  });
}

function canShareFiles(files) {
  if (!window.isSecureContext || !navigator.share || !navigator.canShare || !files?.length) return false;
  try {
    return navigator.canShare({ files });
  } catch (_) {
    return false;
  }
}

async function shareJobAlbum(job) {
  return shareCachedJobAlbum(job);
}

function canCopyPhotoToClipboard() {
  return Boolean(navigator.clipboard?.write && window.ClipboardItem && window.isSecureContext);
}

function canSharePhotoFiles() {
  try {
    const probe = new File(["x"], "probe.jpg", { type: "image/jpeg" });
    return canShareFiles([probe]);
  } catch (_) {
    return false;
  }
}

function buildImageFile(blob, filename) {
  return new File([blob], filename, { type: blob.type || "image/jpeg" });
}

async function saveBlobForUser(blob, filename, options = {}) {
  const {
    preferShare = false,
    shareTitle = "",
    disableShare = false,
    fallbackToDownloadOnShareError = false,
  } = options;
  const file = buildImageFile(blob, filename);

  if (preferShare && !disableShare && canShareFiles([file])) {
    try {
      await navigator.share({
        files: [file],
        title: shareTitle || filename,
        text: filename,
      });
      return "shared";
    } catch (error) {
      if (!fallbackToDownloadOnShareError) throw error;
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  if (isAppleMobileDevice()) {
    a.target = "_blank";
  }
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
  return "download";
}

async function downloadPhotoForLine(job, pointIndex, kind) {
  syncPointsFromForm(job);
  const point = job.dirtPoints[pointIndex];
  const ref = normalizePhotoRefs(point?.photos)[kind];
  if (!ref?.photoId) throw new Error("写真がありません");
  const blob = await getPhotoBlob(ref.photoId);
  if (!blob) throw new Error("写真データがありません");
  const filename = photoExportFilename(job, point, kind);
  await saveBlobForUser(blob, filename, {
    preferShare: isAppleMobileDevice(),
    disableShare: isAppleMobileDevice(),
    fallbackToDownloadOnShareError: true,
  });
  return filename;
}

async function sharePhotoForLine(job, pointIndex, kind) {
  syncPointsFromForm(job);
  const point = job.dirtPoints[pointIndex];
  const ref = normalizePhotoRefs(point?.photos)[kind];
  if (!ref?.photoId) throw new Error("写真がありません");
  const blob = await getPhotoBlob(ref.photoId);
  if (!blob) throw new Error("写真データがありません");
  const filename = photoExportFilename(job, point, kind);
  const file = new File([blob], filename, { type: blob.type || "image/jpeg" });
  if (canShareFiles([file])) {
    await navigator.share({
      files: [file],
      title: `${customerDisplayName(job.customerName)} ${photoSlotLabel(kind)}`,
      text: `${customerDisplayName(job.customerName)} ${photoSlotLabel(kind)}`,
    });
    return "share";
  }
  await saveBlobForUser(blob, filename, {
    preferShare: isAppleMobileDevice(),
    disableShare: isAppleMobileDevice(),
    fallbackToDownloadOnShareError: true,
  });
  return "download_fallback";
}

async function copyPhotoForLine(job, pointIndex, kind) {
  syncPointsFromForm(job);
  const point = job.dirtPoints[pointIndex];
  const ref = normalizePhotoRefs(point?.photos)[kind];
  if (!ref?.photoId) throw new Error("写真がありません");
  const blob = await getPhotoBlob(ref.photoId);
  if (!blob) throw new Error("写真データがありません");
  if (!canCopyPhotoToClipboard()) {
    throw new Error("このブラウザでは画像コピーに非対応です。保存してから LINE に添付してください。");
  }
  const type = blob.type || "image/jpeg";
  await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
}

async function copyLineTestTemplate() {
  if (!navigator.clipboard?.writeText) {
    throw new Error("このブラウザでは文面コピーに非対応です");
  }
  await navigator.clipboard.writeText(LINE_TEST_TEMPLATE);
}

async function copyTextWithFallback(text, sourceEl) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return "clipboard";
  }
  const textarea =
    sourceEl instanceof HTMLTextAreaElement || sourceEl instanceof HTMLInputElement
      ? sourceEl
      : document.createElement("textarea");
  const appended = textarea !== sourceEl;
  if (appended) {
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    document.body.appendChild(textarea);
  }
  textarea.focus();
  textarea.select();
  const ok = document.execCommand?.("copy");
  if (appended) textarea.remove();
  if (!ok) {
    throw new Error("自動コピーに対応していません。お礼文を長押しで選択してコピーしてください。");
  }
  return "fallback";
}

async function copyLineAlbumMessage(job) {
  applyDetailFormToJob(job);
  const validation = validateLineAlbumMessage(getLineAlbumMessageText(job));
  if (!validation.ok) throw new Error(validation.message);
  const messageEl = document.getElementById("f-line-album-message");
  const mode = await copyTextWithFallback(validation.text, messageEl);
  if (job.lineAlbum) job.lineAlbum.messageText = validation.text;
  saveLocal();
  return mode;
}

function armDeleteButton(btn) {
  if (btn.dataset.armed === "1") return true;
  btn.dataset.armed = "1";
  btn.dataset.originalText = btn.textContent || "削除";
  btn.textContent = "もう一度押す";
  btn.classList.add("is-armed");
  setTimeout(() => {
    if (!btn.isConnected || btn.dataset.armed !== "1") return;
    btn.dataset.armed = "0";
    btn.textContent = btn.dataset.originalText || "削除";
    btn.classList.remove("is-armed");
  }, DELETE_CONFIRM_MS);
  return false;
}

async function createJobReport(job, mode) {
  try {
    syncPointsFromForm(job);
    saveLocal();
    if (mode === "open") {
      await renderReportPreview(job);
      return;
    }
    const html = await buildJobReportHtml(job);
    const filename = `${safeFilePart(job.customerName)}_作業写真確認_DEV_お客様送付禁止.html`;
    const blob = new Blob([html], { type: "text/html;charset=UTF-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setReportSaveStatus(
      `HTML保存処理を開始しました。保存先はブラウザのダウンロード欄を確認してください。ファイル名: ${filename}`
    );
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
  } catch (e) {
    if (e?.name === "AbortError") return;
    alert("確認HTMLの作成に失敗しました: " + e.message);
  }
}

function setReportSaveStatus(message, type = "info") {
  const el = document.getElementById("report-save-status");
  if (!el) return;
  el.textContent = message;
  el.className = `save-status save-status-${type}`;
}

async function shareReportFile(job) {
  try {
    syncPointsFromForm(job);
    saveLocal();
    const html = await buildJobReportHtml(job);
    const filename = `${safeFilePart(job.customerName)}_作業写真確認_DEV_お客様送付禁止.html`;
    const file = new File([html], filename, { type: "text/html" });
    const canShareFile = window.isSecureContext && navigator.canShare?.({ files: [file] }) && navigator.share;
    if (!canShareFile) {
      setReportSaveStatus(
        "この接続ではスマホのファイル保存/共有に対応していません。試用では、この確認画面が表示できれば合格です。HTML保存はPCまたはHTTPS環境で確認してください。",
        "warn"
      );
      return;
    }
    await navigator.share({
      files: [file],
      title: `${job.customerName} 作業写真確認`,
      text: "作業写真確認HTML",
    });
    setReportSaveStatus("共有/保存画面を開きました。ファイルに保存を選べた場合は保存完了です。", "ok");
  } catch (e) {
    if (e?.name === "AbortError") {
      setReportSaveStatus("共有/保存をキャンセルしました。写真確認画面はこのまま使えます。", "warn");
      return;
    }
    setReportSaveStatus(`共有/保存に失敗しました: ${e.message}`, "warn");
  }
}

async function renderReportPreview(job) {
  const content = await buildJobReportContentHtml(job);
  main.innerHTML = `
    <div class="back-bar">
      <button type="button" class="btn" id="btn-back-detail">← 案件画面に戻る</button>
    </div>
    <article class="report-preview">
      ${content}
    </article>
    <section class="card save-panel">
      <h2>保存/共有</h2>
      <p class="hint">スマホ試用では、この画面に写真が表示できれば合格です。HTMLファイル保存は端末・ブラウザ・接続方式に左右されます。</p>
      <p id="report-save-status" class="save-status save-status-info">未実行</p>
    </section>
    <div class="btn-row">
      <button type="button" class="btn" id="btn-report-back-bottom">案件画面に戻る</button>
      <button type="button" class="btn" id="btn-report-share">共有/ファイルに保存</button>
      <button type="button" class="btn" id="btn-report-download">HTML保存（PC用）</button>
    </div>
  `;
  document.getElementById("btn-back-detail").addEventListener("click", renderDetail);
  document.getElementById("btn-report-back-bottom").addEventListener("click", renderDetail);
  document.getElementById("btn-report-share").addEventListener("click", () => {
    shareReportFile(job);
  });
  document.getElementById("btn-report-download").addEventListener("click", () => {
    createJobReport(job, "download");
  });
  main.focus();
}

function renderDetail() {
  const seq = ++photoRenderSeq;
  revokePhotoUrls();
  const j = findJob(detailJobId);
  if (!j) {
    detailJobId = null;
    render();
    return;
  }
  const formState = hydrateDetailFormState(j) || getActiveDetailDraft(j.jobId);
  hydrateDraftToJob(j);
  const latestFormState = formState || getActiveDetailDraft(j.jobId);
  if (latestFormState && latestFormState.jobId === j.jobId) {
    applyDetailFormStateToJob(j, latestFormState);
  }
  const defaultWorkDate = normalizeDateInputValue(j.workDate, todayYmd());
  const defaultSendDate = normalizeDateInputValue(j.sendPlannedDate, defaultWorkDate);
  j.workDate = defaultWorkDate;
  j.sendPlannedDate = defaultSendDate < defaultWorkDate ? defaultWorkDate : defaultSendDate;
  const rate = completionRate(j);
  if (!Array.isArray(j.dirtPoints)) j.dirtPoints = [];
  const pointsHtml = j.dirtPoints
    .map(
      (p, i) => `
          <li class="point-row" data-point-row="${i}">
      <div class="point-section-heading" aria-label="洗う場所 ${i + 1} の入力欄">
        <span class="point-section-kicker">洗う場所 ${i + 1}</span>
        <span class="point-section-guide">この枠内が1つの作業入力です</span>
      </div>
      <div class="point-main">
        <label class="point-check">
          <input type="checkbox" data-point-idx="${i}" ${p.manualCompletedChecked ? "checked" : ""} aria-label="${escapeHtml(p.name)} 作業完了">
          <span>作業完了</span>
        </label>
        <small class="point-check-desc">作業中の進捗チェックです。送信条件には影響しません。</small>
        <input type="text" class="point-name" data-point-name-idx="${i}" value="${escapeHtml(p.name)}" aria-label="洗う場所名 ${i + 1}">
        <button type="button" class="btn point-remove" data-point-remove-idx="${i}">削除</button>
      </div>
      ${renderPhotoSlots(p, i)}
    </li>`
    )
    .join("");

  syncAlbumCheckEntry(j);
  const albumSummary = renderAlbumSummaryHtml(j);
  const messageText = normalizeLineMessageText(j.lineAlbum?.messageText || LINE_TEST_TEMPLATE);
  const customerInputValue = normalizeCustomerNameInput(j.customerName || "");
  main.innerHTML = `
    <div class="back-bar">
      <button type="button" class="btn" id="btn-back">← 戻る</button>
    </div>
    <div class="detail-header card">
      <h2>${renderCustomerName(j.customerName)}</h2>
      ${renderCustomerNameHint(j.customerName)}
      <p class="card-meta">作業内容: ${escapeHtml(serviceLabel(j.serviceCode))}</p>
      ${renderJobStatusBadges(j)}
      <p class="rate">作業進捗（作業完了） ${rate.done}/${rate.total}（${rate.pct}%）</p>
      <p class="point-check-guide">作業進捗（作業完了）と写真状態は別管理です。写真状態は「写真未確認／確認済み」「LINE写真の状態」で判定します。</p>
    </div>
    <div class="card">
      <div class="field">
        <label>お客様名</label>
      <input type="text" id="f-customerName" value="${escapeHtml(customerInputValue)}" placeholder="${escapeHtml(CUSTOMER_NAME_INPUT_PLACEHOLDER)}">
      </div>
      <div class="field">
        <label>作業内容</label>
        <select id="f-serviceCode" class="service-select">${serviceOptionsHtml(j.serviceCode || DEFAULT_SERVICE_CODE)}</select>
        <p class="hint">作業内容はカテゴリごとにまとめてあります。</p>
      </div>
      <div class="field">
        <label>作業日</label>
        <input type="date" id="f-workDate" value="${escapeHtml(j.workDate)}">
      </div>
      <div class="field">
        <label>送信予定日</label>
        <input type="date" id="f-sendPlannedDate" value="${escapeHtml(j.sendPlannedDate)}" min="${escapeHtml(j.workDate)}">
      </div>
      <input type="hidden" id="f-photoStorage" value="${escapeHtml(j.photoStorage || BETA_LOCAL_STORAGE_LABEL)}">
      <p class="hint beta-local-note">写真はこの端末のブラウザ内に保存します。外部連携の設定は不要です。</p>
      <div class="field">
        <label>送る写真の確認</label>
        <p class="hint" id="photo-verify-hint">—</p>
        <button type="button" class="btn" id="btn-mark-photo-verified" ${j.photoVerified === "済" ? "disabled" : ""}>送る写真の確認が終わった</button>
        <p class="hint">現在: ${escapeHtml(T.photoVerified[j.photoVerified] || j.photoVerified)}。セレクトでは変更しません。</p>
      </div>
    </div>
    <div class="card">
      <h2>洗う場所</h2>
      <ul class="points-list">${pointsHtml || `<li class="point-empty">洗う場所なし</li>`}</ul>
      <button type="button" class="btn" id="btn-add-point">洗う場所を追加</button>
      <p class="hint">写真はこの端末のブラウザ内だけに保存します。JSONには写真本体を含めません。</p>
      ${photoExportContextHint() ? `<p class="photo-export-hint">${escapeHtml(photoExportContextHint())}</p>` : ""}
    </div>
    <div class="card">
      <h2>LINE手動送付</h2>
      <p class="hint">ここではお礼文と一括画像の出力まで行います。送信後は「今日 LINE で送る」で作業完了として消します。</p>
      <div class="line-album-panel">
        <h3>このお客様分を1枚にまとめる</h3>
        <div class="field">
          <label for="f-line-album-message">LINEに貼るお礼文</label>
          <textarea id="f-line-album-message" class="line-album-message" rows="4" maxlength="${LINE_MESSAGE_MAX_CHARS}">${escapeHtml(messageText)}</textarea>
          <p class="hint">一括画像を出力すると、LINE本文として画像より前に入ります。画像の中には入れません（最大 ${LINE_MESSAGE_MAX_CHARS} 文字）。</p>
        </div>
        <div class="btn-row">
          <button type="button" class="btn btn-small" id="btn-copy-line-message">お礼文をコピー</button>
        </div>
        <div id="job-album-preview">${albumSummary}</div>
        <p id="album-check-status" class="save-status save-status-info">画像チェック: 未チェック</p>
        <div id="job-album-image-preview"></div>
        <div class="btn-row">
          <button type="button" class="btn btn-small btn-primary" id="btn-job-album-check">画像チェック</button>
        <button type="button" class="btn btn-small" id="btn-job-album-share-save" disabled>一括画像を出力</button>
      </div>
        <p class="hint android-fallback">iPhoneでは同じボタンから共有シートを開きます。LINEが出ない場合は、表示された保存先に従うか、プレビューをスクリーンショットしてLINEへ添付してください。</p>
      </div>
      <ol class="action-steps">
        <li>お礼文を入力する</li>
        <li>画像チェックで、お礼文なしの画像プレビューを確認する</li>
        <li>一括画像を出力して、LINE本文のお礼文と画像を手動送信する</li>
      </ol>
      ${isDevMode() ? `<div class="btn-row"><button type="button" class="btn" id="btn-copy-line-template">お礼文テンプレをコピー（開発者）</button></div>` : ""}
      <p class="hint">LINE送信後は、「今日 LINE で送る」で対象のお客様を作業完了として消してください。</p>
      <p id="detail-status" class="save-status save-status-info">画像チェック / 共有の結果がここに表示されます</p>
    </div>
    ${
      isDevMode()
        ? `<div class="card card-dev">
      <h2>確認HTML（開発者モード）</h2>
      <p class="hint">試用外機能。?dev=1 の表示切替のみ（パスワード保護ではありません）。</p>
      <div class="btn-row">
        <button type="button" class="btn" id="btn-open-report">確認画面を表示</button>
        <button type="button" class="btn" id="btn-download-report">HTMLを保存</button>
      </div>
    </div>`
        : ""
    }
  `;
  const activeFormState = latestFormState && latestFormState.jobId === j.jobId ? latestFormState : null;
  if (activeFormState) {
    applyDetailFormStateToDom(j, activeFormState);
  }

  document.getElementById("btn-back").addEventListener("click", () => {
    commitActiveDetailFormBeforeLeaving();
    detailJobId = null;
    if (window.location.hash.startsWith("#job=")) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    render();
  });

  const topCustomerNameInput = document.getElementById("f-customerName");
  wireCustomerNameInput(topCustomerNameInput, j);
  syncSendPlannedDateToWorkDate(j, { force: false });

  const topServiceSelect = document.getElementById("f-serviceCode");
  topServiceSelect?.addEventListener("change", () => {
    syncTopFormToJob(j);
    rememberCurrentDetailFormState(j);
    setDetailDraftFromJob(j);
    queueDetailAutoSave(j, 0);
    renderDetail();
  });

  const topWorkDateInput = document.getElementById("f-workDate");
  const handleWorkDateChange = () => {
    syncSendPlannedDateToWorkDate(j, { force: true });
    persistDetailFormState(j);
    queueDetailAutoSave(j, 0);
  };
  topWorkDateInput?.addEventListener("input", handleWorkDateChange);
  topWorkDateInput?.addEventListener("change", handleWorkDateChange);

  const topSendPlannedDateInput = document.getElementById("f-sendPlannedDate");
  const handleSendPlannedDateChange = () => {
    syncSendPlannedDateToWorkDate(j, { force: false });
    persistDetailFormState(j);
    queueDetailAutoSave(j, 0);
  };
  topSendPlannedDateInput?.addEventListener("input", handleSendPlannedDateChange);
  topSendPlannedDateInput?.addEventListener("change", handleSendPlannedDateChange);

  const topMessageInput = document.getElementById("f-line-album-message");
  topMessageInput?.addEventListener("input", () => {
    persistDetailFormState(j);
    updateAlbumPanelUi(j);
  });

  main.querySelectorAll("[data-point-idx]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const idx = Number(cb.dataset.pointIdx);
      if (j.dirtPoints[idx]) {
        j.dirtPoints[idx].manualCompletedChecked = cb.checked;
      }
      persistDetailFormState(j);
    });
  });

  main.querySelectorAll("[data-point-name-idx]").forEach((input) => {
    input.addEventListener("input", () => {
      persistDetailFormState(j);
      updateAlbumPanelUi(j);
    });
  });

  main.querySelectorAll("[data-point-remove-idx]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!armDeleteButton(btn)) return;
      persistDetailFormState(j);
      await handlePointDelete(j, Number(btn.dataset.pointRemoveIdx));
    });
  });

  document.getElementById("btn-open-report")?.addEventListener("click", () => {
    createJobReport(j, "open");
  });

  document.getElementById("btn-download-report")?.addEventListener("click", () => {
    createJobReport(j, "download");
  });

  const wirePhotoFileInput = (input) => {
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      const key = input.dataset.photoCapture || input.dataset.photoPick;
      const [pointIndexText, kind] = key.split(":");
      await handlePhotoInput(j, Number(pointIndexText), kind, file);
    });
  };
  main.querySelectorAll("[data-photo-capture], [data-photo-pick]").forEach(wirePhotoFileInput);

  main.querySelectorAll("[data-photo-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!armDeleteButton(btn)) return;
      const [pointIndexText, kind] = btn.dataset.photoDelete.split(":");
      persistDetailFormState(j);
      await handlePhotoDelete(j, Number(pointIndexText), kind);
    });
  });

  wirePhotoExportHandlers(j);

  document.getElementById("btn-copy-line-template")?.addEventListener("click", async () => {
    try {
      await copyLineTestTemplate();
      setDetailStatus("作業後テンプレ文をコピーしました（開発者向け）。", "ok");
    } catch (e) {
      setDetailStatus(`文面コピーに失敗しました: ${e.message}`, "warn");
    }
  });

  document.getElementById("btn-copy-line-message")?.addEventListener("click", async () => {
    try {
      const mode = await copyLineAlbumMessage(j);
      setDetailStatus(
        mode === "clipboard"
          ? "お礼文をコピーしました。LINEの本文欄に貼り付けてください。"
          : "お礼文をコピーしました。貼り付けできない場合は、文面欄を長押しで選択してコピーしてください。",
        "ok"
      );
    } catch (e) {
      setDetailStatus(`お礼文のコピーに失敗しました: ${e.message}`, "warn");
    }
  });

  document.getElementById("btn-mark-photo-verified")?.addEventListener("click", () => {
    handleMarkPhotoVerified(j);
  });

  updatePhotoVerifyHint(j);
  updateAlbumPanelUi(j);
  hydratePhotoThumbs(j, seq);
}

function renderData() {
  const photoCount = countPhotoRefs();
  main.innerHTML = `
    <div class="card card-dev">
      <h2>開発者モード</h2>
      <p class="hint">?dev=1 は<strong>非セキュリティ</strong>の表示切替です。URL を知っている人は誰でもこのタブを開けます。パスワード保護ではありません。</p>
    </div>
    <div class="card">
      <h2>JSON データ</h2>
      <p class="hint">JSONには写真本体を含みません。写真本体はこの端末のブラウザ内だけに保存します。</p>
      <div class="btn-row">
        <button type="button" class="btn btn-primary" id="btn-export">JSON をダウンロード</button>
        <label class="btn">
          JSON を読み込む
          <input type="file" id="file-import" accept=".json,application/json" hidden>
        </label>
        <button type="button" class="btn" id="btn-reset">ダミー3件を再読込</button>
      </div>
    </div>
    <div class="card">
      <h2>端末内写真</h2>
      <p class="hint">登録メタ: ${photoCount} 枚。実顧客写真で試す前に、不要な写真は削除してください。</p>
      <button type="button" class="btn" id="btn-clear-photos">端末内写真を全削除</button>
    </div>
    <div class="card">
      <h2>保存状態診断</h2>
      <p class="hint">「画面では済にしたのに戻る」を機械的に確認します。メモリと保存実体が一致しているか見てください。</p>
      <div id="save-diagnostics">${renderSaveDiagnosticsHtml()}</div>
      <button type="button" class="btn" id="btn-refresh-diagnostics">診断を更新</button>
    </div>
    <div class="card">
      <h2>アプリ更新</h2>
      <p class="hint">版不一致バナーが出たとき、またはフッターの版が古いとき。</p>
      <button type="button" class="btn" id="btn-force-refresh">最新版に更新（キャッシュ削除）</button>
    </div>
    <div class="card">
      <h2>突合テスト</h2>
      <p id="verify-result">—</p>
      <button type="button" class="btn" id="btn-verify">今日 LINE で送る対象が sample-001 のみか確認</button>
    </div>
  `;

  document.getElementById("btn-export").addEventListener("click", exportJson);
  document.getElementById("file-import").addEventListener("change", importJson);
  document.getElementById("btn-reset").addEventListener("click", async () => {
    if (!confirm("localStorage と端末内写真をリセットして、ダミー3件を読み直しますか？")) return;
    try {
      await clearPhotoDb();
      await loadSample();
      render();
    } catch (e) {
      alert("ダミーデータの再読込に失敗しました: " + e.message);
      render();
    }
  });
  document.getElementById("btn-clear-photos").addEventListener("click", async () => {
    if (!confirm("端末内に保存した写真をすべて削除しますか？")) return;
    try {
      await clearAllPhotoRefs();
      render();
    } catch (e) {
      alert("写真削除に失敗しました: " + e.message);
    }
  });
  document.getElementById("btn-verify").addEventListener("click", runVerify);
  document.getElementById("btn-refresh-diagnostics").addEventListener("click", () => {
    const el = document.getElementById("save-diagnostics");
    if (el) el.innerHTML = renderSaveDiagnosticsHtml();
  });
  document.getElementById("btn-force-refresh").addEventListener("click", () => {
    if (!confirm("キャッシュを削除して最新版を読み直します。未保存の画面入力は失われませんが、念のため保存済みか確認してください。")) {
      return;
    }
    forceAppRefresh();
  });
  runVerify();
}

async function forceAppRefresh() {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((reg) => reg.unregister()));
    }
    if ("caches" in globalThis) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch (e) {
    console.warn("キャッシュ削除失敗", e);
  }
  globalThis.location.reload();
}

function exportJson() {
  ensureState();
  state.exportedAt = new Date().toISOString();
  const blob = new Blob([JSON.stringify(state, null, 2)], {
    type: "application/json",
  });
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `photo_jobs_${stamp}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
  saveLocal();
}

function importJson(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (
        !confirm(
          "Phase 0 の試用JSONとして読み込みます。\n実在のお客様データや写真バイナリを含めていないことを確認してください。"
        )
      ) {
        return;
      }
      setState(data);
      clearAllDetailDrafts();
      const saved = saveLocal();
      alert(saved ? `読み込みました（${state.jobs.length} 件）` : `読み込みました（${state.jobs.length} 件）。ただしブラウザ保存に失敗しました。`);
      render();
    } catch (e) {
      alert("JSON の読み込みに失敗しました: " + e.message);
    } finally {
      ev.target.value = "";
    }
  };
  reader.onerror = () => {
    alert("JSON ファイルを読み取れませんでした");
    ev.target.value = "";
  };
  reader.readAsText(file, "UTF-8");
}

function runVerify() {
  const today = todayYmd();
  const list = safeTodaySend(today);
  const ids = list.map((j) => j.jobId);
  const ok =
    ids.length === 1 && ids[0] === TRIAL_JOB_ID;
  const el = document.getElementById("verify-result");
  if (el) {
    el.innerHTML = ok
      ? `<span style="color:var(--ok)">OK</span> — 今日 LINE で送るは <strong>${TRIAL_JOB_ID}（サンプル顧客）</strong> のみ（${today} / ${BUSINESS_TIME_ZONE}）`
      : `<span style="color:var(--warn)">NG</span> — ヒット: ${escapeHtml(ids.length ? ids.join(", ") : "0件")}`;
  }
}

function render() {
  syncNavTabs();
  updateFooter();
  if (detailJobId) {
    renderDetail();
    return;
  }
  if (window.location.hash.startsWith("#job=") && openJobFromHash()) return;
  photoRenderSeq += 1;
  revokePhotoUrls();
  if (currentView === "today") renderToday();
  else if (currentView === "jobs") renderJobs();
  else renderData();
}

document.querySelectorAll(".nav-tab").forEach((btn) => {
  btn.addEventListener("pointerdown", () => {
    blurActiveDetailInput();
  });
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    setView(btn.dataset.view);
  });
});

["pointerup", "click"].forEach((eventName) => {
  document.addEventListener(eventName, (event) => {
    const target = event.target?.closest?.("#btn-save-new-manual-job");
    if (!target) return;
    event.preventDefault();
    saveNewManualJobFromForm();
  });
});

function handlePointAddCommand(event) {
  const target = event.target?.closest?.("#btn-add-point");
  if (!target) return;
  if (event.type === "pointerdown") {
    event.preventDefault();
  }
  const now = Date.now();
  if (now - lastPointAddRunAt < 500) return;
  const currentJob = findJob(detailJobId);
  if (!currentJob) return;
  lastPointAddRunAt = now;
  handlePointAdd(currentJob);
}

main.addEventListener("pointerdown", handlePointAddCommand, true);
main.addEventListener("click", handlePointAddCommand, true);

function persistActiveJobDraft() {
  const currentJob = findJob(detailJobId);
  if (currentJob) {
    syncDetailForm(currentJob);
    setDetailDraftFromJob(currentJob);
    saveLocal();
  }
}

window.addEventListener("pagehide", persistActiveJobDraft);
window.addEventListener("beforeunload", persistActiveJobDraft);

window.addEventListener("hashchange", () => {
  if (detailJobId) {
    commitActiveDetailFormBeforeLeaving();
  }
  if (!openJobFromHash()) render();
});

initData()
  .then(async () => {
    const subtitle = document.querySelector(".subtitle");
    if (subtitle) subtitle.textContent = `写真を確認して、人が送る`;
    syncNavTabs();
    await checkDeployedVersion();
    if (!openJobFromHash()) render();
  })
  .catch((err) => {
    setEmptyState();
    render();
    main.insertAdjacentHTML(
      "afterbegin",
      `<p class="empty">初期データの読込に失敗しました。<br>${escapeHtml(err.message)}<br><br>ターミナルで r1a-app フォルダから <code>python3 -m http.server 8765</code> を実行してください。8765が使用中なら <code>python3 -m http.server 8766</code> を使います。</p>`
    );
  });
