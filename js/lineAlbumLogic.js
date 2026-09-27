/** 作業写真アプリ — 一括 LINE アルバムの純粋ロジック（selftest 対象） */

export const LINE_CANVAS_MAX_WIDTH = 1200;
export const LINE_CANVAS_MAX_HEIGHT = 6000;
export const LINE_CANVAS_MAX_PIXELS = 7_200_000;
export const LINE_ALBUM_MAX_POINTS = 4;
export const LINE_HEADER_H = 110;
export const LINE_FOOTER_H = 80;
export const LINE_POINT_NAME_H = 36;
export const LINE_LABEL_BAND_H = 44;
export const LINE_POINT_IMAGE_H = 320;
export const LINE_POINT_GAP = 16;
export const LINE_POINT_COL_GAP = 12;
export const EXCLUDED_LINE_H = 22;
export const EXCLUDED_HEADER_H = 24;
export const LINE_MESSAGE_MAX_CHARS = 300;
export const LINE_MESSAGE_LINE_H = 28;
export const LINE_MESSAGE_LABEL_H = 32;
export const LINE_MESSAGE_PADDING = 16;
export const LINE_MESSAGE_CHARS_PER_LINE = 28;
export const LINE_ALBUM_LAYOUT = "job_before_after_grid_v1";

export function safeFilePart(value) {
  return String(value || "report").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80);
}

export function lineAlbumFilename(customerName, part, total) {
  const suffix = total > 1 ? `_${part}of${total}` : "";
  return `${safeFilePart(customerName)}_LINE送信用${suffix}.jpg`;
}

/** 作業写真アプリ: 洗う場所ごとに Before/After は横並び1段 */
export function estimatePointBlockHeight() {
  return LINE_POINT_NAME_H + LINE_LABEL_BAND_H + LINE_POINT_IMAGE_H + LINE_POINT_GAP;
}

export function validateLineAlbumMessage(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return {
      ok: false,
      code: "empty",
      message: "お礼文を入力してください。入力した文面は一括画像の冒頭に入ります。",
    };
  }
  if (trimmed.length > LINE_MESSAGE_MAX_CHARS) {
    return {
      ok: false,
      code: "too_long",
      message: `お礼文は ${LINE_MESSAGE_MAX_CHARS} 文字以内にしてください。`,
    };
  }
  return { ok: true, text: trimmed };
}

export function wrapMessageLines(text, maxCharsPerLine = LINE_MESSAGE_CHARS_PER_LINE) {
  const src = String(text ?? "").trim();
  if (!src) return [];
  const paragraphs = src.split(/\r?\n/);
  const lines = [];
  for (const paragraph of paragraphs) {
    const p = paragraph.trim();
    if (!p) {
      lines.push("");
      continue;
    }
    let rest = p;
    while (rest.length > maxCharsPerLine) {
      lines.push(rest.slice(0, maxCharsPerLine));
      rest = rest.slice(maxCharsPerLine);
    }
    lines.push(rest);
  }
  return lines.length ? lines : [""];
}

export function estimateMessageBlockHeight(messageText, maxCharsPerLine = LINE_MESSAGE_CHARS_PER_LINE) {
  const lines = wrapMessageLines(messageText, maxCharsPerLine);
  if (!lines.length) return 0;
  return (
    LINE_MESSAGE_PADDING +
    LINE_MESSAGE_LABEL_H +
    lines.length * LINE_MESSAGE_LINE_H +
    LINE_MESSAGE_PADDING
  );
}

export function estimateAlbumCanvasHeight(
  pointCount,
  excludedLineCount,
  splitLabel = false,
  messageText = ""
) {
  const splitH = splitLabel ? 36 : 0;
  const messageH = estimateMessageBlockHeight(messageText);
  const excludedH =
    excludedLineCount > 0 ? EXCLUDED_HEADER_H + excludedLineCount * EXCLUDED_LINE_H : 0;
  return (
    LINE_HEADER_H +
    splitH +
    messageH +
    pointCount * estimatePointBlockHeight() +
    excludedH +
    LINE_FOOTER_H
  );
}

export function splitIncludedPoints(included) {
  const chunks = [];
  for (let i = 0; i < included.length; i += LINE_ALBUM_MAX_POINTS) {
    chunks.push(included.slice(i, i + LINE_ALBUM_MAX_POINTS));
  }
  return chunks.length ? chunks : [[]];
}

export function planLineAlbumPartsFromChunks(chunks, excluded = []) {
  const safeChunks = Array.isArray(chunks) && chunks.length ? chunks : [[]];
  const total = safeChunks.length;
  return safeChunks.map((chunk, index) => ({
    part: index + 1,
    total,
    included: chunk,
    excluded: index === safeChunks.length - 1 ? excluded : [],
  }));
}

export function planLineAlbumParts(included, excluded = []) {
  const chunks = splitIncludedPoints(included);
  return planLineAlbumPartsFromChunks(chunks, excluded);
}

export function normalizePhotoRefsForAlbum(value) {
  const src = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const pick = (kind) => {
    const p = src[kind];
    return p && p.photoId ? p : null;
  };
  return { before: pick("before"), after: pick("after"), process: pick("process") };
}

export function analyzeJobAlbumPointsFromPoints(dirtPoints) {
  const included = [];
  const excluded = [];
  for (const point of dirtPoints || []) {
    const photos = normalizePhotoRefsForAlbum(point.photos);
    if (photos.before && photos.after) {
      included.push({ point, photos });
      continue;
    }
    let reason = "写真なし";
    if (photos.before && !photos.after) reason = "After未登録";
    else if (!photos.before && photos.after) reason = "Before未登録";
    else if (photos.process) reason = "作業中の写真のみ";
    excluded.push({ point, reason });
  }
  return { included, excluded };
}

export function planExcludedDisplay(
  excluded,
  pointCount,
  splitLabel = false,
  messageText = ""
) {
  if (!excluded.length) {
    return { shown: [], omitted: 0, lineCount: 0 };
  }
  const splitH = splitLabel ? 36 : 0;
  const messageH = estimateMessageBlockHeight(messageText);
  const baseH =
    LINE_HEADER_H + splitH + messageH + pointCount * estimatePointBlockHeight() + LINE_FOOTER_H;
  const available = LINE_CANVAS_MAX_HEIGHT - baseH - EXCLUDED_HEADER_H;
  if (available < EXCLUDED_LINE_H) {
    return { shown: [], omitted: excluded.length, lineCount: 1 };
  }
  const maxLines = Math.floor(available / EXCLUDED_LINE_H);
  if (excluded.length <= maxLines) {
    return { shown: excluded, omitted: 0, lineCount: excluded.length };
  }
  if (maxLines <= 1) {
    return { shown: [], omitted: excluded.length, lineCount: 1 };
  }
  const showCount = maxLines - 1;
  return {
    shown: excluded.slice(0, showCount),
    omitted: excluded.length - showCount,
    lineCount: maxLines,
  };
}

export function resolveAlbumCanvasHeight(
  pointCount,
  excludedPlan,
  splitLabel = false,
  messageText = ""
) {
  const splitH = splitLabel ? 36 : 0;
  const messageH = estimateMessageBlockHeight(messageText);
  const excludedLines =
    excludedPlan.omitted > 0
      ? excludedPlan.shown.length + 1
      : excludedPlan.shown.length;
  const excludedH =
    excludedLines > 0 ? EXCLUDED_HEADER_H + excludedLines * EXCLUDED_LINE_H : 0;
  const height =
    LINE_HEADER_H +
    splitH +
    messageH +
    pointCount * estimatePointBlockHeight() +
    excludedH +
    LINE_FOOTER_H;
  if (height > LINE_CANVAS_MAX_HEIGHT) {
    throw new Error(`canvas高さ ${height}px が上限 ${LINE_CANVAS_MAX_HEIGHT}px を超えます`);
  }
  if (height * LINE_CANVAS_MAX_WIDTH > LINE_CANVAS_MAX_PIXELS) {
    throw new Error("canvas総ピクセル数が上限を超えます");
  }
  return height;
}

export function buildLineImageHeaderTexts(job, serviceLabelText = "") {
  return {
    title: `${job.customerName} / ${serviceLabelText || job.serviceCode || ""}`,
    subtitle: `作業日: ${job.workDate || "-"}`,
  };
}

export function lineImageMustNotContainJobId(texts, jobId) {
  if (!jobId) return true;
  const joined = `${texts.title}\n${texts.subtitle}`;
  return !joined.includes(String(jobId));
}

export function buildAlbumContentFingerprint(dirtPoints, messageText) {
  const { included, excluded } = analyzeJobAlbumPointsFromPoints(dirtPoints);
  return JSON.stringify({
    messageText: String(messageText ?? "").trim(),
    included: included.map((entry) => ({
      pointId: entry.point.pointId,
      name: entry.point.name,
      before: entry.photos.before?.photoId,
      after: entry.photos.after?.photoId,
    })),
    excluded: excluded.map((entry) => ({
      name: entry.point.name,
      reason: entry.reason,
    })),
  });
}

export function isAlbumShareEnabled(previewStatus) {
  return previewStatus === "checked";
}

export function albumPreviewStatusLabel(status) {
  const map = {
    not_checked: "未チェック",
    checked: "確認済み",
    stale: "内容変更あり",
    failed: "生成失敗",
  };
  return map[status] || status;
}
