import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import JobPage from "../../src/app/jobs/page";
import * as useJobEventsModule from "../../src/lib/useJobEvents";
import * as api from "../../src/lib/api";
import type { JobDetail } from "../../src/lib/api";
import { navigate } from "../../src/lib/navigate";

jest.mock("../../src/lib/navigate");
// jest.mock + requireActual, not jest.spyOn(...) - see Task 6's brief for
// why named exports can't be spied on directly in this project's Jest setup.
// Applies here too: useJobEvents is a named export of its own module, same
// as api.ts's exports and window.location.
jest.mock("../../src/lib/api", () => ({
  ...jest.requireActual("../../src/lib/api"),
  fetchSession: jest.fn(),
  fetchDevices: jest.fn(),
}));
jest.mock("../../src/lib/useJobEvents", () => ({
  ...jest.requireActual("../../src/lib/useJobEvents"),
  useJobEvents: jest.fn(),
}));

const detail: JobDetail = {
  job: { id: "job-abc", org: "donable", status: "failed", error: "some failure reason", createdAt: 0, startedAt: 0, finishedAt: 1000, deviceId: null, appId: null, appVersion: null },
  steps: [
    { id: 1, jobId: "job-abc", ordinal: 0, kind: "flow", name: "map/map", status: "failed", exitCode: 1, startedAt: 0, finishedAt: 500, resolvedPath: null, artifactDir: null, warnings: [], stdoutPreview: "out", stderrPreview: "err", artifacts: [] },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  // window.location.pathname can be set for real via the History API - this
  // works fine in this project's jsdom, unlike replacing window.location
  // wholesale or mocking window.location.assign (see Task 6's brief).
  window.history.pushState({}, "", "/jobs/job-abc");
  // The session guard's own probe call - resolved by default in every test
  // below except the dedicated 401 test, which overrides it.
  (api.fetchSession as jest.Mock).mockResolvedValue({
    user: { id: 1, username: "n", email: "n@x.com", isAdmin: false },
    orgs: [],
  });
  (api.fetchDevices as jest.Mock).mockResolvedValue({
    devices: [{ id: "RF8M40H8RFP", label: "Pixel 7 (desk)", model: "Pixel 7", isActive: true, state: "device" }],
    runnerVersion: "0.1.25",
    artifactBytes: 0,
  });
});

test("shows the label of the device that ran the job", async () => {
  (useJobEventsModule.useJobEvents as jest.Mock).mockReturnValue({
    detail: { ...detail, job: { ...detail.job, deviceId: "RF8M40H8RFP" } },
    status: "live",
  });
  render(<JobPage />);
  await waitFor(() => expect(screen.getByTestId("job-device")).toHaveTextContent("Pixel 7 (desk)"));
});

test('shows required device tags and explains unmatched queued jobs', async () => {
  (useJobEventsModule.useJobEvents as jest.Mock).mockReturnValue({
    detail: {...detail, job: {...detail.job, status:'queued', error:null,
      requiredDeviceTags:['tablet','camera'], waitingReason:'NO_MATCHING_DEVICE'}}, status:'live',
  });
  render(<JobPage />);
  expect(await screen.findByText('tablet, camera')).toBeInTheDocument();
  expect(screen.getByText('No enrolled device has all the required tags.')).toBeInTheDocument();
});

test("falls back to the raw serial when the device label fetch fails", async () => {
  // jobs.device_id is ON DELETE SET NULL, so a device removed from the pool
  // can never produce this case - its jobs would carry a null deviceId and
  // render the em dash instead. The raw-id fallback is reachable only when
  // useDeviceLabels' fetch itself fails, leaving the label map empty even
  // for a device that is still registered.
  (api.fetchDevices as jest.Mock).mockRejectedValue(new Error("network error"));
  (useJobEventsModule.useJobEvents as jest.Mock).mockReturnValue({
    detail: { ...detail, job: { ...detail.job, deviceId: "RF8M40H8RFP" } },
    status: "live",
  });
  render(<JobPage />);
  await waitFor(() => expect(screen.getByTestId("job-device")).toHaveTextContent("RF8M40H8RFP"));
});

test("explains when a finished job has no recorded device", async () => {
  (useJobEventsModule.useJobEvents as jest.Mock).mockReturnValue({ detail, status: "live" });
  render(<JobPage />);
  expect(await screen.findByTestId("job-device")).toHaveTextContent("Not recorded");
});

test("reads the job id from the URL path and requests its events", async () => {
  const mockUseJobEvents = useJobEventsModule.useJobEvents as jest.Mock;
  mockUseJobEvents.mockReturnValue({ detail: undefined, status: "connecting" });
  render(<JobPage />);
  // useJobEvents(jobId) is called with a single argument - no deps object -
  // per the interface note in Task 4: passing a fresh inline literal as a
  // second argument on every render would retrigger the hook's internal
  // effect, since that object would never be referentially equal across
  // renders.
  expect(mockUseJobEvents).toHaveBeenCalledWith("job-abc");
  await waitFor(() => expect(api.fetchSession).toHaveBeenCalled());
});

test("renders the job id, status, and step timeline once live", async () => {
  (useJobEventsModule.useJobEvents as jest.Mock).mockReturnValue({ detail, status: "live" });
  render(<JobPage />);
  expect(await screen.findByText("job-abc")).toBeInTheDocument();
  // The overall outcome is a heading; individual flow states remain badges.
  expect(screen.getByRole("heading", { name: "Job failed" })).toBeInTheDocument();
  expect(screen.getAllByText("Failed")).toHaveLength(1);
  expect(screen.getByText("map/map")).toBeInTheDocument();
  expect(screen.getByText("some failure reason")).toBeInTheDocument();
});

test("shows a reconnecting indicator without discarding the last known state", async () => {
  (useJobEventsModule.useJobEvents as jest.Mock).mockReturnValue({ detail, status: "reconnecting" });
  render(<JobPage />);
  expect(await screen.findByText(/reconnecting/i)).toBeInTheDocument();
  expect(screen.getByText("map/map")).toBeInTheDocument();
});

test("shows a not-found state distinctly", async () => {
  (useJobEventsModule.useJobEvents as jest.Mock).mockReturnValue({ detail: undefined, status: "not-found" });
  render(<JobPage />);
  expect(await screen.findByText(/job not found/i)).toBeInTheDocument();
});

test("redirects to /login instead of rendering when the session is invalid", async () => {
  (useJobEventsModule.useJobEvents as jest.Mock).mockReturnValue({ detail: undefined, status: "connecting" });
  (api.fetchSession as jest.Mock).mockRejectedValue(new api.ApiError(401, "missing bearer token"));

  render(<JobPage />);

  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/login"));
});

test("job page shows isolation only when not disabled", async () => {
  (useJobEventsModule.useJobEvents as jest.Mock).mockReturnValue({
    detail: { ...detail, job: { ...detail.job, isolation: "per-flow" } }, status: "live",
  });
  const { unmount } = render(<JobPage />);
  expect(await screen.findByText("Isolation")).toBeInTheDocument();
  expect(screen.getByText("per-flow")).toBeInTheDocument();
  const link = screen.getByRole("link", { name: /what this costs/i });
  expect(link).toHaveAttribute("href", expect.stringContaining("docs/guide/isolation.md"));
  unmount();

  (useJobEventsModule.useJobEvents as jest.Mock).mockReturnValue({
    detail: { ...detail, job: { ...detail.job, isolation: "disabled" } }, status: "live",
  });
  render(<JobPage />);
  await screen.findByText("Job ID");
  expect(screen.queryByText("Isolation")).not.toBeInTheDocument();
});
