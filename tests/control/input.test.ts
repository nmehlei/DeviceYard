import { HARDWARE_KEYS, MAX_TEXT_LENGTH, applyInput, parseClientInput } from "../../src/control/input";
import type { InputWriter } from "../../src/control/controlStream";

function recordingWriter() {
  const calls: Array<[string, unknown]> = [];
  const writer: InputWriter = {
    injectTouch: async (m) => { calls.push(["touch", m]); },
    injectKeyCode: async (m) => { calls.push(["key", m]); },
    injectText: async (t) => { calls.push(["text", t]); },
    rotateDevice: async () => { calls.push(["rotate", undefined]); },
  };
  return { writer, calls };
}

const target = (writer: InputWriter) => ({ width: 504, height: 1080, input: writer });

describe("parseClientInput", () => {
  test("accepts a well-formed touch", () => {
    expect(parseClientInput({ type: "touch", action: "down", pointerId: 1, x: 0.5, y: 0.25 }))
      .toEqual({ type: "touch", action: "down", pointerId: 1, x: 0.5, y: 0.25 });
  });

  test.each([
    [{ type: "touch", action: "down", pointerId: 1, x: Number.NaN, y: 0.5 }],
    [{ type: "touch", action: "down", pointerId: 1, x: 0.5 }],
    [{ type: "touch", action: "smash", pointerId: 1, x: 0.5, y: 0.5 }],
    [{ type: "touch", action: "down", pointerId: 1.5, x: 0.5, y: 0.5 }],
    [{ type: "touch", action: "constructor", pointerId: 1, x: 0.5, y: 0.5 }],
    [{ type: "touch", action: "toString", pointerId: 1, x: 0.5, y: 0.5 }],
    [{ type: "key", key: "self-destruct" }],
    [{ type: "text", text: 42 }],
    [{ type: "text", text: "" }],
    [{ type: "launch-missiles" }],
    [null],
    ["touch"],
  ])("rejects %p", (raw) => {
    expect(parseClientInput(raw)).toBeUndefined();
  });

  test("rejects text over the length cap rather than truncating it silently", () => {
    expect(parseClientInput({ type: "text", text: "x".repeat(MAX_TEXT_LENGTH + 1) })).toBeUndefined();
    expect(parseClientInput({ type: "text", text: "x".repeat(MAX_TEXT_LENGTH) })).toBeDefined();
  });
});

describe("applyInput", () => {
  test("maps normalised touch coordinates into video pixels", async () => {
    const { writer, calls } = recordingWriter();
    await applyInput({ type: "touch", action: "down", pointerId: 3, x: 0.5, y: 0.25 }, target(writer));
    expect(calls).toEqual([["touch", {
      action: 0, pointerId: 3n, pointerX: 252, pointerY: 270,
      videoWidth: 504, videoHeight: 1080, pressure: 1, actionButton: 0, buttons: 0,
    }]]);
  });

  test("clamps coordinates outside the screen to its edge", async () => {
    const { writer, calls } = recordingWriter();
    await applyInput({ type: "touch", action: "move", pointerId: 1, x: 1.7, y: -0.3 }, target(writer));
    const m = calls[0][1] as { pointerX: number; pointerY: number; action: number };
    expect([m.pointerX, m.pointerY, m.action]).toEqual([504, 0, 2]);
  });

  test("lifting a finger sends zero pressure", async () => {
    const { writer, calls } = recordingWriter();
    await applyInput({ type: "touch", action: "up", pointerId: 1, x: 0.1, y: 0.1 }, target(writer));
    expect((calls[0][1] as { pressure: number; action: number })).toMatchObject({ pressure: 0, action: 1 });
  });

  test("cancel action sends zero pressure with action code 3, distinct from up", async () => {
    const { writer, calls } = recordingWriter();
    await applyInput({ type: "touch", action: "cancel", pointerId: 1, x: 0.1, y: 0.1 }, target(writer));
    expect((calls[0][1] as { pressure: number; action: number })).toMatchObject({ pressure: 0, action: 3 });
  });

  test("a hardware key is a press AND a release, with the right Android keycode", async () => {
    const { writer, calls } = recordingWriter();
    await applyInput({ type: "key", key: "back" }, target(writer));
    expect(calls).toEqual([
      ["key", { action: 0, keyCode: HARDWARE_KEYS.back, repeat: 0, metaState: 0 }],
      ["key", { action: 1, keyCode: HARDWARE_KEYS.back, repeat: 0, metaState: 0 }],
    ]);
    expect(HARDWARE_KEYS.back).toBe(4);
  });

  test("text goes through text injection, so non-ASCII survives", async () => {
    const { writer, calls } = recordingWriter();
    await applyInput({ type: "text", text: "Grüße" }, target(writer));
    expect(calls).toEqual([["text", "Grüße"]]);
  });

  test("rotate rotates", async () => {
    const { writer, calls } = recordingWriter();
    await applyInput({ type: "rotate" }, target(writer));
    expect(calls).toEqual([["rotate", undefined]]);
  });
});
