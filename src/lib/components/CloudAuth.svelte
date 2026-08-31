<script lang="ts">
  import { onMount } from 'svelte';
  import type { User } from 'firebase/auth';
  import { isFirebaseConfigured } from '$lib/firebase';
  import { signIn, signOutUser, signUp, watchAuth } from '$lib/services/auth';
  import { setDataStore } from '$lib/services/datastore';

  let { onChanged }: { onChanged: () => void } = $props();
  let user = $state<User | null>(null);
  let email = $state('');
  let password = $state('');
  let error = $state('');
  let busy = $state(false);

  onMount(() => watchAuth((next) => {
    user = next;
    setDataStore(next ? 'cloud' : 'local');
    onChanged();
  }));

  async function submit(mode: 'signin' | 'signup') {
    error = '';
    busy = true;
    try {
      if (mode === 'signin') await signIn(email.trim(), password);
      else await signUp(email.trim(), password);
      password = '';
    } catch (e: any) {
      error = e?.code === 'auth/invalid-credential' ? 'E-mail ou senha inválidos.' : (e?.message || 'Não foi possível autenticar.');
    } finally { busy = false; }
  }

  async function logout() { await signOutUser(); }
</script>

{#if isFirebaseConfigured}
  <div class="flex items-center gap-2">
    {#if user}
      <span class="text-xs text-white/70 max-w-36 truncate" title={user.email ?? ''}>☁ {user.email}</span>
      <button onclick={logout} class="px-3 py-2 bg-white/10 text-white rounded-lg hover:bg-white/20 text-xs border border-white/20">Sair</button>
    {:else}
      <details class="relative">
        <summary class="list-none cursor-pointer px-3 py-2 bg-white/10 text-white rounded-lg hover:bg-white/20 text-xs border border-white/20">☁ Entrar para salvar</summary>
        <form class="absolute right-0 top-11 z-50 w-72 rounded-xl bg-white p-4 shadow-xl text-gray-800" onsubmit={(e) => { e.preventDefault(); submit('signin'); }}>
          <p class="font-semibold text-sm mb-3">Projetos na nuvem</p>
          <input class="w-full border border-gray-200 rounded px-2 py-1.5 text-sm mb-2" type="email" placeholder="E-mail" bind:value={email} required />
          <input class="w-full border border-gray-200 rounded px-2 py-1.5 text-sm mb-3" type="password" placeholder="Senha (mín. 6 caracteres)" bind:value={password} minlength="6" required />
          {#if error}<p class="text-xs text-red-600 mb-2">{error}</p>{/if}
          <div class="flex gap-2">
            <button class="flex-1 rounded bg-blue-500 px-2 py-1.5 text-xs text-white disabled:opacity-50" disabled={busy}>Entrar</button>
            <button type="button" class="flex-1 rounded border border-gray-200 px-2 py-1.5 text-xs text-gray-700 disabled:opacity-50" disabled={busy} onclick={() => submit('signup')}>Criar conta</button>
          </div>
        </form>
      </details>
    {/if}
  </div>
{/if}
