import "@testing-library/jest-dom";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import AdminPage from "../../src/app/admin/page";
import * as api from "../../src/lib/api";
import { navigate } from "../../src/lib/navigate";

jest.mock("../../src/lib/navigate");
jest.mock("../../src/lib/api", () => ({
  ...jest.requireActual("../../src/lib/api"),
  fetchSession: jest.fn(),
  adminListOrgs: jest.fn(),
  adminListUsers: jest.fn(),
  fetchRetentionSettings: jest.fn(),
  fetchUploadSettings: jest.fn().mockResolvedValue({ maxUploadBytes: null }),
  fetchSchedulerSettings: jest.fn().mockResolvedValue({ maxConcurrentJobs: null }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  (api.adminListOrgs as jest.Mock).mockResolvedValue([]);
  (api.adminListUsers as jest.Mock).mockResolvedValue([]);
  (api.fetchRetentionSettings as jest.Mock).mockResolvedValue({
    maxAgeDays: null,
    maxTotalBytes: null,
    maxJobs: null,
    totalArtifactBytes: 0,
  });
});

test("renders the Orgs tab by default, with a Create org control", async () => {
  (api.fetchSession as jest.Mock).mockResolvedValue({
    user: { id: 1, username: "admin", email: "a@x.com", isAdmin: true },
    orgs: [],
  });
  render(<AdminPage />);
  expect(await screen.findByRole("button", { name: /create org/i })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /create user/i })).not.toBeInTheDocument();
});

test("switching to the Users tab shows the Users card and hides Orgs", async () => {
  (api.fetchSession as jest.Mock).mockResolvedValue({
    user: { id: 1, username: "admin", email: "a@x.com", isAdmin: true },
    orgs: [],
  });
  render(<AdminPage />);
  await screen.findByRole("button", { name: /create org/i });

  fireEvent.click(screen.getByRole("tab", { name: /^users$/i }));

  expect(await screen.findByRole("button", { name: /create user/i })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /create org/i })).not.toBeInTheDocument();
});

test("redirects home instead of rendering for a non-admin", async () => {
  (api.fetchSession as jest.Mock).mockResolvedValue({
    user: { id: 2, username: "regular", email: "r@x.com", isAdmin: false },
    orgs: [],
  });
  render(<AdminPage />);
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/"));
});

test("redirects to /login when the session is invalid", async () => {
  (api.fetchSession as jest.Mock).mockRejectedValue(new api.ApiError(401, "missing bearer token"));
  render(<AdminPage />);
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/login"));
});

test("shows a Retention tab that renders RetentionCard when selected", async () => {
  (api.fetchSession as jest.Mock).mockResolvedValue({
    user: { id: 1, username: "admin", email: "a@x.com", isAdmin: true },
    orgs: [],
  });
  render(<AdminPage />);
  const tab = await screen.findByRole("button", { name: /execution & storage/i });
  fireEvent.click(tab);
  expect(await screen.findByText(/max age/i)).toBeInTheDocument();
});

test("redirects to /login, not /, when the session expires between the two fetchSession calls", async () => {
  // useRequireSession's own fetchSession() succeeds (so it moves on to "ok"
  // and never calls navigate itself), but the page's second fetchSession()
  // call - the one that reads user.isAdmin - then rejects with a 401. That
  // must still route to /login, not be conflated with "logged in but not an
  // admin" (which routes to /).
  (api.fetchSession as jest.Mock)
    .mockResolvedValueOnce({
      user: { id: 1, username: "admin", email: "a@x.com", isAdmin: true },
      orgs: [],
    })
    .mockRejectedValueOnce(new api.ApiError(401, "missing bearer token"));
  render(<AdminPage />);
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/login"));
  expect(navigate).not.toHaveBeenCalledWith("/");
});
