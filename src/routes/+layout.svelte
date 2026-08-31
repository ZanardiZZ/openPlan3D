<script lang="ts">
  import { onMount } from 'svelte';
  import { watchAuth } from '$lib/services/auth';
  import { setDataStore } from '$lib/services/datastore';

  onMount(() => watchAuth((user) => setDataStore(user ? 'cloud' : 'local')));
</script>

<slot />
