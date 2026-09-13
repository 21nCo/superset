<script lang="ts">
  let className = "";
  export { className as class };
</script>

<button type="button" class={className} {...$$restProps} on:click on:keydown>
  <slot />
</button>
