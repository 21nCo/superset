import React, { useEffect, useState } from "react";
import type { Sidebar, SidebarItem } from "@docsfn/core";
import { ChevronRight, ExternalLink } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ScrollArea,
  ScrollAreaViewport,
} from "@uifn/react";
import type { DocsPageSurface } from "./DocsLayout";
import { SidebarIcon } from "./SidebarIcon";

export interface DocsSidebarProps {
  surface?: DocsPageSurface;
  sidebar?: Sidebar;
  activePath?: string;
}

export function DocsSidebar({
  surface,
  sidebar,
  activePath,
}: DocsSidebarProps) {
  const resolvedSidebar = sidebar ?? surface?.sidebar;
  const resolvedActivePath = activePath ?? surface?.route;

  if (!resolvedSidebar) {
    return null;
  }

  return (
    <ScrollArea className="docsfn-sidebar">
      <ScrollAreaViewport className="docsfn-sidebar-viewport">
        <nav className="docsfn-sidebar-nav" aria-label="Documentation navigation">
          {resolvedSidebar.items.map((item, index) => (
            <SidebarGroup
              key={`${item.type}:${index}`}
              item={item}
              activePath={resolvedActivePath}
            />
          ))}
        </nav>
      </ScrollAreaViewport>
    </ScrollArea>
  );
}

interface SidebarGroupProps {
  item: SidebarItem;
  activePath?: string;
  depth?: number;
}

function SidebarGroup({
  item,
  activePath,
  depth = 0,
}: SidebarGroupProps) {
  const hasActiveChild = item.type === "group" && hasActiveLink(item, activePath);
  const [open, setOpen] = useState(
    item.type === "group" && (item.expanded === true || hasActiveChild)
  );

  useEffect(() => {
    if (hasActiveChild) {
      setOpen(true);
    }
  }, [hasActiveChild]);

  if (item.type === "separator") {
    return <hr className="docsfn-sidebar-separator" />;
  }

  if (item.type === "group") {
    return (
      <Collapsible
        className="docsfn-sidebar-group"
        data-depth={depth}
        open={open}
        onOpenChange={setOpen}
      >
        <CollapsibleTrigger className="docsfn-sidebar-group-trigger">
          {item.icon ? <span className="docsfn-sidebar-item-icon"><SidebarIcon name={item.icon} /></span> : null}
          <span className="docsfn-sidebar-group-text" title={item.description}>{item.text}</span>
          {item.badge ? <span className="docsfn-sidebar-badge">{item.badge}</span> : null}
          <span className="docsfn-sidebar-group-icon" aria-hidden="true">
            <ChevronRight size={13} strokeWidth={1.8} />
          </span>
        </CollapsibleTrigger>

        <CollapsibleContent className="docsfn-sidebar-group-content">
          {item.items?.map((child, childIndex) => (
            <SidebarGroup
              key={`${child.type}:${childIndex}`}
              item={child}
              activePath={activePath}
              depth={depth + 1}
            />
          ))}
        </CollapsibleContent>
      </Collapsible>
    );
  }

  const isActive = activePath === item.link;
  const isExternal = Boolean(item.link?.startsWith("http"));
  return (
    <a
      href={item.link}
      className={`docsfn-sidebar-link ${isActive ? "active" : ""}`}
      data-active={isActive}
      data-depth={depth}
      aria-current={isActive ? "page" : undefined}
      title={item.description}
      target={isExternal ? "_blank" : undefined}
      rel={isExternal ? "noreferrer noopener" : undefined}
    >
      {item.icon ? <span className="docsfn-sidebar-item-icon"><SidebarIcon name={item.icon} /></span> : null}
      <span className="docsfn-sidebar-link-text">{item.text}</span>
      {item.badge ? <span className="docsfn-sidebar-badge">{item.badge}</span> : null}
      {isExternal ? <ExternalLink size={12} strokeWidth={1.8} aria-hidden="true" /> : null}
    </a>
  );
}

function hasActiveLink(item: SidebarItem, activePath?: string): boolean {
  if (item.type === "link" && item.link === activePath) {
    return true;
  }
  if (item.type === "group" && item.items) {
    return item.items.some((child) => hasActiveLink(child, activePath));
  }
  return false;
}
