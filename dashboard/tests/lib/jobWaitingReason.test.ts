import { jobWaitingReason } from "../../src/lib/jobWaitingReason";

test("waiting reasons for isolation read as plain sentences", () => {
  expect(jobWaitingReason("PRO_ISOLATION_REQUIRED")).toBe(
    "Waiting for an active Pro license to run with work-profile isolation.",
  );
  expect(jobWaitingReason("NO_ISOLATION_CAPABLE_DEVICE")).toBe(
    "Waiting for a device that supports work-profile isolation.",
  );
});
