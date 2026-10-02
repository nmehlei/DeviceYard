import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "../../src/components/StatusBadge";

test.each([
  ["passed", "Passed"],
  ["failed", "Failed"],
  ["running", "Running"],
  ["queued", "Queued"],
  ["skipped", "Skipped"],
  ["done", "Done"],
])("renders readable label for status %s", (status, label) => {
  render(<StatusBadge status={status as never} />);
  expect(screen.getByText(label)).toBeInTheDocument();
});
