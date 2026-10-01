import { listJobOutcome } from "../../src/lib/listJobOutcome";
import type { JobListEntry } from "../../src/lib/api";
const job: JobListEntry = { id: "example", org: "example", status: "done", error: null, createdAt: 0, startedAt: 0, finishedAt: 10, deviceId: null, appId: null, appVersion: null, flowCount: 3, passed: 3, failed: 0, running: 0 };
test("completed jobs with failed flows are failures", () => {
  expect(listJobOutcome({ ...job, passed: 2, failed: 1 })).toBe("failed");
  expect(listJobOutcome(job)).toBe("passed");
});
test("missing results cannot become successes", () => {
  expect(listJobOutcome({ ...job, passed: 0, flowCount: 0 })).toBe("unknown");
  expect(listJobOutcome({ ...job, passed: 2 })).toBe("unknown");
  expect(listJobOutcome({ ...job, status: "failed" })).toBe("failed");
});
