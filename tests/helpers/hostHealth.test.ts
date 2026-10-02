import {
  isHostExhaustion,
  hostFailureReport,
  observedHostErrors,
  expectSimulatedHostError,
} from "./hostHealth";

describe("isHostExhaustion", () => {
  it.each(["ENOSPC", "EMFILE", "ENFILE", "ENOMEM"])(
    "treats %s as the host running out of a resource",
    (code) => {
      expect(isHostExhaustion(`{"msg":"job could not be started","err":"${code}: ..."}`)).toBe(true);
    },
  );

  // EACCES is deliberately NOT a host-exhaustion signature: two suites induce
  // it on purpose with chmod (tests/artifacts/collector.test.ts,
  // tests/index.test.ts) because a permission failure is a plausible thing to
  // simulate. Running out of disk is not.
  it.each(["EACCES", "ENOENT", "ECONNREFUSED"])("does not claim %s is host exhaustion", (code) => {
    expect(isHostExhaustion(`something failed with ${code}`)).toBe(false);
  });

  it("matches only whole codes, so ENOSPCX is not ENOSPC", () => {
    expect(isHostExhaustion("ENOSPCX: made up")).toBe(false);
  });
});

describe("hostFailureReport", () => {
  it("is silent when nothing was observed", () => {
    expect(hostFailureReport([], false)).toBeUndefined();
  });

  it("is silent when the test declared the failure simulated", () => {
    expect(hostFailureReport(['{"err":"ENOSPC: no space left on device"}'], true)).toBeUndefined();
  });

  it("names the host as the cause, not the code, and quotes what it saw", () => {
    const report = hostFailureReport(['{"err":"ENOSPC: no space left on device, mkdtemp"}'], false);
    expect(report).toBeDefined();
    expect(report).toMatch(/host/i);
    expect(report).toContain("ENOSPC");
    // The whole point: a reader must not go hunting for a bug in the code.
    expect(report).toMatch(/not a real (result|failure)|environment/i);
  });
});

describe("the installed console.error guard", () => {
  it("actually intercepts host-exhaustion output rather than only defining a matcher", () => {
    console.error(JSON.stringify({ msg: "job could not be started", err: "ENOSPC: no space left on device" }));
    expect(observedHostErrors().some((line) => line.includes("ENOSPC"))).toBe(true);

    // Declare it simulated so this test does not fail itself on the way out -
    // which is also the opt-out tests/server.test.ts relies on.
    expectSimulatedHostError();
  });

  it("lets ordinary error output through untouched", () => {
    console.error(JSON.stringify({ msg: "device status unavailable", err: "EACCES: denied" }));
    expect(observedHostErrors()).toEqual([]);
  });
});
