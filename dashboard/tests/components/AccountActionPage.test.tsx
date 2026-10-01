import "@testing-library/jest-dom";
import { StrictMode } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AccountActionPage } from "../../src/components/AccountActionPage";
import { notificationRequest } from "../../src/lib/notifications";
jest.mock("../../src/lib/notifications", () => ({ notificationRequest: jest.fn() }));
jest.mock("../../src/lib/api", () => ({ fetchSession: jest.fn().mockResolvedValue(undefined), login: jest.fn() }));
beforeEach(() => { jest.clearAllMocks(); window.history.replaceState(null, "", "/verify-email#token=synthetic-test-link"); });
test("StrictMode keeps the token in memory after removing fragment; only explicit submit redeems", async () => {
  (notificationRequest as jest.Mock).mockResolvedValue({ kind: "email-verification", existingAccount: true });
  render(<StrictMode><AccountActionPage kind="email-verification" /></StrictMode>);
  const button = await screen.findByRole("button", { name: "Verify email" });
  expect(window.location.hash).toBe("");
  expect(notificationRequest).not.toHaveBeenCalledWith("/api/account/actions/redeem", expect.anything());
  fireEvent.click(button);
  await waitFor(() => expect(notificationRequest).toHaveBeenCalledWith("/api/account/actions/redeem", expect.objectContaining({ token: "synthetic-test-link", kind: "email-verification" })));
  expect(await screen.findByText(/Email verified/)).toBeInTheDocument();
});
