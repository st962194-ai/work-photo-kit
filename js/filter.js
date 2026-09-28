/**
 * 今日 LINE で送る — 送信予定日が今日の案件だけを出す
 */
export const BUSINESS_TIME_ZONE = "Asia/Tokyo";

export function todayYmd() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function ymdFromParts(y, m, d) {
  const dt = new Date(y, m - 1, d);
  if (
    dt.getFullYear() !== y ||
    dt.getMonth() !== m - 1 ||
    dt.getDate() !== d
  ) {
    return null;
  }
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseYmd(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return ymdFromParts(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s].*)?$/);
  if (!m) return null;
  return ymdFromParts(Number(m[1]), Number(m[2]), Number(m[3]));
}

function dateEquals(ymd, today) {
  const d = parseYmd(ymd);
  const t = parseYmd(today);
  if (!d || !t) return false;
  return d === t;
}

function effectiveSendDate(job) {
  const workDate = parseYmd(job?.workDate);
  const sendPlannedDate = parseYmd(job?.sendPlannedDate);
  if (workDate && sendPlannedDate) {
    return sendPlannedDate < workDate ? workDate : sendPlannedDate;
  }
  return sendPlannedDate || workDate || null;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function isTodaySend(job, today = todayYmd()) {
  if (!job || typeof job !== "object") return false;
  return (
    nonEmpty(job.jobId) &&
    nonEmpty(job.photoStorage) &&
    job.linePhotoSent === "未" &&
    dateEquals(effectiveSendDate(job), today)
  );
}

export function filterTodaySend(jobs, today = todayYmd()) {
  return Array.isArray(jobs) ? jobs.filter((j) => isTodaySend(j, today)) : [];
}

export function completionRate(job) {
  const pts = Array.isArray(job?.dirtPoints) ? job.dirtPoints : [];
  if (pts.length === 0) return { done: 0, total: 0, pct: 0 };
  const done = pts.filter((p) => p.manualCompletedChecked).length;
  return { done, total: pts.length, pct: Math.round((done / pts.length) * 100) };
}
