import { shutdownHandlers } from "../../src/index";

test("shutdown closes the server, stops notifications, then flushes telemetry", async () => {
  const order: string[] = [];
  const shutdown = shutdownHandlers({
    closeServer: async () => {
      order.push("server");
    },
    stopNotifications: () => {
      order.push("notifications");
    },
    session: {
      shutdown: async () => {
        order.push("telemetry");
      },
    },
  });

  await shutdown();

  expect(order).toEqual(["server", "notifications", "telemetry"]);
});

/** bootstrap wires stopScheduler into this handler for a reason: without this
 * test, a `stopScheduler: () => {}` stub would satisfy every other assertion
 * here. This pins that shutdownHandlers actually calls the scheduler stop it
 * was given, not merely accepts one without throwing. */
test("shutdown stops the scheduler", async () => {
  const order: string[] = [];
  const shutdown = shutdownHandlers({
    closeServer: async () => {
      order.push("server");
    },
    stopNotifications: () => {
      order.push("notifications");
    },
    stopScheduler: () => {
      order.push("scheduler");
    },
    session: {
      shutdown: async () => {
        order.push("telemetry");
      },
    },
  });

  await shutdown();

  expect(order).toEqual(["server", "notifications", "scheduler", "telemetry"]);
});

test("shutdown works when telemetry is disabled", async () => {
  const order: string[] = [];
  const shutdown = shutdownHandlers({
    closeServer: async () => {
      order.push("server");
    },
    stopNotifications: () => {
      order.push("notifications");
    },
    session: null,
  });

  await expect(shutdown()).resolves.toBeUndefined();
  expect(order).toEqual(["server", "notifications"]);
});

/** Notifications are not on main yet - the worker arrives with the
 * feat/notifications branch - so the handler must work without one. */
test("shutdown works when there is no notification worker to stop", async () => {
  const order: string[] = [];
  const shutdown = shutdownHandlers({
    closeServer: async () => {
      order.push("server");
    },
    session: {
      shutdown: async () => {
        order.push("telemetry");
      },
    },
  });

  await shutdown();

  expect(order).toEqual(["server", "telemetry"]);
});

test("a hung telemetry flush cannot hold the process open", async () => {
  const shutdown = shutdownHandlers({
    closeServer: async () => {},
    session: { shutdown: () => new Promise<void>(() => {}) },
    timeoutMs: 50,
  });

  await expect(shutdown()).resolves.toBeUndefined();
});

test("a throwing notification stop does not prevent the telemetry flush", async () => {
  let flushed = false;
  const shutdown = shutdownHandlers({
    closeServer: async () => {},
    stopNotifications: () => {
      throw new Error("boom");
    },
    session: {
      shutdown: async () => {
        flushed = true;
      },
    },
  });

  await shutdown();
  expect(flushed).toBe(true);
});

test("a throwing server close does not prevent the telemetry flush", async () => {
  let flushed = false;
  const shutdown = shutdownHandlers({
    closeServer: async () => {
      throw new Error("boom");
    },
    session: {
      shutdown: async () => {
        flushed = true;
      },
    },
  });

  await shutdown();
  expect(flushed).toBe(true);
});
