import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import LoginPage from "../../src/app/login/page";
import { ApiError } from "../../src/lib/api";
import { navigate } from "../../src/lib/navigate";

jest.mock("../../src/lib/navigate");
jest.mock("../../src/lib/api", () => ({
  ...jest.requireActual("../../src/lib/api"),
  login: jest.fn(),
}));

import { login as mockLogin } from "../../src/lib/api";

beforeEach(() => {
  jest.clearAllMocks();
});

test("submitting username+password calls login and redirects home on success", async () => {
  (mockLogin as jest.Mock).mockResolvedValue({ user: { id: 1, username: "nicolas", email: "n@x.com", isAdmin: false }, orgs: [] });

  render(<LoginPage />);
  fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "nicolas" } });
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "secret" } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

  await waitFor(() => expect(mockLogin as jest.Mock).toHaveBeenCalledWith("nicolas", "secret"));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/"));
});

test("shows an error message when credentials are rejected", async () => {
  (mockLogin as jest.Mock).mockRejectedValue(new ApiError(403, "invalid username or password"));

  render(<LoginPage />);
  fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "nicolas" } });
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "wrong" } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

  expect(await screen.findByText(/username or password was not accepted/i)).toBeInTheDocument();
});

test("the submit button is disabled until both fields are filled", () => {
  render(<LoginPage />);
  expect(screen.getByRole("button", { name: /sign in/i })).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "nicolas" } });
  expect(screen.getByRole("button", { name: /sign in/i })).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "secret" } });
  expect(screen.getByRole("button", { name: /sign in/i })).not.toBeDisabled();
});
