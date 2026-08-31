<script lang="ts">
  import { onMount } from 'svelte';
  import { getSyncState, subscribeSync, type SyncState } from '$lib/services/datastore';
  let state = $state<SyncState>(getSyncState());
  onMount(() => subscribeSync((next) => state = next));
  const labels: Record<SyncState, string> = { 'local-only': 'Somente local', synced: 'Sincronizado', pending: 'Sincronizando…', offline: 'Servidor indisponível', conflict: 'Conflito preservado' };
  const colors: Record<SyncState, string> = { 'local-only': 'bg-gray-100 text-gray-500', synced: 'bg-emerald-50 text-emerald-700', pending: 'bg-amber-50 text-amber-700', offline: 'bg-gray-100 text-gray-500', conflict: 'bg-red-50 text-red-700' };
</script>

<span class="rounded-full px-2.5 py-1 text-[11px] font-medium {colors[state]}" title="A sincronização ocorre automaticamente quando o servidor está disponível">{labels[state]}</span>
