import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { OrgTokensCard } from "../../src/components/OrgTokensCard";
import * as api from "../../src/lib/api";

jest.mock("../../src/lib/api", () => ({
  ...jest.requireActual("../../src/lib/api"),
  fetchOrgTokens: jest.fn(),
  createOrgToken: jest.fn(),
  revokeOrgToken: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  (api.fetchOrgTokens as jest.Mock).mockResolvedValue([
    { id: 1, orgId: 5, label: "CI", value: "raw-token-value", createdAt: 0, createdByUserId: null },
  ]);
});

test("renders a token masked by default, revealing it on click", async () => {
  render(<OrgTokensCard orgId={5} />);
  await screen.findByText("CI");
  expect(screen.queryByText("raw-token-value")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /show/i }));
  expect(screen.getByText("raw-token-value")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /hide/i }));
  expect(screen.queryByText("raw-token-value")).not.toBeInTheDocument();
});

test("creating a token calls createOrgToken with the label and reloads", async () => {
  (api.createOrgToken as jest.Mock).mockResolvedValue({ id: 2, orgId: 5, label: "local testing", value: "x", createdAt: 0, createdByUserId: null });
  render(<OrgTokensCard orgId={5} />);
  await screen.findByText("CI");

  fireEvent.click(screen.getByRole("button", { name: /new token/i }));
  fireEvent.change(screen.getByPlaceholderText(/e\.g\. ci/i), { target: { value: "local testing" } });
  fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);

  await waitFor(() => expect(api.createOrgToken).toHaveBeenCalledWith(5, "local testing"));
});

test("revoking a token calls revokeOrgToken and reloads", async () => {
  (api.revokeOrgToken as jest.Mock).mockResolvedValue(undefined);
  render(<OrgTokensCard orgId={5} />);
  await screen.findByText("CI");

  fireEvent.click(screen.getByRole("button", { name: /revoke/i }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("dialog").querySelector(".ui-primary")!);

  await waitFor(() => expect(api.revokeOrgToken).toHaveBeenCalledWith(5, 1));
});
