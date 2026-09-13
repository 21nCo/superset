"use client";

import { useEffect, useState } from "react";

export function SearchArtifactStatus() {
  const [status, setStatus] = useState("Loading search artifact...");

  useEffect(() => {
    let isMounted = true;

    async function loadArtifact() {
      try {
        const response = await fetch("/api/search", {
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error(`status ${response.status}`);
        }
        const artifact = (await response.json()) as {
          documents?: Array<unknown>;
          scopes?: Array<string>;
        };

        if (!isMounted) {
          return;
        }

        const documentCount = Array.isArray(artifact.documents)
          ? artifact.documents.length
          : 0;
        const scopes = Array.isArray(artifact.scopes)
          ? artifact.scopes.join(", ")
          : "none";

        setStatus(`Search ready: ${documentCount} docs (${scopes})`);
      } catch (error) {
        if (!isMounted) {
          return;
        }
        const message = error instanceof Error ? error.message : "unknown failure";
        setStatus(`Search failed: ${message}`);
      }
    }

    void loadArtifact();

    return () => {
      isMounted = false;
    };
  }, []);

  return <p className="docs-example-search-status">{status}</p>;
}
