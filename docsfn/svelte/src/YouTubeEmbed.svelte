<script lang="ts">
  export let id = "";
  export let title = "YouTube video";

  const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{6,}$/;

  $: safeId = VIDEO_ID_REGEX.test(id) ? id : undefined;
  $: src = safeId ? `https://www.youtube-nocookie.com/embed/${safeId}` : undefined;
</script>

{#if src}
  <div class="docsfn-youtube-embed" data-docsfn-youtube-embed="true">
    <iframe
      {src}
      title={title || "YouTube video"}
      loading="lazy"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
      allowfullscreen
      referrerpolicy="strict-origin-when-cross-origin"
    ></iframe>
  </div>
{/if}

<style>
  .docsfn-youtube-embed {
    margin: 1.5rem 0;
    overflow: hidden;
    border: 1px solid var(--docsfn-border, #dbe4ef);
    border-radius: 0.75rem;
    background: var(--docsfn-surface-muted, #f8fafc);
    aspect-ratio: 16 / 9;
  }

  .docsfn-youtube-embed iframe {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
  }
</style>
