import React from "react";
import {
  BookOpen,
  Boxes,
  Braces,
  Code2,
  FileText,
  Rocket,
  Settings2,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";

const icons: Record<string, LucideIcon> = {
  book: BookOpen,
  "book-open": BookOpen,
  boxes: Boxes,
  blocks: Boxes,
  braces: Braces,
  code: Code2,
  "code-2": Code2,
  file: FileText,
  "file-text": FileText,
  rocket: Rocket,
  settings: Settings2,
  "settings-2": Settings2,
  terminal: Terminal,
  wrench: Wrench,
};

export function SidebarIcon({ name, size = 15 }: { name: string; size?: number }) {
  const normalizedName = name.trim().toLowerCase().replace(/[\s_]+/g, "-");
  const Icon = icons[normalizedName] ?? FileText;
  return <Icon size={size} strokeWidth={1.8} aria-hidden="true" />;
}
