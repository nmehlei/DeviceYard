import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ChangePasswordCard } from "../../src/components/ChangePasswordCard";
import * as api from "../../src/lib/api";

jest.mock("../../src/lib/api", () => ({
  ...jest.requireActual("../../src/lib/api"),
  changePassword: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

function fillForm(current: string, next: string) {
  fireEvent.click(screen.getByRole("button", { name: /change password/i }));
  fireEvent.change(screen.getByLabelText(/current password/i), { target: { value: current } });
  fireEvent.change(screen.getByLabelText(/new password/i), { target: { value: next } });
}

test("submitting valid passwords calls changePassword and shows a success message", async () => {
  (api.changePassword as jest.Mock).mockResolvedValue(undefined);
  render(<ChangePasswordCard />);

  fillForm("old-password", "new-password-123");
  fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);

  await waitFor(() => expect(api.changePassword).toHaveBeenCalledWith("old-password", "new-password-123"));
  expect(await screen.findByText(/password changed/i)).toBeInTheDocument();
});

test("clears both fields after a successful change - a stale current password must not linger in the form", async () => {
  (api.changePassword as jest.Mock).mockResolvedValue(undefined);
  render(<ChangePasswordCard />);

  fillForm("old-password", "new-password-123");
  fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);

  await screen.findByText(/password changed/i);
  fireEvent.click(screen.getByRole("button", { name: /change password/i }));
  expect(screen.getByLabelText(/current password/i)).toHaveValue("");
  expect(screen.getByLabelText(/new password/i)).toHaveValue("");
});

test("a rejected current password surfaces the server's specific error message", async () => {
  (api.changePassword as jest.Mock).mockRejectedValue(new api.ApiError(403, "current password is incorrect"));
  render(<ChangePasswordCard />);

  fillForm("wrong-password", "new-password-123");
  fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);

  expect(await screen.findByText("current password is incorrect")).toBeInTheDocument();
  expect(api.changePassword).toHaveBeenCalled();
});

test("a too-short new password is rejected client-side, without calling the API", async () => {
  render(<ChangePasswordCard />);

  fillForm("old-password", "short");
  fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);

  expect(await screen.findByText(/at least 8 characters/i)).toBeInTheDocument();
  expect(api.changePassword).not.toHaveBeenCalled();
});

test("an empty current password is rejected client-side, without calling the API", async () => {
  render(<ChangePasswordCard />);

  fillForm("", "new-password-123");
  fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);

  expect(await screen.findByText(/current password and a new password/i)).toBeInTheDocument();
  expect(api.changePassword).not.toHaveBeenCalled();
});
