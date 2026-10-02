import "@testing-library/jest-dom";
import { render } from "@testing-library/react";
import { Skeleton } from "../../src/components/Skeleton";

test("renders a pulsing placeholder block, hidden from screen readers", () => {
  const { container } = render(<Skeleton className="h-4 w-20" />);
  const el = container.firstChild as HTMLElement;
  expect(el).toHaveClass("h-4");
  expect(el).toHaveClass("w-20");
  expect(el).toHaveAttribute("aria-hidden", "true");
});
