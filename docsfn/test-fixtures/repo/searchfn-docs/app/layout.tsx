import "./global.css";
import "@21n/fonts/styles.css";
import { RootProvider } from "fumadocs-ui/provider";
import { DocsRootLayout } from "@superfunctions/docs-theme";
import type { Metadata } from "next";

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:6002");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "SearchFn Docs",
    template: "%s | SearchFn Docs",
  },
  description:
    "Documentation for SearchFn, full-text indexing and retrieval utilities in Superfunctions.",
  openGraph: {
    type: "website",
    url: siteUrl,
    siteName: "SearchFn Docs",
    title: "SearchFn Docs",
    description:
      "Documentation for SearchFn, full-text indexing and retrieval utilities in Superfunctions.",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "SearchFn Docs",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "SearchFn Docs",
    description:
      "Documentation for SearchFn, full-text indexing and retrieval utilities in Superfunctions.",
    images: ["/opengraph-image"],
  },
};

type DocsRootLayoutProps = Parameters<typeof DocsRootLayout>[0];
type RootProviderProps = Parameters<typeof RootProvider>[0];

export default function Layout({ children }: { children: DocsRootLayoutProps["children"] }) {
  return (
    <DocsRootLayout>
      <RootProvider>{children as RootProviderProps["children"]}</RootProvider>
    </DocsRootLayout>
  );
}
