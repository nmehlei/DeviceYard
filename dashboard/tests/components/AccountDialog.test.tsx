import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { AccountDialog } from "../../src/components/AccountDialog";
import * as api from "../../src/lib/api";

jest.mock("../../src/lib/api", () => ({
  ...jest.requireActual("../../src/lib/api"),
  changePassword: jest.fn(),
}));

// jsdom does not implement HTMLDialogElement's modal behavior
// (showModal/close/the "close" event) as of jsdom 26 - see jsdom/jsdom#3294.
// Polyfilled here, matching real <dialog> semantics closely enough for
// these tests: showModal sets the open attribute, close removes it and
// fires the "close" event the component's onClose prop listens for.
beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  // AccountDialog now also renders PersonalTokensCard, which fetches
  // /api/me/tokens via the real global fetch (not the mocked api.ts module)
  // whenever `open` is true (I5 gates it on that, not on mount) - stubbed
  // here so these dialog-shell tests don't depend on a live server.
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ tokens: [] }),
  })) as unknown as typeof fetch;
});

test("shows the change-password form when open", () => {
  render(<AccountDialog open={true} onClose={jest.fn()} />);
  expect(screen.getByRole("heading", { name: /^password$/i })).toBeInTheDocument();
});

test("has its own Account settings heading, so the NavBar item that opens it can name what's inside", () => {
  render(<AccountDialog open={true} onClose={jest.fn()} />);
  expect(screen.getByRole("heading", { name: /account settings/i })).toBeInTheDocument();
});

test("is not visible (as a modal) when closed", () => {
  render(<AccountDialog open={false} onClose={jest.fn()} />);
  // jsdom's HTMLDialogElement reflects .open as an attribute - closed means
  // showModal() was never called (or close() undid it).
  expect(document.querySelector("dialog")?.hasAttribute("open")).toBe(false);
});

test("clicking the close button calls onClose", () => {
  const onClose = jest.fn();
  render(<AccountDialog open={true} onClose={onClose} />);
  fireEvent.click(screen.getByRole("button", { name: /close/i }));
  expect(onClose).toHaveBeenCalled();
});

// jsdom doesn't apply real CSS layout, so it can't catch the actual bug this
// guards (Tailwind's preflight resets margin to 0 on every element, which
// silently wins over the UA stylesheet's dialog:modal { margin: auto },
// pinning the dialog to the top-left instead of centering it - confirmed via
// getComputedStyle in a real browser). This just pins the class so a future
// refactor doesn't casually drop it as "seems redundant."
test("has m-auto - load-bearing for centering, not decorative (see component comment)", () => {
  render(<AccountDialog open={true} onClose={jest.fn()} />);
  expect(document.querySelector("dialog")).toHaveClass("m-auto");
});
