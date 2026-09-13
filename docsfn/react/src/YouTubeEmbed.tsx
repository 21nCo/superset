import React from "react";

export interface YouTubeEmbedProps extends Record<string, unknown> {
  id?: unknown;
  title?: unknown;
  children?: React.ReactNode;
}

const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{6,}$/;

export function YouTubeEmbed({ id, title }: YouTubeEmbedProps) {
  const videoId = typeof id === "string" && VIDEO_ID_REGEX.test(id) ? id : undefined;

  if (!videoId) {
    return null;
  }

  return (
    <div
      className="docsfn-youtube-embed"
      data-docsfn-youtube-embed="true"
      style={{
        margin: "1.5rem 0",
        overflow: "hidden",
        border: "1px solid var(--docsfn-border, #dbe4ef)",
        borderRadius: "0.75rem",
        background: "var(--docsfn-surface-muted, #f8fafc)",
        aspectRatio: "16 / 9",
      }}
    >
      <iframe
        src={`https://www.youtube-nocookie.com/embed/${videoId}`}
        title={typeof title === "string" && title ? title : "YouTube video"}
        loading="lazy"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          border: 0,
        }}
      />
    </div>
  );
}
