import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { ActionDialog, DialogActions } from "../../src/components/ActionDialog";

test("destructive dialogs focus cancel and only confirm on the explicit action", () => {
  const confirm = jest.fn(); const close = jest.fn();
  render(<ActionDialog open onClose={close} title="Archive organization" target="Example" danger><DialogActions onClose={close} busy={false} danger label="Archive" onConfirm={confirm} /></ActionDialog>);
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  expect(confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Archive" }));
  expect(confirm).toHaveBeenCalledTimes(1);
});

test("busy dialogs block Escape and the close controls", () => {
  const close = jest.fn();
  render(<ActionDialog open busy onClose={close} title="Saving"><DialogActions busy onClose={close} label="Save" /></ActionDialog>);
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Close dialog" })).toBeDisabled();
});
