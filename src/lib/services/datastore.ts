import type { Project } from '$lib/models/types';
import { collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore';
import { getFirestoreDb, getFirebaseAuth, isFirebaseConfigured } from '$lib/firebase';

export interface DataStore {
  save(project: Project): Promise<void>;
  load(id: string): Promise<Project | null>;
  list(): Promise<{ id: string; name: string; updatedAt: string }[]>;
  delete(id: string): Promise<void>;
  duplicate(id: string): Promise<Project | null>;
  saveThumbnail(id: string, dataUrl: string): void;
  getThumbnail(id: string): string | null;
}

const KEY = 'floorplan_projects';

function asDate(value: any): Date {
  if (value?.toDate instanceof Function) return value.toDate();
  return value instanceof Date ? value : new Date(value);
}

function hydrateProject(value: any): Project {
  const p = value as Project;
  p.createdAt = asDate(p.createdAt);
  p.updatedAt = asDate(p.updatedAt);
  for (const floor of (p.floors ?? [])) {
    if (!floor.rooms) floor.rooms = [];
    if (!floor.doors) floor.doors = [];
    if (!floor.windows) floor.windows = [];
    if (!floor.furniture) floor.furniture = [];
    if (!floor.stairs) floor.stairs = [];
    if (!floor.columns) floor.columns = [];
    if (!floor.guides) floor.guides = [];
    if (!floor.measurements) floor.measurements = [];
    if (!floor.annotations) floor.annotations = [];
    if (!floor.textAnnotations) floor.textAnnotations = [];
    if (!floor.groups) floor.groups = [];
  }
  return p;
}

function getAll(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}

export const localStore: DataStore = {
  async save(project) {
    const all = getAll();
    all[project.id] = JSON.stringify(project);
    try {
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch (e: any) {
      if (e?.name === 'QuotaExceededError' || e?.code === 22 || e?.code === 1014) {
        const minimal: Record<string, string> = { [project.id]: all[project.id] };
        try {
          localStorage.setItem(KEY, JSON.stringify(minimal));
          alert('Storage quota exceeded. Other projects were removed to save this one. Export important projects as JSON.');
        } catch { alert('Storage quota exceeded. Export your project as JSON and clear browser data.'); }
      } else throw e;
    }
  },
  async load(id) {
    const raw = getAll()[id];
    return raw ? hydrateProject(JSON.parse(raw)) : null;
  },
  async list() {
    return Object.values(getAll()).map((raw) => {
      const p = JSON.parse(raw);
      return { id: p.id, name: p.name, updatedAt: p.updatedAt };
    });
  },
  async delete(id) {
    const all = getAll(); delete all[id]; localStorage.setItem(KEY, JSON.stringify(all));
    try { localStorage.removeItem(`floorplan_thumb_${id}`); } catch {}
  },
  async duplicate(id) {
    const original = await this.load(id); if (!original) return null;
    const newId = Math.random().toString(36).slice(2, 10);
    const dup = { ...original, id: newId, name: `${original.name} (Copy)`, createdAt: new Date(), updatedAt: new Date() };
    await this.save(dup); return dup;
  },
  saveThumbnail(id, dataUrl) { try { localStorage.setItem(`floorplan_thumb_${id}`, dataUrl); } catch {} },
  getThumbnail(id) { try { return localStorage.getItem(`floorplan_thumb_${id}`); } catch { return null; } },
};

async function currentUser() {
  if (!isFirebaseConfigured) throw new Error('Firebase is not configured');
  const user = getFirebaseAuth().currentUser;
  if (!user) throw new Error('Sign in to use cloud projects');
  return user;
}

export const firebaseStore: DataStore = {
  async save(project) {
    const user = await currentUser();
    const db = getFirestoreDb();
    const existing = await getDoc(doc(db, 'projects', project.id));
    const ownerId = existing.exists() ? existing.data().ownerId : user.uid;
    if (ownerId && ownerId !== user.uid) throw new Error('You do not have permission to edit this project');
    await setDoc(doc(db, 'projects', project.id), { ...project, ownerId: ownerId || user.uid, updatedAt: new Date() });
  },
  async load(id) {
    await currentUser();
    const snap = await getDoc(doc(getFirestoreDb(), 'projects', id));
    return snap.exists() ? hydrateProject(snap.data()) : null;
  },
  async list() {
    const user = await currentUser();
    const db = getFirestoreDb();
    const [owned, shared] = await Promise.all([
      getDocs(query(collection(db, 'projects'), where('ownerId', '==', user.uid))),
      getDocs(query(collection(db, 'projects'), where('sharedWith', 'array-contains', user.uid))),
    ]);
    const byId = new Map<string, { id: string; name: string; updatedAt: string }>();
    for (const snap of [...owned.docs, ...shared.docs]) {
      const p = snap.data();
      byId.set(snap.id, { id: snap.id, name: p.name || 'Untitled Project', updatedAt: new Date(asDate(p.updatedAt)).toISOString() });
    }
    return [...byId.values()];
  },
  async delete(id) { const user = await currentUser(); const ref = doc(getFirestoreDb(), 'projects', id); const snap = await getDoc(ref); if (!snap.exists() || snap.data().ownerId !== user.uid) throw new Error('Only the owner can delete this project'); await deleteDoc(ref); },
  async duplicate(id) { const original = await this.load(id); if (!original) return null; const dup = { ...original, id: Math.random().toString(36).slice(2, 10), name: `${original.name} (Copy)`, createdAt: new Date(), updatedAt: new Date() }; await this.save(dup); return dup; },
  saveThumbnail() {},
  getThumbnail() { return null; },
};

let activeStore: DataStore = localStore;
export const dataStore: DataStore = {
  save: (p) => activeStore.save(p), load: (id) => activeStore.load(id), list: () => activeStore.list(),
  delete: (id) => activeStore.delete(id), duplicate: (id) => activeStore.duplicate(id),
  saveThumbnail: (id, data) => activeStore.saveThumbnail(id, data), getThumbnail: (id) => activeStore.getThumbnail(id),
};
export function setDataStore(mode: 'local' | 'cloud') { activeStore = mode === 'cloud' ? firebaseStore : localStore; }
export function getDataStoreMode(): 'local' | 'cloud' { return activeStore === firebaseStore ? 'cloud' : 'local'; }
