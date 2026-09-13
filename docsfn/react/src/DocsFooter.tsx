import React from "react";

export interface DocsFooterLink {
  label: string;
  href: string;
  external?: boolean;
}

export interface DocsFooterProps {
  note?: React.ReactNode;
  links?: DocsFooterLink[];
}

export function DocsFooter({ note = "Built with docsfn", links = [] }: DocsFooterProps) {
  return (
    <footer className="docsfn-footer">
      <div className="docsfn-footer-inner">
        <p>{note}</p>
        {links.length > 0 ? (
          <nav aria-label="Footer navigation">
            {links.map((link) => (
              <a
                key={`${link.label}:${link.href}`}
                href={link.href}
                target={link.external ? "_blank" : undefined}
                rel={link.external ? "noreferrer noopener" : undefined}
              >
                {link.label}
              </a>
            ))}
          </nav>
        ) : null}
      </div>
    </footer>
  );
}
