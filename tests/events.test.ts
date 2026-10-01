import { JobEvents } from "../src/events";

test("subscribers are notified for their job only", () => {
  const events = new JobEvents();
  const mine: string[] = [];
  const theirs: string[] = [];

  events.subscribe("j1", () => mine.push("tick"));
  events.subscribe("j2", () => theirs.push("tick"));

  events.publish("j1");

  expect(mine).toEqual(["tick"]);
  expect(theirs).toEqual([]);
});

test("unsubscribing stops delivery", () => {
  const events = new JobEvents();
  const seen: string[] = [];
  const off = events.subscribe("j1", () => seen.push("tick"));

  events.publish("j1");
  off();
  events.publish("j1");

  expect(seen).toEqual(["tick"]);
});

test("publishing to a job with no subscribers is harmless", () => {
  expect(() => new JobEvents().publish("nobody")).not.toThrow();
});

test("many concurrent subscribers do not trip the default listener warning", () => {
  const events = new JobEvents();
  for (let i = 0; i < 50; i++) events.subscribe("j1", () => undefined);
  expect(() => events.publish("j1")).not.toThrow();
});
