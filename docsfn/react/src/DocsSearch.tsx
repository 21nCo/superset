"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { maybeEmitAnalyticsEvent, type DocsAnalyticsEvent } from "@docsfn/core/analytics";
import type { DocsSearchArtifact, DocsSearchScope } from "@docsfn/core/search";
import {
  createDocsSearchRuntime,
  type DocsSearchRuntime,
  type DocsSearchRuntimeResultItem,
} from "@docsfn/core/search-runtime";
import {
  Dialog,
  DialogBackdrop as DialogOverlay,
  DialogContent,
  DialogPortal,
  DialogPositioner,
} from "@uifn/react";
import { ScrollArea } from "@uifn/react";
import { navigateTo } from "./navigation";

type SearchScopeFilter = DocsSearchScope | "all";

export interface DocsSearchProps {
  searchArtifact?: DocsSearchArtifact;
  searchIndex?: DocsSearchArtifact;
  loadSearchArtifact?: () => Promise<DocsSearchArtifact>;
  placeholder?: string;
  initialScope?: SearchScopeFilter;
  scopes?: SearchScopeFilter[];
  preserveSearchParams?: string[];
  analytics?: {
    enabled?: boolean;
    respectDnt?: boolean;
    route?: string;
    onEvent?: (event: DocsAnalyticsEvent) => void;
  };
}

function normalizeScopes(input?: SearchScopeFilter[]): SearchScopeFilter[] {
  if (!input || input.length === 0) {
    return ["all"];
  }
  return Array.from(new Set(input));
}

function getScopeLabel(value: string): string {
  if (value.toLowerCase() === "api") {
    return "API";
  }
  return value
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function createTimestamp(): string {
  return new Date().toISOString();
}

export function DocsSearch({
  searchArtifact,
  searchIndex,
  loadSearchArtifact,
  placeholder = "Search docs...",
  initialScope = "all",
  scopes: scopeInput,
  preserveSearchParams = ["embed"],
  analytics,
}: DocsSearchProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DocsSearchRuntimeResultItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scope, setScope] = useState<SearchScopeFilter>(initialScope);
  const inputRef = useRef<HTMLInputElement>(null);
  const runtimeRef = useRef<DocsSearchRuntime | null>(null);
  const queryRequestRef = useRef(0);
  const [loadedScopes, setLoadedScopes] = useState<SearchScopeFilter[]>([]);
  const artifact = searchArtifact ?? searchIndex;
  const supportedScopes = useMemo(() => normalizeScopes(scopeInput ?? ["all", ...(artifact?.scopes ?? loadedScopes)]), [scopeInput, artifact, loadedScopes]);
  useEffect(() => {
    if (!supportedScopes.includes(scope)) setScope("all");
  }, [supportedScopes, scope]);

  useEffect(() => {
    let active = true;
    setLoadedScopes([]);
    runtimeRef.current = createDocsSearchRuntime({
      artifact: searchArtifact ?? searchIndex,
      loadArtifact: loadSearchArtifact ? async () => {
        const loaded = await loadSearchArtifact();
        if (active) setLoadedScopes(loaded.scopes);
        return loaded;
      } : undefined,
    });
    return () => { active = false; };
  }, [searchArtifact, searchIndex, loadSearchArtifact]);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, []);

  useEffect(() => {
    if (!isOpen || !inputRef.current) {
      return;
    }
    inputRef.current.focus();
  }, [isOpen]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !query.trim()) {
      queryRequestRef.current += 1;
      setResults([]);
      setSelectedIndex(0);
      return;
    }

    const requestId = queryRequestRef.current + 1;
    queryRequestRef.current = requestId;
    void runtime
      .query({
        query,
        scope,
        limit: 10,
      })
      .then((nextResults) => {
        if (queryRequestRef.current !== requestId) {
          return;
        }
        setResults(nextResults);
        setSelectedIndex(0);

        maybeEmitAnalyticsEvent({
          enabled: Boolean(analytics?.enabled),
          respectDnt: analytics?.respectDnt ?? true,
          event: {
            name: "docs.search",
            timestamp: createTimestamp(),
            route: analytics?.route ?? window.location.pathname,
            searchScope: scope === "all" ? undefined : scope,
            resultCount: nextResults.length,
          },
          emit: (event) => analytics?.onEvent?.(event),
        });
      })
      .catch(() => {
        if (queryRequestRef.current !== requestId) {
          return;
        }
        setResults([]);
        setSelectedIndex(0);
      });
  }, [query, scope, analytics]);

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (!open) {
      setQuery("");
      setResults([]);
      setSelectedIndex(0);
    }
  };

  const handleResultClick = (result: DocsSearchRuntimeResultItem) => {
    let targetPath = result.path;
    if (typeof window !== "undefined" && preserveSearchParams.length > 0) {
      const currentUrl = new URL(window.location.href);
      const targetUrl = new URL(result.path, currentUrl.origin);
      if (targetUrl.origin === currentUrl.origin) {
        for (const param of preserveSearchParams) {
          const value = currentUrl.searchParams.get(param);
          if (value !== null && !targetUrl.searchParams.has(param)) {
            targetUrl.searchParams.set(param, value.length > 0 ? value : "1");
          }
        }
        targetPath = `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;
      }
    }
    maybeEmitAnalyticsEvent({
      enabled: Boolean(analytics?.enabled),
      respectDnt: analytics?.respectDnt ?? true,
      event: {
        name: "docs.search_result_click",
        timestamp: createTimestamp(),
        route: analytics?.route ?? window.location.pathname,
        searchScope: result.scope,
        targetUrl: targetPath,
      },
      emit: (event) => analytics?.onEvent?.(event),
    });
    navigateTo(targetPath);
    setIsOpen(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (results.length === 0) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((previous) => Math.min(previous + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((previous) => Math.max(previous - 1, 0));
    } else if (event.key === "Enter" && results[selectedIndex]) {
      event.preventDefault();
      handleResultClick(results[selectedIndex]);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <button
        className="docsfn-search-trigger"
        onClick={() => setIsOpen(true)}
        aria-label="Search documentation"
      >
        <span className="docsfn-search-icon" aria-hidden="true">
          <Search size={16} strokeWidth={1.8} />
        </span>
        <span className="docsfn-search-placeholder">{placeholder}</span>
        <kbd className="docsfn-search-kbd">
          <span>⌘</span>
          <span>K</span>
        </kbd>
      </button>

      <DialogPortal>
        <DialogOverlay className="docsfn-search-overlay" />
        <DialogPositioner>
          <DialogContent className="docsfn-search-content" onKeyDown={handleKeyDown}>
          <div className="docsfn-search-header">
            <span className="docsfn-search-icon" aria-hidden="true">
              <Search size={18} strokeWidth={1.8} />
            </span>
            <input
              ref={inputRef}
              type="text"
              className="docsfn-search-input"
              placeholder={placeholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search query"
            />
            {query ? (
              <button
                onClick={() => setQuery("")}
                className="docsfn-search-clear"
                aria-label="Clear search"
              >
                <X size={17} strokeWidth={1.8} aria-hidden="true" />
              </button>
            ) : null}
          </div>

          <div className="docsfn-search-scopes" role="group" aria-label="Search scope">
            {supportedScopes.map((option) => (
              <button
                type="button"
                key={option}
                className={scope === option ? "docsfn-search-scope-active" : ""}
                aria-pressed={scope === option}
                onClick={() => setScope(option)}
              >
                {getScopeLabel(option)}
              </button>
            ))}
          </div>

          <ScrollArea className="docsfn-search-results">
            {results.length === 0 && query ? (
              <div className="docsfn-search-empty">
                <p>No results found for &quot;{query}&quot;</p>
              </div>
            ) : null}
            {results.length === 0 && !query ? (
              <div className="docsfn-search-empty">
                <p>Start typing to search...</p>
              </div>
            ) : null}
            {results.length > 0 ? (
              <div className="docsfn-search-results-list">
                {results.map((result, index) => (
                  <button
                    key={`${result.id}:${result.path}`}
                    onClick={() => handleResultClick(result)}
                    className={`docsfn-search-item ${index === selectedIndex ? "selected" : ""}`}
                    data-selected={index === selectedIndex}
                  >
                    <div className="docsfn-search-item-header">
                      <span className="docsfn-search-item-scope">{getScopeLabel(result.scope)}</span>
                      <span className="docsfn-search-item-title">{result.title}</span>
                    </div>
                    {result.summary ? (
                      <p className="docsfn-search-item-desc">{result.summary}</p>
                    ) : null}
                    <div className="docsfn-search-item-footer">
                      <span className="docsfn-search-item-path">{result.path}</span>
                    </div>
                  </button>
                ))}
              </div>
            ) : null}
          </ScrollArea>
          </DialogContent>
        </DialogPositioner>
      </DialogPortal>
    </Dialog>
  );
}
