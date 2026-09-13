<script lang="ts">
  import Icon, { type IconName } from "./Icon.svelte";

  export let name: string;
  export let size = 15;

  const icons: Record<string, IconName> = {
    book: "book-open",
    "book-open": "book-open",
    boxes: "boxes",
    blocks: "boxes",
    braces: "braces",
    code: "code-2",
    "code-2": "code-2",
    file: "file-text",
    "file-text": "file-text",
    rocket: "rocket",
    settings: "settings-2",
    "settings-2": "settings-2",
    terminal: "terminal",
    wrench: "wrench",
  };

  $: normalizedName = name.trim().toLowerCase().replace(/[\s_]+/g, "-");
  $: iconName = icons[normalizedName] ?? "file-text";
</script>

<Icon name={iconName} {size} strokeWidth={1.8} />
