<script lang="ts">
  import { onMount } from 'svelte';
  import { startAutoSync } from '$lib/services/datastore';
  import SyncStatus from '$lib/components/SyncStatus.svelte';

  onMount(() => startAutoSync());
</script>

<div class="fixed bottom-3 right-3 z-[200]"><SyncStatus /></div>
<slot />
