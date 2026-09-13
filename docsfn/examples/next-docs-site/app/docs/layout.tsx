import type { ReactNode } from "react";

export default function DocsSectionLayout({ children }: { children: ReactNode }) {
  return <section className="docs-example-shell">{children}</section>;
}
