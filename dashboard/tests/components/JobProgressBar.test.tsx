import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { JobProgressBar } from "../../src/components/JobProgressBar";

test("renders passed/failed/running counts against total", () => {
  render(<JobProgressBar passed={3} failed={1} running={1} total={5} />);
  expect(screen.getByText("3 passed")).toBeInTheDocument();
  expect(screen.getByText("1 failed")).toBeInTheDocument();
  expect(screen.getByText("1 running")).toBeInTheDocument();
});

test("omits a count entirely when it is zero", () => {
  render(<JobProgressBar passed={5} failed={0} running={0} total={5} />);
  expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
  expect(screen.queryByText(/running/)).not.toBeInTheDocument();
});
