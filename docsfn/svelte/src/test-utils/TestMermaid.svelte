<script lang="ts">
  import type { CompiledMermaidBlock } from "@docsfn/core/browser";

  export let block: CompiledMermaidBlock;
</script>

<div data-rendered-mermaid={block.id}>
  <span>{block.code}</span>
</div>
