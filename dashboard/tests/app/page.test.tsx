import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import LandingPage from "../../src/app/page";
import * as api from "../../src/lib/api";
import { navigate } from "../../src/lib/navigate";

jest.mock("../../src/lib/navigate");
jest.mock("../../src/lib/api", () => ({
  ...jest.requireActual("../../src/lib/api"),
  fetchJobs: jest.fn(),
  fetchSession: jest.fn(),
  fetchDevices: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  (api.fetchSession as jest.Mock).mockResolvedValue({
    user: { id: 1, username: "n", email: "n@x.com", isAdmin: false },
    orgs: [],
  });
  (api.fetchJobs as jest.Mock).mockResolvedValue([]);
  (api.fetchDevices as jest.Mock).mockResolvedValue({ devices: [], runnerVersion: "1.0.0", artifactBytes: 0 });
});

test("shows the approved Overview heading", async () => {
  render(<LandingPage />);
  expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
});

test("links to the full job history at /history", async () => {
  render(<LandingPage />);
  const link = await screen.findByRole("link", { name: /view all jobs/i });
  expect(link).toHaveAttribute("href", "/history");
});

test("renders the recent-jobs chart once jobs load", async () => {
  (api.fetchJobs as jest.Mock).mockResolvedValue([
    { id: "job-abc", org: "donable", status: "done", error: null, createdAt: 0, startedAt: 0, finishedAt: 1000, flowCount: 1, passed: 1, failed: 0, running: 0 },
  ]);
  const { container } = render(<LandingPage />);
  await waitFor(() => expect(container.querySelector(".recent-run-chart")).toBeInTheDocument());
});

test("summarises the latest jobs and links recent activity to job details", async () => {
  (api.fetchJobs as jest.Mock).mockResolvedValue([
    { id: "job-running", org: "donable", status: "running", error: null, createdAt: Date.now(), startedAt: Date.now(), finishedAt: null, deviceId: "dev-1", flowCount: 1, passed: 0, failed: 0, running: 1 },
    { id: "job-failed", org: "donable", status: "failed", error: "failed", createdAt: Date.now(), startedAt: Date.now(), finishedAt: Date.now(), deviceId: null, flowCount: 1, passed: 0, failed: 1, running: 0 },
  ]);
  (api.fetchDevices as jest.Mock).mockResolvedValue({ devices: [{ id: "dev-1", label: "Pixel desk", model: "Pixel", isActive: true, state: "device" }], runnerVersion: "1.0.0", artifactBytes: 0 });

  render(<LandingPage />);

  expect(await screen.findByRole("region", { name: "Status of latest 2 jobs" })).toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: /job-running/i })[0]).toHaveAttribute("href", "/jobs/job-running");
  expect((await screen.findAllByText("Pixel desk")).length).toBeGreaterThan(0);
  expect(screen.getByText(/Not recorded · 0\/1 flows passed/)).toBeInTheDocument();
});

test("offers useful setup actions when there are no jobs", async () => {
  render(<LandingPage />);
  expect(await screen.findByRole("link", { name: /manage devices/i })).toHaveAttribute("href", "/devices");
  expect(screen.getByRole("link", { name: /set up the cli/i })).toHaveAttribute("href", "/cli");
});

test("redirects to /login instead of rendering when the session is invalid", async () => {
  (api.fetchSession as jest.Mock).mockRejectedValue(new api.ApiError(401, "missing bearer token"));
  render(<LandingPage />);
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/login"));
});
