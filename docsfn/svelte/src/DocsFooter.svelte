<script lang="ts">
  export interface DocsFooterLink {
    label: string;
    href: string;
    external?: boolean;
  }

  export let note = "Built with docsfn";
  export let links: DocsFooterLink[] = [];
</script>

<footer class="docsfn-footer">
  <div class="docsfn-footer-inner">
    <p>{note}</p>
    {#if links.length > 0}
      <nav aria-label="Footer navigation">
        {#each links as link (`${link.label}:${link.href}`)}
          <a
            href={link.href}
            target={link.external ? "_blank" : undefined}
            rel={link.external ? "noreferrer noopener" : undefined}
          >
            {link.label}
          </a>
        {/each}
      </nav>
    {/if}
  </div>
</footer>
