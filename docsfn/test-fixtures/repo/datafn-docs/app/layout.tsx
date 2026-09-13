import "./global.css";
import "@21n/fonts/styles.css";
import { RootProvider } from "fumadocs-ui/provider";
import { DocsRootLayout } from "@superfunctions/docs-theme";
import type { Metadata } from "next";

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:6001");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "DataFn Docs",
    template: "%s | DataFn Docs",
  },
  description:
    "Documentation for DataFn, the data processing and synchronization toolkit in Superfunctions.",
  openGraph: {
    type: "website",
    url: siteUrl,
    siteName: "DataFn Docs",
    title: "DataFn Docs",
    description:
      "Documentation for DataFn, the data processing and synchronization toolkit in Superfunctions.",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "DataFn Docs",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "DataFn Docs",
    description:
      "Documentation for DataFn, the data processing and synchronization toolkit in Superfunctions.",
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
