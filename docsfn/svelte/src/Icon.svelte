<script lang="ts">
  export type IconName =
    | "arrow-left"
    | "book-open"
    | "boxes"
    | "braces"
    | "check"
    | "chevron-down"
    | "chevron-right"
    | "circle-alert"
    | "circle-check"
    | "code-2"
    | "copy"
    | "external-link"
    | "file-text"
    | "info"
    | "lightbulb"
    | "menu"
    | "pencil"
    | "rocket"
    | "search"
    | "settings-2"
    | "terminal"
    | "thumbs-down"
    | "thumbs-up"
    | "triangle-alert"
    | "wrench"
    | "x";

  export let name: IconName;
  export let size = 16;
  export let strokeWidth = 1.8;

  const paths: Record<IconName, string> = {
    "arrow-left": '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    "book-open":
      '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    boxes:
      '<path d="M2.97 12.92 12 17.5l9.03-4.58"/><path d="M2.97 12.92 12 8.35l9.03 4.57v6.03L12 23.5l-9.03-4.55z"/><path d="M7.5 10.6V5.05L12 2.5l4.5 2.55v5.55"/><path d="M12 8.35v9.15"/>',
    braces: '<path d="M8 3H7a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-3a2 2 0 0 1 2-2 2 2 0 0 1-2-2V9a2 2 0 0 0-2-2h-1"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    "chevron-down": '<path d="m6 9 6 6 6-6"/>',
    "chevron-right": '<path d="m9 18 6-6-6-6"/>',
    "circle-alert":
      '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    "circle-check": '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    "code-2": '<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    "external-link": '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    "file-text": '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    lightbulb:
      '<path d="M15 14c.2-1 .7-1.7 1.5-2.5A4.9 4.9 0 0 0 18 8 6 6 0 0 0 6 8c0 1.3.5 2.6 1.5 3.5.8.8 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
    menu: '<path d="M4 12h16"/><path d="M4 6h16"/><path d="M4 18h16"/>',
    pencil:
      '<path d="M21.2 6.8a2.8 2.8 0 0 0-4-4L4 16v4h4z"/><path d="m15 5 4 4"/>',
    rocket:
      '<path d="M4.5 16.5c-1.5 1.3-2 4-2 4s2.7-.5 4-2c.8-.9.8-2.2 0-3s-2.1-.8-3 .0Z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22 22 0 0 1-4 2Z"/><path d="M9 12H4s.6-3.4 2-5c1.5-1.7 4 0 4 0"/><path d="M12 15v5s3.4-.6 5-2c1.7-1.5 0-4 0-4"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    "settings-2":
      '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
    terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
    "thumbs-down":
      '<path d="M17 14V2"/><path d="M9 18.1 10 14H4.2a2 2 0 0 1-1.9-2.6l2.4-7.4A2 2 0 0 1 6.6 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.8a2 2 0 0 0-1.7 1L12 22a3 3 0 0 1-3-3.9Z"/>',
    "thumbs-up":
      '<path d="M7 10v12"/><path d="M15 5.9 14 10h5.8a2 2 0 0 1 1.9 2.6l-2.4 7.4a2 2 0 0 1-1.9 1.4H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.8a2 2 0 0 0 1.7-1L12 2a3 3 0 0 1 3 3.9Z"/>',
    "triangle-alert":
      '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    wrench:
      '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.4 2.4-2.8-2.8z"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  };
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={strokeWidth}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  {@html paths[name]}
</svg>
