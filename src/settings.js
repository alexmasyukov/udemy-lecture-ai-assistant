import { DEFAULTS } from './defaults.js';

export async function loadSettings() {
  const stored = await chrome.storage.local.get(['settings', 'strictMode']);
  const merged = { ...DEFAULTS, ...(stored.settings || {}) };
  // One-time migration: legacy top-level `strictMode` key
  if (stored.strictMode !== undefined && (stored.settings?.strictMode === undefined)) {
    merged.strictMode = Boolean(stored.strictMode);
    await chrome.storage.local.set({ settings: merged });
    await chrome.storage.local.remove('strictMode');
  }
  return merged;
}

export async function patchSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
