import { onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, type User } from 'firebase/auth';
import { getFirebaseAuth, isFirebaseConfigured } from '$lib/firebase';

let authReady: Promise<User | null> | null = null;

export function waitForAuth(): Promise<User | null> {
  if (!isFirebaseConfigured) return Promise.resolve(null);
  if (!authReady) {
    authReady = new Promise((resolve) => {
      const unsubscribe = onAuthStateChanged(getFirebaseAuth(), (user) => { unsubscribe(); resolve(user); });
    });
  }
  return authReady;
}

export function watchAuth(callback: (user: User | null) => void): () => void {
  if (!isFirebaseConfigured) { callback(null); return () => {}; }
  return onAuthStateChanged(getFirebaseAuth(), callback);
}

export async function signIn(email: string, password: string) {
  if (!isFirebaseConfigured) throw new Error('Firebase is not configured');
  return signInWithEmailAndPassword(getFirebaseAuth(), email, password);
}

export async function signUp(email: string, password: string) {
  if (!isFirebaseConfigured) throw new Error('Firebase is not configured');
  return createUserWithEmailAndPassword(getFirebaseAuth(), email, password);
}

export async function signOutUser() {
  if (isFirebaseConfigured) await signOut(getFirebaseAuth());
}
