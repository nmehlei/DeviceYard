import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import McpSetupPage from "../../src/app/mcp-setup/page";
import * as api from "../../src/lib/api";
import { navigate } from "../../src/lib/navigate";

jest.mock("../../src/lib/navigate");
jest.mock("../../src/lib/api", () => ({
  ...jest.requireActual("../../src/lib/api"),
  fetchSession: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
});

test("substitutes the real farm URL into the download and config snippets", async () => {
  (api.fetchSession as jest.Mock).mockResolvedValue({
    user: { id: 1, username: "n", email: "n@x.com", isAdmin: false },
    orgs: [{ id: 1, name: "donable", archivedAt: null, createdAt: 0 }],
  });
  render(<McpSetupPage />);
  const configBlock = await screen.findByLabelText(/copy claude code mcp config/i);
  expect(configBlock.parentElement).toHaveTextContent(window.location.origin);
});

test("substitutes the sole org's id and name once the session loads", async () => {
  (api.fetchSession as jest.Mock).mockResolvedValue({
    user: { id: 1, username: "n", email: "n@x.com", isAdmin: false },
    orgs: [{ id: 42, name: "donable", archivedAt: null, createdAt: 0 }],
  });
  render(<McpSetupPage />);
  const downloadBlock = await screen.findByLabelText(/copy download commands/i);
  await waitFor(() => expect(downloadBlock.parentElement).toHaveTextContent("X-Org-Id: 42"));

  const configBlock = await screen.findByLabelText(/copy claude code mcp config/i);
  await waitFor(() => expect(configBlock.parentElement).toHaveTextContent("donable"));
});

test("shows an org picker only when the user belongs to more than one org", async () => {
  (api.fetchSession as jest.Mock).mockResolvedValue({
    user: { id: 1, username: "n", email: "n@x.com", isAdmin: false },
    orgs: [
      { id: 1, name: "donable", archivedAt: null, createdAt: 0 },
      { id: 2, name: "momentum", archivedAt: null, createdAt: 0 },
    ],
  });
  render(<McpSetupPage />);
  expect(await screen.findByLabelText(/^org$/i)).toBeInTheDocument();
});

test("does not show an org picker for a single-org user", async () => {
  (api.fetchSession as jest.Mock).mockResolvedValue({
    user: { id: 1, username: "n", email: "n@x.com", isAdmin: false },
    orgs: [{ id: 1, name: "donable", archivedAt: null, createdAt: 0 }],
  });
  render(<McpSetupPage />);
  await screen.findByLabelText(/copy download commands/i);
  expect(screen.queryByLabelText(/^org$/i)).not.toBeInTheDocument();
});

test("falls back to placeholders when the user belongs to no org", async () => {
  (api.fetchSession as jest.Mock).mockResolvedValue({
    user: { id: 1, username: "n", email: "n@x.com", isAdmin: false },
    orgs: [],
  });
  render(<McpSetupPage />);
  const downloadBlock = await screen.findByLabelText(/copy download commands/i);
  expect(downloadBlock.parentElement).toHaveTextContent("X-Org-Id: <org-id>");
});

test("redirects to /login when the session is invalid", async () => {
  (api.fetchSession as jest.Mock).mockRejectedValue(new api.ApiError(401, "missing bearer token"));
  render(<McpSetupPage />);
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/login"));
});
