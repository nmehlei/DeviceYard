import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import AboutPage from "../../src/app/about/page";
import * as api from "../../src/lib/api";
import { navigate } from "../../src/lib/navigate";

jest.mock("../../src/lib/navigate");
jest.mock("../../src/lib/api", () => ({
  ...jest.requireActual("../../src/lib/api"),
  fetchSession: jest.fn(),
  fetchVersion: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  (api.fetchSession as jest.Mock).mockResolvedValue({
    user: { id: 1, username: "n", email: "n@x.com", isAdmin: false },
    orgs: [],
  });
});

test("shows the runner and Maestro versions once loaded", async () => {
  (api.fetchVersion as jest.Mock).mockResolvedValue({ version: "1.4.2", maestroVersion: "Maestro CLI v2.6.1" });
  render(<AboutPage />);
  expect(await screen.findByText("1.4.2")).toBeInTheDocument();
  expect(screen.getByText("Maestro CLI v2.6.1")).toBeInTheDocument();
});

test("shows the application version while Maestro is still starting", async () => {
  (api.fetchVersion as jest.Mock).mockResolvedValue({ version: "1.4.2", maestroVersion: "unknown", maestroPending: true });
  const { unmount } = render(<AboutPage />);
  expect(await screen.findByText("1.4.2")).toBeInTheDocument();
  expect(screen.getByText("Checking installed version…")).toBeInTheDocument();
  expect(screen.queryByText("unknown")).not.toBeInTheDocument();
  unmount();
});

test("shows \"unknown\" for both if fetching the version fails", async () => {
  (api.fetchVersion as jest.Mock).mockRejectedValue(new Error("network error"));
  render(<AboutPage />);
  expect(await screen.findAllByText("unknown")).toHaveLength(2);
});

test("redirects to /login when the session is invalid", async () => {
  (api.fetchSession as jest.Mock).mockRejectedValue(new api.ApiError(401, "missing bearer token"));
  render(<AboutPage />);
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/login"));
});
