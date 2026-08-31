import type { Project } from '$lib/models/types';
import { env } from '$env/dynamic/public';

export interface DataStore {
  save(project: Project): Promise<void>;
  load(id: string): Promise<Project | null>;
  list(): Promise<{ id: string; name: string; updatedAt: string }[]>;
  delete(id: string): Promise<void>;
  duplicate(id: string): Promise<Project | null>;
  saveThumbnail(id: string, dataUrl: string): void;
  getThumbnail(id: string): string | null;
}

export type SyncState = 'local-only' | 'synced' | 'pending' | 'offline' | 'conflict';
export const SYNC_ENDPOINT = env.PUBLIC_SYNC_URL || '/api/sync';
const DB_NAME = 'openplan3d-local';
const DB_VERSION = 1;
const PROJECTS = 'projects';
const THUMBNAILS = 'thumbnails';
const LEGACY_KEY = 'floorplan_projects';
let syncTimer: ReturnType<typeof setInterval> | null = null;
let syncing = false;
let initialized = false;
const syncListeners = new Set<(state: SyncState) => void>();
let currentSyncState: SyncState = 'local-only';

function notify(state: SyncState) { currentSyncState = state; for (const listener of syncListeners) listener(state); }
export function getSyncState() { return currentSyncState; }
export function subscribeSync(listener: (state: SyncState) => void) { syncListeners.add(listener); listener(currentSyncState); return () => syncListeners.delete(listener); }

function asDate(value: any): Date {
  if (value?.toDate instanceof Function) return value.toDate();
  return value instanceof Date ? value : new Date(value);
}
function hydrateProject(value: any): Project {
  const p = structuredClone(value) as Project;
  p.createdAt = asDate(p.createdAt);
  p.updatedAt = asDate(p.updatedAt);
  for (const floor of (p.floors ?? [])) {
    for (const key of ['rooms', 'doors', 'windows', 'furniture', 'stairs', 'columns', 'guides', 'measurements', 'annotations', 'textAnnotations', 'groups']) {
      if (!(floor as any)[key]) (floor as any)[key] = [];
    }
  }
  return p;
}

type LocalRecord = { id: string; project?: Project; serverRevision: number | null; dirty: boolean; deleted?: boolean };
let dbPromise: Promise<IDBDatabase> | null = null;
function openDb() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB unavailable'));
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => { request.result.createObjectStore(PROJECTS, { keyPath: 'id' }); request.result.createObjectStore(THUMBNAILS); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}
async function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb(); return new Promise((resolve, reject) => { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
async function idbGetAll<T>(store: string): Promise<T[]> {
  const db = await openDb(); return new Promise((resolve, reject) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
async function idbPut(store: string, value: any, key?: IDBValidKey) {
  const db = await openDb(); return new Promise<void>((resolve, reject) => { const r = db.transaction(store, 'readwrite').objectStore(store).put(value, key); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); });
}
async function idbDelete(store: string, key: IDBValidKey) {
  const db = await openDb(); return new Promise<void>((resolve, reject) => { const r = db.transaction(store, 'readwrite').objectStore(store).delete(key); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); });
}

async function migrateLegacy() {
  if (typeof localStorage === 'undefined' || localStorage.getItem(`${LEGACY_KEY}:migrated`)) return;
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || '{}') as Record<string, string>;
    for (const raw of Object.values(legacy)) { const project = hydrateProject(JSON.parse(raw)); await idbPut(PROJECTS, { id: project.id, project, serverRevision: null, dirty: true }); }
    localStorage.setItem(`${LEGACY_KEY}:migrated`, new Date().toISOString());
  } catch (error) { console.warn('[OpenPlan3D] localStorage migration skipped', error); }
}

async function localRecords() { await migrateLegacy(); return idbGetAll<LocalRecord>(PROJECTS); }
async function queueSync() { notify('pending'); void syncNow(); }

export const localStore: DataStore = {
  async save(project) {
    const previous = await idbGet<LocalRecord>(PROJECTS, project.id);
    await idbPut(PROJECTS, { id: project.id, project: structuredClone(project), serverRevision: previous?.serverRevision ?? null, dirty: true });
    await queueSync();
  },
  async load(id) { const record = await idbGet<LocalRecord>(PROJECTS, id); return record?.project && !record.deleted ? hydrateProject(record.project) : null; },
  async list() { return (await localRecords()).filter((r) => r.project && !r.deleted).map((r) => ({ id: r.id, name: r.project!.name, updatedAt: new Date(r.project!.updatedAt).toISOString() })); },
  async delete(id) { const previous = await idbGet<LocalRecord>(PROJECTS, id); if (!previous) return; await idbPut(PROJECTS, { ...previous, project: undefined, deleted: true, dirty: true }); await queueSync(); },
  async duplicate(id) { const original = await this.load(id); if (!original) return null; const now = new Date(); const duplicate = { ...original, id: Math.random().toString(36).slice(2, 10), name: `${original.name} (Copy)`, createdAt: now, updatedAt: now }; await this.save(duplicate); return duplicate; },
  saveThumbnail(id, dataUrl) { try { localStorage.setItem(`floorplan_thumb_${id}`, dataUrl); } catch {} void idbPut(THUMBNAILS, dataUrl, id); },
  getThumbnail(id) { try { return localStorage.getItem(`floorplan_thumb_${id}`); } catch { return null; } },
};

async function api(path: string, init?: RequestInit) {
  const response = await fetch(`${SYNC_ENDPOINT}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  if (!response.ok) { const error: any = new Error(`sync HTTP ${response.status}`); error.status = response.status; error.payload = await response.json().catch(() => null); throw error; }
  return response.json();
}

async function pullRemote() {
  const remote = await api('/projects');
  const records = await localRecords(); const byId = new Map(records.map((r) => [r.id, r]));
  for (const summary of remote.projects ?? []) {
    const local = byId.get(summary.id);
    if (local?.dirty) continue;
    const result = await api(`/projects/${encodeURIComponent(summary.id)}`);
    await idbPut(PROJECTS, { id: summary.id, project: hydrateProject(result.project), serverRevision: result.revision, dirty: false });
  }
}

async function pushLocal(record: LocalRecord) {
  if (record.deleted) { await api(`/projects/${encodeURIComponent(record.id)}`, { method: 'DELETE' }); await idbDelete(PROJECTS, record.id); return; }
  if (!record.project) return;
  try {
    const result = await api(`/projects/${encodeURIComponent(record.id)}`, { method: 'PUT', body: JSON.stringify({ project: record.project, baseRevision: record.serverRevision }) });
    await idbPut(PROJECTS, { ...record, serverRevision: result.revision, dirty: false });
  } catch (error: any) {
    if (error.status !== 409 || !error.payload?.project) throw error;
    const conflict = hydrateProject(record.project); conflict.id = `${record.id}-conflict-${Math.random().toString(36).slice(2, 7)}`; conflict.name = `${conflict.name} (Conflito local)`;
    await idbPut(PROJECTS, { id: conflict.id, project: conflict, serverRevision: null, dirty: true });
    await idbPut(PROJECTS, { id: record.id, project: hydrateProject(error.payload.project), serverRevision: error.payload.revision, dirty: false });
    notify('conflict');
  }
}

export async function syncNow() {
  if (syncing || typeof navigator !== 'undefined' && !navigator.onLine) { notify('offline'); return; }
  syncing = true;
  try {
    const records = await localRecords();
    for (const record of records.filter((r) => r.dirty)) await pushLocal(record);
    await pullRemote();
    const pending = (await localRecords()).some((r) => r.dirty);
    notify(pending ? 'pending' : 'synced');
  } catch (error) { console.info('[OpenPlan3D] sync deferred', error); notify('offline'); }
  finally { syncing = false; }
}

export function startAutoSync() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true; void syncNow();
  window.addEventListener('online', () => void syncNow());
  window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void syncNow(); });
  syncTimer = setInterval(() => void syncNow(), 30_000);
}

// Compatibility API: the editor continues to use the existing DataStore contract.
export const dataStore = localStore;
export const firebaseStore = localStore;
export function setDataStore(_mode: 'local' | 'cloud') { /* local-first: cloud is the automatic sync target */ }
export function getDataStoreMode(): 'local' { return 'local'; }
