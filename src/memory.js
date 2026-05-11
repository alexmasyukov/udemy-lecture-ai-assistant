import { MEMORY_BASE_FALLBACK } from './defaults.js';

// Thin client for the Learn Memory API.
// All methods are best-effort: any network/HTTP error is logged and
// returned as null (or [] for list endpoints) so the plugin keeps
// working without the backend. The caller can detect "offline" by
// checking the return value or by listening to onStatusChange.

let listeners = new Set();
let currentStatus = null; // null = unknown, true = online, false = offline

export function onMemoryStatus(fn) {
  listeners.add(fn);
  if (currentStatus !== null) fn(currentStatus);
  return () => listeners.delete(fn);
}

function setStatus(online) {
  if (currentStatus === online) return;
  currentStatus = online;
  for (const fn of listeners) fn(online);
}

function normalizeBase(url) {
  return (url || '').trim().replace(/\/$/, '') || MEMORY_BASE_FALLBACK;
}

async function request(settings, path, init = {}) {
  if (!settings.memoryEnabled) return { ok: false, status: 0, data: null, disabled: true };
  const base = normalizeBase(settings.memoryBaseUrl);
  const url = `${base}${path}`;
  try {
    const r = await fetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    if (!r.ok) {
      // 404 from getLectionByKey is an expected "not found", not a transport failure.
      setStatus(true);
      let data = null;
      try { data = await r.json(); } catch { /* empty body */ }
      return { ok: false, status: r.status, data };
    }
    setStatus(true);
    if (r.status === 204) return { ok: true, status: 204, data: null };
    const data = await r.json();
    return { ok: true, status: r.status, data };
  } catch (e) {
    setStatus(false);
    console.warn('[memory] request failed', url, e.message);
    return { ok: false, status: 0, data: null, error: e };
  }
}

export async function health(settings) {
  const r = await request(settings, '/healthz');
  return r.ok && r.data?.status === 'ok';
}

export async function getLectionByKey(settings, { course_id, lecture_id }) {
  const r = await request(
    settings,
    `/lections/by/${encodeURIComponent(course_id)}/${encodeURIComponent(lecture_id)}`,
  );
  if (r.ok) return r.data;
  return null;
}

export async function upsertLection(settings, payload) {
  const r = await request(settings, '/lections/upsert', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  return r.ok ? r.data : null;
}

export async function listHistory(settings, { course_id, lecture_id, limit = 1000 }) {
  const qs = new URLSearchParams({
    course_id: String(course_id),
    lecture_id: String(lecture_id),
    limit: String(limit),
  });
  const r = await request(settings, `/history?${qs.toString()}`);
  return r.ok && Array.isArray(r.data) ? r.data : [];
}

export async function addMessage(settings, { course_id, lecture_id, kind, content, model }) {
  const body = { course_id: String(course_id), lecture_id: String(lecture_id), kind, content };
  if (model) body.model = model;
  const r = await request(settings, '/history', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return r.ok ? r.data : null;
}
