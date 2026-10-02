import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AdminUsersCard } from "../../src/components/AdminUsersCard";
import * as api from "../../src/lib/api";

jest.mock("../../src/lib/api", () => ({
  ...jest.requireActual("../../src/lib/api"),
  adminListUsers: jest.fn(),
  adminCreateUser: jest.fn(),
  adminEditUser: jest.fn(),
  adminDeactivateUser: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  (api.adminListUsers as jest.Mock).mockResolvedValue([{ id: 1, username: "nicolas", email: "n@x.com", isAdmin: false }]);
});

test("renders the user list", async () => {
  render(<AdminUsersCard />);
  expect(await screen.findByText("nicolas")).toBeInTheDocument();
});

test("creating a user calls adminCreateUser with the form values", async () => {
  (api.adminCreateUser as jest.Mock).mockResolvedValue({ id: 2, username: "b", email: "b@x.com", isAdmin: false });
  render(<AdminUsersCard />);
  await screen.findByText("nicolas");

  fireEvent.click(screen.getByRole("button", { name: /create user/i }));
  fireEvent.change(screen.getByPlaceholderText(/^username$/i), { target: { value: "b" } });
  fireEvent.change(screen.getByPlaceholderText(/^email$/i), { target: { value: "b@x.com" } });
  fireEvent.change(screen.getByPlaceholderText(/temporary password/i), { target: { value: "a-real-password" } });
  fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);

  await waitFor(() => expect(api.adminCreateUser).toHaveBeenCalledWith("b", "b@x.com", "a-real-password"));
});

test("toggling admin status calls adminEditUser", async () => {
  (api.adminEditUser as jest.Mock).mockResolvedValue({ id: 1, username: "nicolas", email: "n@x.com", isAdmin: true });
  render(<AdminUsersCard />);
  await screen.findByText("nicolas");

  fireEvent.click(screen.getByRole("button", { name: /make admin/i }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("dialog").querySelector(".ui-primary")!);

  await waitFor(() => expect(api.adminEditUser).toHaveBeenCalledWith(1, { isAdmin: true }));
});

test("deactivating a user calls adminDeactivateUser", async () => {
  (api.adminDeactivateUser as jest.Mock).mockResolvedValue(undefined);
  render(<AdminUsersCard />);
  await screen.findByText("nicolas");

  fireEvent.click(screen.getByRole("button", { name: /deactivate/i }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("dialog").querySelector(".ui-primary")!);

  await waitFor(() => expect(api.adminDeactivateUser).toHaveBeenCalledWith(1));
});

test("resetting a password calls adminEditUser with the new password and clears the input", async () => {
  (api.adminEditUser as jest.Mock).mockResolvedValue({ id: 1, username: "nicolas", email: "n@x.com", isAdmin: false });
  render(<AdminUsersCard />);
  await screen.findByText("nicolas");

  fireEvent.click(screen.getByRole("button", { name: /reset password/i }));
  const input = screen.getByLabelText(/new password for nicolas/i) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "a-new-password" } });
  fireEvent.click(screen.getByRole("dialog").querySelector(".ui-primary")!);

  await waitFor(() => expect(api.adminEditUser).toHaveBeenCalledWith(1, { password: "a-new-password" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

test("resetting a password with too few characters shows an error and does not call adminEditUser", async () => {
  render(<AdminUsersCard />);
  await screen.findByText("nicolas");

  fireEvent.click(screen.getByRole("button", { name: /reset password/i }));
  const input = screen.getByLabelText(/new password for nicolas/i);
  fireEvent.change(input, { target: { value: "short" } });
  fireEvent.click(screen.getByRole("dialog").querySelector(".ui-primary")!);

  expect(await screen.findByRole("alert")).toHaveTextContent(/at least 8 characters/i);
  expect(api.adminEditUser).not.toHaveBeenCalled();
});
