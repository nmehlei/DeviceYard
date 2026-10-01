import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import OrgSettingsPage from "../../src/app/orgs/page";
import * as api from "../../src/lib/api";
import { navigate } from "../../src/lib/navigate";

jest.mock("../../src/lib/navigate");
jest.mock("../../src/lib/api", () => ({
  ...jest.requireActual("../../src/lib/api"),
  fetchSession: jest.fn(),
  fetchOrgMembers: jest.fn(),
  fetchOrgTokens: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  window.history.pushState({}, "", "/orgs/5");
  (api.fetchSession as jest.Mock).mockResolvedValue({
    user: { id: 1, username: "n", email: "n@x.com", isAdmin: false },
    orgs: [{ id: 5, name: "donable", archivedAt: null, createdAt: 0 }],
  });
  (api.fetchOrgMembers as jest.Mock).mockResolvedValue([]);
  (api.fetchOrgTokens as jest.Mock).mockResolvedValue([]);
});

test("reads the org id from the URL and renders both cards", async () => {
  render(<OrgSettingsPage />);
  await waitFor(() => expect(api.fetchOrgMembers).toHaveBeenCalledWith(5));
  expect(api.fetchOrgTokens).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Access tokens" }));
  await waitFor(() => expect(api.fetchOrgTokens).toHaveBeenCalledWith(5));
});

test("redirects to /login when the session is invalid", async () => {
  (api.fetchSession as jest.Mock).mockRejectedValue(new api.ApiError(401, "missing bearer token"));
  render(<OrgSettingsPage />);
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/login"));
});
