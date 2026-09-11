import React from "react";
import type { Version } from "@docsfn/core";
import {
  Menu as DropdownMenu,
  MenuContent as DropdownMenuContent,
  MenuItem as DropdownMenuItem,
  MenuPositioner as DropdownMenuPositioner,
  MenuTrigger as DropdownMenuTrigger,
} from "@uifn/react";
import type { DocsPageSurface } from "./DocsLayout";

export interface VersionSwitcherProps {
  surface?: DocsPageSurface;
  versions?: Version[];
  currentVersion?: string;
  onVersionChange?: (versionSlug: string) => void;
  className?: string;
  basePath?: string;
  versionMode?: "path-prefix" | "path-segment";
}



export function VersionSwitcher({
  surface,
  versions,
  currentVersion,
  onVersionChange,
  className,
  basePath = "/docs",
  versionMode = "path-prefix",
}: VersionSwitcherProps) {
  const resolvedVersions = versions ?? surface?.versions ?? [];
  const resolvedCurrentVersion =
    currentVersion ??
    surface?.currentVersion ??
    resolvedVersions.find((version) => version.isDefault)?.slug ??
    resolvedVersions[0]?.slug;

  const current = resolvedVersions.find((version) => version.slug === resolvedCurrentVersion);

  const navigateToVersion = (versionSlug: string) => {
    if (onVersionChange) {
      onVersionChange(versionSlug);
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    const explicitLink = surface?.versionLinks?.[versionSlug];
    if (explicitLink) {
      window.location.href = explicitLink;
      return;
    }

    const segments = window.location.pathname.split("/");
    const baseSegments = basePath.split("/").filter(Boolean);
    const index = versionMode === "path-segment"
      ? segments.length - 1 - [...segments].reverse().findIndex((segment) => segment.length > 0)
      : baseSegments.length + 1;
    if (versionMode === "path-prefix" && baseSegments.some((part, i) => segments[i + 1] !== part)) return;
    if (!resolvedVersions.some((version) => version.slug === segments[index])) return;
    segments[index] = versionSlug;
    const nextPath = segments.join("/");
    if (nextPath !== window.location.pathname) {
      window.location.href = `${nextPath}${window.location.search}${window.location.hash}`;
    }
  };

  if (resolvedVersions.length <= 1 || !resolvedCurrentVersion) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={`docsfn-version-switcher-trigger ${className || ""}`}>
        <span className="docsfn-version-label">{current?.label || resolvedCurrentVersion}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path
            d="M3 5L6 8L9 5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </DropdownMenuTrigger>
      <DropdownMenuPositioner>
        <DropdownMenuContent className="docsfn-version-switcher-content">
          {resolvedVersions.map((version) => {
            const isActive = version.slug === resolvedCurrentVersion;
            return (
              <DropdownMenuItem
                key={version.slug}
                value={version.slug}
                onClick={() => navigateToVersion(version.slug)}
                className={`docsfn-version-item ${isActive ? "active" : ""}`}
                data-active={isActive}
              >
                <span className="docsfn-version-item-label">{version.label}</span>
                {version.isDefault ? <span className="docsfn-version-badge">Default</span> : null}
                {isActive ? (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    className="docsfn-version-check"
                    aria-hidden="true"
                  >
                    <path
                      d="M13 4L6 11L3 8"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenuPositioner>
    </DropdownMenu>
  );
}
