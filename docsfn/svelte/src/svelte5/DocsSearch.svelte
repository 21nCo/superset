<script lang="ts">
  export let placeholder = "Search docs...";
  export let scopes: string[] = ["all", "docs"];
  export let initialScope = "all";

  let query = "";
  let scope = initialScope;
</script>

<form class="docsfn-search" role="search">
  <select bind:value={scope} aria-label="Search scope">
    {#each scopes as option}
      <option value={option}>{option}</option>
    {/each}
  </select>
  <input bind:value={query} {placeholder} aria-label="Search docs" />
</form>

<style>
  .docsfn-search {
    display: flex;
    gap: 0.5rem;
  }

  .docsfn-search input,
  .docsfn-search select {
    border: 1px solid rgba(23, 33, 25, 0.14);
    border-radius: 999px;
    background: rgba(255, 252, 242, 0.86);
    padding: 0.55rem 0.75rem;
  }

  .docsfn-search input {
    min-width: 12rem;
  }
</style>
