import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { AppearanceSwitcher } from "../../src/components/AppearanceSwitcher";
test("switching appearance updates the page and persists the preference", () => {
  render(<AppearanceSwitcher />);
  fireEvent.click(screen.getByRole("button", { name: "Light" }));
  expect(document.documentElement).toHaveAttribute("data-theme", "light");
  expect(localStorage.getItem("deviceyard-appearance")).toBe("light");
  fireEvent.click(screen.getByRole("button", { name: "System" }));
  expect(document.documentElement).toHaveAttribute("data-theme", "system");
});
