import { createSearchArtifactResponse } from "@docsfn/next";
import { loadDocsSiteSource } from "@/source.config";

export async function GET() {
  const source = await loadDocsSiteSource();
  return createSearchArtifactResponse({
    artifact: source.searchArtifact,
    cacheControl: "public, max-age=0, must-revalidate",
  });
}
