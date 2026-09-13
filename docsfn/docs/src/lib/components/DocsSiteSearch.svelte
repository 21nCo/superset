<script lang="ts">
  import DocsSearch from "@site/docs-search";

  async function loadSearchArtifact() {
    const response = await fetch("/search.json");
    if (!response.ok) {
      throw new Error(`search artifact request failed: ${response.status}`);
    }
    return response.json();
  }
</script>

<DocsSearch
  {loadSearchArtifact}
  placeholder="Search documentation..."
  scopes={["all", "docs", "api", "blog", "changelog"]}
/>
