import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { RecentJobsChart } from "../../src/components/RecentJobsChart";
import type { JobListEntry } from "../../src/lib/api";

function job(overrides: Partial<JobListEntry>): JobListEntry {
  return {
    id: "job-1",
    org: "donable",
    status: "done",
    error: null,
    createdAt: 0,
    startedAt: 0,
    finishedAt: 0,
    deviceId: null,
    appId: null,
    appVersion: null,
    flowCount: 1,
    passed: 1,
    failed: 0,
    running: 0,
    ...overrides,
  };
}

test("shows an empty-state message when there are no jobs", () => {
  render(<RecentJobsChart jobs={[]} />);
  expect(screen.getByText(/no jobs yet/i)).toBeInTheDocument();
});

test("renders one bar per job", () => {
  const { container } = render(
    <RecentJobsChart
      jobs={[
        job({ id: "job-1", status: "done", startedAt: 0, finishedAt: 60_000 }),
        job({ id: "job-2", status: "failed", startedAt: 0, finishedAt: 30_000 }),
        job({ id: "job-3", status: "running", startedAt: 0, finishedAt: null }),
      ]}
    />
  );
  expect(container.querySelectorAll(".recent-run-bar")).toHaveLength(3);
});

test("shows the outcome legend and the latest run readout", () => {
  render(
    <RecentJobsChart
      jobs={[
        job({ id: "job-1", status: "done" }),
        job({ id: "job-2", status: "done" }),
        job({ id: "job-3", status: "failed" }),
        job({ id: "job-4", status: "running" }),
      ]}
    />
  );
  expect(screen.getByLabelText("Outcome legend")).toHaveTextContent("PassedFailedRunningQueued");
  expect(screen.getByText("job-4")).toBeInTheDocument();
});

test("updates the inline run readout on keyboard focus", () => {
  render(<RecentJobsChart jobs={[job({ id: "job-1", status: "done" }), job({ id: "job-2", status: "failed" })]} />);
  fireEvent.focus(screen.getByRole("link", { name: /job-1/ }));
  expect(screen.getByText("job-1")).toBeInTheDocument();
});

test("a job with no duration yet still gets a visible bar, not a zero-height one", () => {
  const { container } = render(
    <RecentJobsChart jobs={[job({ id: "job-1", status: "queued", startedAt: null, finishedAt: null })]} />
  );
  const marker = container.querySelector(".recent-run-bar")!;
  expect(marker).toHaveStyle({ height: "5px" });
  expect(screen.getByRole("link")).toHaveAccessibleName(/Duration unavailable/);
});
