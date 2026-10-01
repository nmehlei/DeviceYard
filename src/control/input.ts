import type { InputWriter } from "./controlStream";

/** Android KeyEvent keycodes. Values verified against @yume-chan/scrcpy's
 * AndroidKeyCode (Back 4, Home 3, AppSwitch 187, Power 26, VolumeUp 24,
 * VolumeDown 25) plus Enter 66 and Del 67 for typing into settings. */
export const HARDWARE_KEYS = {
  back: 4,
  home: 3,
  recents: 187,
  power: 26,
  "volume-up": 24,
  "volume-down": 25,
  enter: 66,
  delete: 67,
} as const;
export type HardwareKey = keyof typeof HARDWARE_KEYS;

export type ClientInput =
  | { type: "touch"; action: "down" | "move" | "up" | "cancel"; pointerId: number; x: number; y: number }
  | { type: "key"; key: HardwareKey }
  | { type: "text"; text: string }
  | { type: "rotate" };

/** Generous for a settings field or a search box; small enough that one
 * message cannot tie up the control channel. Rejected, never truncated - a
 * silently shortened password is worse than a refused one. */
export const MAX_TEXT_LENGTH = 1000;

const TOUCH_ACTIONS = { down: 0, up: 1, move: 2, cancel: 3 } as const;

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The only way a browser message becomes device input. Everything it does not
 * recognise exactly is dropped: this channel types into and taps on a real
 * phone, so an unknown shape is never "probably fine".
 */
export function parseClientInput(raw: unknown): ClientInput | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const m = raw as Record<string, unknown>;

  switch (m.type) {
    case "touch":
      if (typeof m.action !== "string" || !Object.prototype.hasOwnProperty.call(TOUCH_ACTIONS, m.action)) return undefined;
      if (!Number.isInteger(m.pointerId) || !isFiniteNumber(m.x) || !isFiniteNumber(m.y)) return undefined;
      return {
        type: "touch",
        action: m.action as keyof typeof TOUCH_ACTIONS,
        pointerId: m.pointerId as number,
        x: m.x,
        y: m.y,
      };
    case "key":
      if (typeof m.key !== "string" || !Object.prototype.hasOwnProperty.call(HARDWARE_KEYS, m.key)) return undefined;
      return { type: "key", key: m.key as HardwareKey };
    case "text":
      if (typeof m.text !== "string" || m.text.length === 0 || m.text.length > MAX_TEXT_LENGTH) return undefined;
      return { type: "text", text: m.text };
    case "rotate":
      return { type: "rotate" };
    default:
      return undefined;
  }
}

const clamp = (value: number, max: number) => Math.min(max, Math.max(0, Math.round(value)));

export async function applyInput(
  input: ClientInput,
  target: { width: number; height: number; input: InputWriter }
): Promise<void> {
  switch (input.type) {
    case "touch": {
      const action = TOUCH_ACTIONS[input.action];
      await target.input.injectTouch({
        action,
        pointerId: BigInt(input.pointerId),
        // Coordinates are in VIDEO pixels with the video size alongside; the
        // server rescales them to the physical display.
        pointerX: clamp(input.x * target.width, target.width),
        pointerY: clamp(input.y * target.height, target.height),
        videoWidth: target.width,
        videoHeight: target.height,
        pressure: action === TOUCH_ACTIONS.up || action === TOUCH_ACTIONS.cancel ? 0 : 1,
        actionButton: 0,
        buttons: 0,
      });
      return;
    }
    case "key": {
      const keyCode = HARDWARE_KEYS[input.key];
      await target.input.injectKeyCode({ action: 0, keyCode, repeat: 0, metaState: 0 });
      await target.input.injectKeyCode({ action: 1, keyCode, repeat: 0, metaState: 0 });
      return;
    }
    case "text":
      await target.input.injectText(input.text);
      return;
    case "rotate":
      await target.input.rotateDevice();
      return;
  }
}
