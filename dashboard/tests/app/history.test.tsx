import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import JobHistoryPage from "../../src/app/history/page";
import * as api from "../../src/lib/api";
import { navigate } from "../../src/lib/navigate";

jest.mock("../../src/lib/navigate");
// jest.mock + requireActual, not jest.spyOn(api, ...) - see Task 6's brief
// for why named exports of api.ts can't be spied on directly here.
jest.mock("../../src/lib/api", () => ({
  ...jest.requireActual("../../src/lib/api"),
  fetchJobs: jest.fn(),
  fetchSession: jest.fn(),
  fetchDevices: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
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

test("shows which device ran each job and explains a missing assignment", async () => {
  (api.fetchJobs as jest.Mock).mockResolvedValue([
    { id: "job-1", org: "donable", status: "done", error: null, createdAt: 0, startedAt: 0, finishedAt: 1, deviceId: "RF8M40H8RFP", flowCount: 1, passed: 1, failed: 0, running: 0 },
    // A device removed from the pool since the job ran: no label to resolve.
    { id: "job-2", org: "donable", status: "done", error: null, createdAt: 0, startedAt: 0, finishedAt: 1, deviceId: "retired-9", flowCount: 1, passed: 1, failed: 0, running: 0 },
    // Still queued, so no device has claimed it.
    { id: "job-3", org: "donable", status: "queued", error: null, createdAt: 0, startedAt: null, finishedAt: null, deviceId: null, flowCount: 1, passed: 0, failed: 0, running: 0 },
  ]);

  render(<JobHistoryPage />);

  await screen.findByText("job-1");
  await waitFor(() =>
    expect(screen.getAllByTestId("job-device").map((c) => c.textContent)).toEqual([
      "Pixel 7 (desk)",
      "retired-9",
      "Waiting for device",
    ])
  );
});

test("renders a row per job with id, status, and progress", async () => {
  (api.fetchJobs as jest.Mock).mockResolvedValue([
    { id: "job-abc", org: "donable", status: "done", error: null, createdAt: 0, startedAt: 0, finishedAt: 1, flowCount: 3, passed: 2, failed: 1, running: 0 },
  ]);

  render(<JobHistoryPage />);

  expect(await screen.findByText("job-abc")).toBeInTheDocument();
  expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
  expect(screen.getByText("2/3 passed")).toBeInTheDocument();
  expect(screen.getAllByText(/· 1 failed/).length).toBeGreaterThan(0);
});

test("shows the app id and version when the job has them", async () => {
  (api.fetchJobs as jest.Mock).mockResolvedValue([
    { id: "job-abc", org: "donable", status: "done", error: null, createdAt: 0, startedAt: 0, finishedAt: 1, flowCount: 1, passed: 1, failed: 0, running: 0, appId: "com.example.app", appVersion: "2.4.1 (240)" },
  ]);

  render(<JobHistoryPage />);

  expect(await screen.findByText("com.example.app")).toBeInTheDocument();
  expect(screen.getByText("2.4.1 (240)")).toBeInTheDocument();
});

test("shows a placeholder when the job has no app id", async () => {
  (api.fetchJobs as jest.Mock).mockResolvedValue([
    { id: "job-abc", org: "donable", status: "done", error: null, createdAt: 0, startedAt: 0, finishedAt: 1, flowCount: 1, passed: 1, failed: 0, running: 0, appId: null, appVersion: null },
  ]);

  render(<JobHistoryPage />);

  await screen.findByText("job-abc");
  expect(screen.getByText("—")).toBeInTheDocument();
});

test("shows the created time in relative human format, with the exact timestamp as a tooltip", async () => {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  (api.fetchJobs as jest.Mock).mockResolvedValue([
    { id: "job-abc", org: "donable", status: "done", error: null, createdAt: twoHoursAgo, startedAt: twoHoursAgo, finishedAt: twoHoursAgo, flowCount: 1, passed: 1, failed: 0, running: 0 },
  ]);

  render(<JobHistoryPage />);

  const cell = await screen.findByText("2 hours ago");
  expect(cell).toHaveAttribute("title", new Date(twoHoursAgo).toLocaleString());
});

test("each row links to /jobs/<id>", async () => {
  (api.fetchJobs as jest.Mock).mockResolvedValue([
    { id: "job-abc", org: "donable", status: "done", error: null, createdAt: 0, startedAt: 0, finishedAt: 1, flowCount: 1, passed: 1, failed: 0, running: 0 },
  ]);

  render(<JobHistoryPage />);

  const link = await screen.findByRole("link", { name: /job-abc/i });
  expect(link).toHaveAttribute("href", "/jobs/job-abc");
});

test("shows an empty state when there are no jobs yet", async () => {
  (api.fetchJobs as jest.Mock).mockResolvedValue([]);
  render(<JobHistoryPage />);
  expect(await screen.findByText(/no jobs yet/i)).toBeInTheDocument();
});

test("shows a loading state, not the empty state, before the first poll resolves", async () => {
  const resolvers: Array<(value: unknown[]) => void> = [];
  (api.fetchJobs as jest.Mock).mockImplementation(
    () => new Promise((resolve) => { resolvers.push(resolve); })
  );

  render(<JobHistoryPage />);

  expect(screen.getByRole("status", { name: /loading/i })).toBeInTheDocument();
  expect(screen.queryByText(/no jobs yet/i)).not.toBeInTheDocument();

  resolvers.forEach((resolve) => resolve([]));
  expect(await screen.findByText(/no jobs yet/i)).toBeInTheDocument();
});

test("redirects to /login instead of rendering when the session is invalid", async () => {
  (api.fetchSession as jest.Mock).mockRejectedValue(new api.ApiError(401, "missing bearer token"));

  render(<JobHistoryPage />);

  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/login"));
});
