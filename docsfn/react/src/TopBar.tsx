import React, { useState } from "react";
import type { DocsTopNavItem } from "@docsfn/core";
import { BookOpen, ChevronDown, ExternalLink, Menu, X } from "lucide-react";
import {
  Menu as DropdownMenu,
  MenuContent as DropdownMenuContent,
  MenuItem as DropdownMenuItem,
  MenuPositioner as DropdownMenuPositioner,
  MenuTrigger as DropdownMenuTrigger,
} from "@uifn/react";
import type { DocsPageSurface } from "./DocsLayout";

export interface TopBarLink {
  label: string;
  href: string;
  external?: boolean;
}

export interface TopBarDropdown {
  label: string;
  items: TopBarLink[];
}

export type TopBarItem = TopBarLink | TopBarDropdown;

export interface TopBarProps {
  surface?: DocsPageSurface;
  brand?: string;
  brandHref?: string;
  logo?: React.ReactNode;
  items?: Array<TopBarItem | DocsTopNavItem>;
  searchTrigger?: React.ReactNode;
  versionSelector?: React.ReactNode;
  mobileMenuTrigger?: React.ReactNode;
  className?: string;
}

function isDropdown(item: TopBarItem): item is TopBarDropdown {
  return "items" in item;
}

function mapTopNavItems(topNav: DocsTopNavItem[]): TopBarItem[] {
  return topNav.map((item) => {
    if (Array.isArray(item.children) && item.children.length > 0) {
      return {
        label: item.label,
        items: item.children.map((child) => ({
          label: child.label,
          href: child.href,
          external: child.external,
        })),
      };
    }

    return {
      label: item.label,
      href: item.href,
      external: item.external,
    };
  });
}

function renderLink(item: TopBarLink, className: string) {
  return (
    <a
      href={item.href}
      className={className}
      target={item.external ? "_blank" : undefined}
      rel={item.external ? "noreferrer noopener" : undefined}
    >
      {item.label}
      {item.external ? <ExternalLink size={13} strokeWidth={1.8} aria-hidden="true" /> : null}
    </a>
  );
}

function normalizeTopBarItems(input: Array<TopBarItem | DocsTopNavItem>): TopBarItem[] {
  return input.map((item) => {
    if ("children" in item) {
      return mapTopNavItems([item])[0];
    }
    return item;
  });
}

export function TopBar({
  surface,
  brand,
  brandHref = "/",
  logo,
  items,
  searchTrigger,
  versionSelector,
  mobileMenuTrigger,
  className,
}: TopBarProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const resolvedItems = normalizeTopBarItems(items ?? surface?.topNav ?? []);

  return (
    <header className={`docsfn-topbar ${className || ""}`}>
      <div className="docsfn-topbar-container">
        {logo || brand ? (
          <a className="docsfn-topbar-brand" href={brandHref} aria-label={brand ?? "Documentation home"}>
            {logo ? (
              <span className="docsfn-topbar-logo">{logo}</span>
            ) : (
              <span className="docsfn-topbar-brand-mark" aria-hidden="true">
                <BookOpen size={17} strokeWidth={2} />
              </span>
            )}
            {brand ? <span className="docsfn-topbar-brand-name">{brand}</span> : null}
          </a>
        ) : null}

        <nav className="docsfn-topbar-nav" aria-label="Main navigation">
          {resolvedItems.map((item, index) => {
            if (isDropdown(item)) {
              return (
                <DropdownMenu key={`${item.label}:${index}`}>
                  <DropdownMenuTrigger className="docsfn-topbar-dropdown-trigger">
                    {item.label}
                    <ChevronDown size={13} strokeWidth={1.8} aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuPositioner>
                    <DropdownMenuContent className="docsfn-topbar-dropdown-content">
                      {item.items.map((subItem, subIndex) => (
                        <DropdownMenuItem
                          key={`${subItem.label}:${subIndex}`}
                          value={`${subItem.label}:${subIndex}`}
                        >
                          {renderLink(subItem, "docsfn-topbar-dropdown-item")}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenuPositioner>
                </DropdownMenu>
              );
            }

            return (
              <React.Fragment key={`${item.label}:${index}`}>
                {renderLink(item, "docsfn-topbar-link")}
              </React.Fragment>
            );
          })}
        </nav>

        <div className="docsfn-topbar-actions">
          {searchTrigger}
          {versionSelector}
          {mobileMenuTrigger ?? (resolvedItems.length > 0 ? (
            <button
              type="button"
              className="docsfn-topbar-mobile-trigger"
              aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
              aria-expanded={mobileNavOpen}
              aria-controls="docsfn-topbar-mobile-nav"
              onClick={() => setMobileNavOpen((open) => !open)}
            >
              {mobileNavOpen ? <X size={19} strokeWidth={1.8} /> : <Menu size={19} strokeWidth={1.8} />}
            </button>
          ) : null)}
        </div>
      </div>

      {mobileNavOpen ? (
        <nav id="docsfn-topbar-mobile-nav" className="docsfn-topbar-mobile-nav" aria-label="Mobile navigation">
          {resolvedItems.map((item, index) => {
            if (isDropdown(item)) {
              return (
                <div className="docsfn-topbar-mobile-group" key={`mobile:${item.label}:${index}`}>
                  <span>{item.label}</span>
                  {item.items.map((subItem) => (
                    <a
                      key={`mobile:${subItem.label}:${subItem.href}`}
                      href={subItem.href}
                      target={subItem.external ? "_blank" : undefined}
                      rel={subItem.external ? "noreferrer noopener" : undefined}
                      onClick={() => setMobileNavOpen(false)}
                    >
                      {subItem.label}
                      {subItem.external ? <ExternalLink size={13} strokeWidth={1.8} /> : null}
                    </a>
                  ))}
                </div>
              );
            }
            return (
              <a
                key={`mobile:${item.label}:${index}`}
                href={item.href}
                target={item.external ? "_blank" : undefined}
                rel={item.external ? "noreferrer noopener" : undefined}
                onClick={() => setMobileNavOpen(false)}
              >
                {item.label}
                {item.external ? <ExternalLink size={13} strokeWidth={1.8} /> : null}
              </a>
            );
          })}
        </nav>
      ) : null}
    </header>
  );
}
