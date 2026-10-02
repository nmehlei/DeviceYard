import { completedDuration, formatRunDuration } from "../../src/lib/runDuration";
import type { JobListEntry } from "../../src/lib/api";
const job = { status: "done", startedAt: 0, finishedAt: 102000 } as JobListEntry;
test("completed durations include a zero timestamp and use readable units", () => {
  expect(formatRunDuration(completedDuration(job))).toBe("1m 42s");
  expect(formatRunDuration(1406000)).toBe("23m 26s");
  expect(formatRunDuration(0)).toBe("0s");
});
test("active or incomplete runs never acquire a completed duration", () => {
  expect(completedDuration({ ...job, status: "running" })).toBeNull();
  expect(completedDuration({ ...job, finishedAt: null })).toBeNull();
  expect(formatRunDuration(null)).toBe("—");
});
