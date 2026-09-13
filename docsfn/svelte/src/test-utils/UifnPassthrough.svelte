<script lang="ts">
  let className = "";
  export { className as class };
</script>

<div class={className} role="group" {...$$restProps} on:click on:keydown>
  <slot />
</div>
