export type ReviewFnErrorCode =
  | "REVIEWFN_CONFIG_INVALID"
  | "REVIEWFN_GATE_NOT_AUTHORIZED"
  | "REVIEWFN_PREFLIGHT_FAILED"
  | "REVIEWFN_CONTEXT_INCOMPLETE"
  | "REVIEWFN_HARNESS_FAILED"
  | "REVIEWFN_REPORT_INVALID"
  | "REVIEWFN_STALE_HEAD"
  | "REVIEWFN_CANCELED"
  | "REVIEWFN_ARTIFACT_UNSAFE";

export class ReviewFnError extends Error {
  public constructor(
    public readonly code: ReviewFnErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ReviewFnError";
  }
}
