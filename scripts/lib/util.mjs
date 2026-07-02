import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
export const money = (v) => `$${Math.abs(num(v)).toFixed(2)}`;
export const sha1 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

export function loadJSON(path, fallback = undefined) {
  if (!existsSync(path)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required data file: ${path} — run the pull step (see RUNBOOK.md)`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

export const daysBetween = (a, b) => Math.floor((b - a) / 86400000);

export function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function groupBy(arr, key) {
  const m = new Map();
  for (const r of arr) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
}
