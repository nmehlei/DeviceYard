import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AdminOrgsCard } from "../../src/components/AdminOrgsCard";
import * as api from "../../src/lib/api";

jest.mock("../../src/lib/api", () => ({
  ...jest.requireActual("../../src/lib/api"),
  adminListOrgs: jest.fn(),
  adminCreateOrg: jest.fn(),
  adminRenameOrg: jest.fn(),
  adminArchiveOrg: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  (api.adminListOrgs as jest.Mock).mockResolvedValue([{ id: 1, name: "donable", archivedAt: null, createdAt: 0 }]);
});

test("renders the org list", async () => {
  render(<AdminOrgsCard />);
  expect(await screen.findByText("donable")).toBeInTheDocument();
});

test("creating an org calls adminCreateOrg and reloads", async () => {
  (api.adminCreateOrg as jest.Mock).mockResolvedValue({ id: 2, name: "acme", archivedAt: null, createdAt: 0 });
  render(<AdminOrgsCard />);
  await screen.findByText("donable");

  fireEvent.click(screen.getByRole("button", { name: /create org/i }));
  fireEvent.change(screen.getByPlaceholderText(/new org name/i), { target: { value: "acme" } });
  fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);

  await waitFor(() => expect(api.adminCreateOrg).toHaveBeenCalledWith("acme"));
});

test("archiving an org calls adminArchiveOrg and reloads", async () => {
  (api.adminArchiveOrg as jest.Mock).mockResolvedValue(undefined);
  render(<AdminOrgsCard />);
  await screen.findByText("donable");

  fireEvent.click(screen.getByRole("button", { name: /archive/i }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("dialog").querySelector(".ui-primary")!);

  await waitFor(() => expect(api.adminArchiveOrg).toHaveBeenCalledWith(1));
});
