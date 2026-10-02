import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import NotificationsPage from "../../src/app/notifications/page";
import { notificationRequest } from "../../src/lib/notifications";
jest.mock("../../src/lib/useRequireSession", () => ({ useRequireSession: () => "ok" }));
jest.mock("../../src/lib/notifications", () => ({ notificationRequest: jest.fn() }));
const preferences = { email: "alex@example.invalid", verified: true, available: true, isAdmin: false,
  orgs: [{ orgId: 1, orgName: "Example", run: "off" }], deviceHealth: false };
beforeEach(() => {
  jest.clearAllMocks();
  (notificationRequest as jest.Mock).mockImplementation(async (url: string, body?: unknown) => url.includes("templates") ? { subject: "Sample", html: "<p>Sample</p>", text: "Sample" } : body ? { ...preferences, ...body } : preferences);
});
test("future channels are disabled and edits save explicitly; preview is sandboxed", async () => {
  render(<NotificationsPage />);
  expect(await screen.findByText("Example")).toBeInTheDocument();
  expect(screen.getAllByText("Coming later")).toHaveLength(3);
  expect(screen.getByText("Slack")).toHaveTextContent("Coming later");
  const save = screen.getByRole("button", { name: "Save preferences" }); expect(save).toBeDisabled();
  fireEvent.click(screen.getByRole("radio", { name: /Failures only/ }));
  expect(save).toBeEnabled(); expect(notificationRequest).not.toHaveBeenCalledWith("/api/me/notifications", expect.anything(), "PUT");
  fireEvent.click(save);
  await waitFor(() => expect(notificationRequest).toHaveBeenCalledWith("/api/me/notifications", { orgs: [{ orgId: 1, orgName: "Example", run: "failures" }], deviceHealth: false }, "PUT"));
  expect(await screen.findByText("Your notification preferences are saved.")).toBeInTheDocument();
  expect(screen.getByTitle("Sample notification email")).toHaveAttribute("sandbox", "");
});
test("unverified recipients cannot enable optional emails", async () => {
  (notificationRequest as jest.Mock).mockResolvedValue({ ...preferences, verified: false });
  render(<NotificationsPage />);
  expect(await screen.findByRole("button", { name: "Send verification email" })).toBeEnabled();
  expect(screen.getByRole("radio", { name: /Failures only/ })).toBeDisabled();
});
