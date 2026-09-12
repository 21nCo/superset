import type { HarnessAdapter, HarnessCapabilities, HarnessRequest, HarnessResult } from "@reviewfn/core";
export class FixtureHarness implements HarnessAdapter {
  readonly name = "fixture"; readonly version = "1";
  constructor(private readonly result: HarnessResult, private readonly declared: Partial<HarnessCapabilities> = {}) {}
  async capabilities(): Promise<HarnessCapabilities> { return { providers: ["fixture"], auth: ["fixture"], structuredOutput: true, cancellation: true, events: true, ...this.declared }; }
  async run(_request: HarnessRequest): Promise<HarnessResult> { return structuredClone(this.result); }
}
