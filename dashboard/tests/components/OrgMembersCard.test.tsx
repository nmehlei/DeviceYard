import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { OrgMembersCard } from "../../src/components/OrgMembersCard";
import * as api from "../../src/lib/api";

jest.mock("../../src/lib/api", () => ({
  ...jest.requireActual("../../src/lib/api"),
  fetchOrgMembers: jest.fn(),
  addOrgMember: jest.fn(),
  removeOrgMember: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  (api.fetchOrgMembers as jest.Mock).mockResolvedValue([{ id: 1, username: "nicolas", email: "n@x.com", isAdmin: false }]);
});

test("renders the member list", async () => {
  render(<OrgMembersCard orgId={5} />);
  expect(await screen.findByText("nicolas")).toBeInTheDocument();
  expect(api.fetchOrgMembers).toHaveBeenCalledWith(5);
});

test("adding a member by id calls addOrgMember and reloads the list", async () => {
  (api.addOrgMember as jest.Mock).mockResolvedValue(undefined);
  render(<OrgMembersCard orgId={5} />);
  await screen.findByText("nicolas");

  fireEvent.click(screen.getByRole("button", { name: /add member/i }));
  fireEvent.change(screen.getByPlaceholderText(/user id/i), { target: { value: "9" } });
  fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);

  await waitFor(() => expect(api.addOrgMember).toHaveBeenCalledWith(5, 9));
  await waitFor(() => expect(api.fetchOrgMembers).toHaveBeenCalledTimes(2));
});

test("removing a member calls removeOrgMember and reloads", async () => {
  (api.removeOrgMember as jest.Mock).mockResolvedValue(undefined);
  render(<OrgMembersCard orgId={5} />);
  await screen.findByText("nicolas");

  fireEvent.click(screen.getByRole("button", { name: /remove/i }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("dialog").querySelector(".ui-primary")!);

  await waitFor(() => expect(api.removeOrgMember).toHaveBeenCalledWith(5, 1));
});
