import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { OrgSwitcher } from "../../src/components/OrgSwitcher";
import { navigate } from "../../src/lib/navigate";
import { setActiveOrgId, getActiveOrgId } from "../../src/lib/activeOrg";
import type { Org } from "../../src/lib/api";

jest.mock("../../src/lib/navigate");

const ORGS: Org[] = [
  { id: 1, name: "donable", archivedAt: null, createdAt: 0 },
  { id: 2, name: "acme", archivedAt: null, createdAt: 0 },
];

beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
});

test("renders nothing when there are no orgs", () => {
  const { container } = render(<OrgSwitcher orgs={[]} />);
  expect(container).toBeEmptyDOMElement();
});

test("shows the active org's name in the pill", () => {
  setActiveOrgId(1);
  render(<OrgSwitcher orgs={ORGS} />);
  expect(screen.getByRole("button", { name: /donable/i })).toBeInTheDocument();
});

test("clicking the pill opens a dropdown listing every org and a settings link for the active one", () => {
  setActiveOrgId(1);
  render(<OrgSwitcher orgs={ORGS} />);
  fireEvent.click(screen.getByRole("button", { name: /donable/i }));

  expect(screen.getByText("acme")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /organization settings/i })).toHaveAttribute("href", "/orgs/1");
});

test("selecting a different org sets it active and navigates to refresh org-scoped data", () => {
  setActiveOrgId(1);
  render(<OrgSwitcher orgs={ORGS} />);
  fireEvent.click(screen.getByRole("button", { name: /donable/i }));
  fireEvent.click(screen.getByText("acme"));

  expect(getActiveOrgId()).toBe(2);
  expect(navigate).toHaveBeenCalledWith("/");
});
