/**
 * buttons.ts - Input Button Definitions
 *
 * Defines all supported keyboard and mouse buttons for the input system.
 * Maps between different button name formats (code names, property names, display labels).
 *
 * Button Name Formats:
 * - Code: JavaScript KeyboardEvent.code (e.g., 'KeyA', 'Digit0')
 * - Prop: Normalized property name (e.g., 'keyA', 'digit0')
 * - Label: Human-readable display name (e.g., 'A', '0')
 *
 * Supported Inputs:
 * - Letter keys (A-Z)
 * - Number keys (0-9)
 * - Special keys (Space, Enter, Escape, etc.)
 * - Arrow keys
 * - Modifier keys (Shift, Ctrl, Alt, Meta)
 * - Mouse buttons (Left, Right)
 *
 * Usage:
 * ```ts
 * import { buttons, codeToProp, propToLabel } from './buttons';
 *
 * if (buttons.has('keyW')) {
 *   // W key is a valid button
 * }
 *
 * const prop = codeToProp['KeyW'];  // 'keyW'
 * const label = propToLabel['keyW']; // 'W'
 * ```
 *
 * Referenced by: ClientInput system for key binding and input handling
 */

/**
 * Set of all valid button property names.
 * Used for validation in the input system.
 */
export const buttons = new Set([
  "keyA",
  "keyB",
  "keyC",
  "keyD",
  "keyE",
  "keyF",
  "keyG",
  "keyH",
  "keyI",
  "keyJ",
  "keyK",
  "keyL",
  "keyM",
  "keyN",
  "keyO",
  "keyP",
  "keyQ",
  "keyR",
  "keyS",
  "keyT",
  "keyU",
  "keyV",
  "keyW",
  "keyX",
  "keyY",
  "keyZ",
  "digit0",
  "digit1",
  "digit2",
  "digit3",
  "digit4",
  "digit5",
  "digit6",
  "digit7",
  "digit8",
  "digit9",
  "minus",
  "equal",
  "bracketLeft",
  "bracketRight",
  "backslash",
  "semicolon",
  "quote",
  "backquote",
  "comma",
  "period",
  "slash",
  "arrowUp",
  "arrowDown",
  "arrowLeft",
  "arrowRight",
  "home",
  "end",
  "pageUp",
  "pageDown",
  "tab",
  "capsLock",
  "shiftLeft",
  "shiftRight",
  "controlLeft",
  "controlRight",
  "altLeft",
  "altRight",
  "enter",
  "space",
  "backspace",
  "delete",
  "escape",
  "mouseLeft",
  "mouseRight",
  "metaLeft",
]);

/**
 * Map from JavaScript KeyboardEvent.code to property names.
 *
 * Example: 'KeyA' → 'keyA'
 *
 * Used by ClientInput to normalize keyboard events to consistent property names.
 */
export const codeToProp: Record<string, string> = {
  KeyA: "keyA",
  KeyB: "keyB",
  KeyC: "keyC",
  KeyD: "keyD",
  KeyE: "keyE",
  KeyF: "keyF",
  KeyG: "keyG",
  KeyH: "keyH",
  KeyI: "keyI",
  KeyJ: "keyJ",
  KeyK: "keyK",
  KeyL: "keyL",
  KeyM: "keyM",
  KeyN: "keyN",
  KeyO: "keyO",
  KeyP: "keyP",
  KeyQ: "keyQ",
  KeyR: "keyR",
  KeyS: "keyS",
  KeyT: "keyT",
  KeyU: "keyU",
  KeyV: "keyV",
  KeyW: "keyW",
  KeyX: "keyX",
  KeyY: "keyY",
  KeyZ: "keyZ",
  Digit0: "digit0",
  Digit1: "digit1",
  Digit2: "digit2",
  Digit3: "digit3",
  Digit4: "digit4",
  Digit5: "digit5",
  Digit6: "digit6",
  Digit7: "digit7",
  Digit8: "digit8",
  Digit9: "digit9",
  Minus: "minus",
  Equal: "equal",
  BracketLeft: "bracketLeft",
  BracketRight: "bracketRight",
  Backslash: "backslash",
  Semicolon: "semicolon",
  Quote: "quote",
  Backquote: "backquote",
  Comma: "comma",
  Period: "period",
  Slash: "slash",
  ArrowUp: "arrowUp",
  ArrowDown: "arrowDown",
  ArrowLeft: "arrowLeft",
  ArrowRight: "arrowRight",
  Home: "home",
  End: "end",
  PageUp: "pageUp",
  PageDown: "pageDown",
  Tab: "tab",
  CapsLock: "capsLock",
  ShiftLeft: "shiftLeft",
  ShiftRight: "shiftRight",
  ControlLeft: "controlLeft",
  ControlRight: "controlRight",
  AltLeft: "altLeft",
  AltRight: "altRight",
  Enter: "enter",
  Space: "space",
  Backspace: "backspace",
  Delete: "delete",
  Escape: "escape",
  MouseLeft: "mouseLeft",
  MouseRight: "mouseRight",
  MetaLeft: "metaLeft",
};

/**
 * Reverse map from property names to KeyboardEvent.code.
 *
 * Example: 'keyA' → 'KeyA'
 *
 * Used for key binding serialization and display.
 */
export const propToCode = {
  keyA: "KeyA",
  keyB: "KeyB",
  keyC: "KeyC",
  keyD: "KeyD",
  keyE: "KeyE",
  keyF: "KeyF",
  keyG: "KeyG",
  keyH: "KeyH",
  keyI: "KeyI",
  keyJ: "KeyJ",
  keyK: "KeyK",
  keyL: "KeyL",
  keyM: "KeyM",
  keyN: "KeyN",
  keyO: "KeyO",
  keyP: "KeyP",
  keyQ: "KeyQ",
  keyR: "KeyR",
  keyS: "KeyS",
  keyT: "KeyT",
  keyU: "KeyU",
  keyV: "KeyV",
  keyW: "KeyW",
  keyX: "KeyX",
  keyY: "KeyY",
  keyZ: "KeyZ",
  digit0: "Digit0",
  digit1: "Digit1",
  digit2: "Digit2",
  digit3: "Digit3",
  digit4: "Digit4",
  digit5: "Digit5",
  digit6: "Digit6",
  digit7: "Digit7",
  digit8: "Digit8",
  digit9: "Digit9",
  minus: "Minus",
  equal: "Equal",
  bracketLeft: "BracketLeft",
  bracketRight: "BracketRight",
  backslash: "Backslash",
  semicolon: "Semicolon",
  quote: "Quote",
  backquote: "Backquote",
  comma: "Comma",
  period: "Period",
  slash: "Slash",
  arrowUp: "ArrowUp",
  arrowDown: "ArrowDown",
  arrowLeft: "ArrowLeft",
  arrowRight: "ArrowRight",
  home: "Home",
  end: "End",
  pageUp: "PageUp",
  pageDown: "PageDown",
  tab: "Tab",
  capsLock: "CapsLock",
  shiftLeft: "ShiftLeft",
  shiftRight: "ShiftRight",
  controlLeft: "ControlLeft",
  controlRight: "ControlRight",
  altLeft: "AltLeft",
  altRight: "AltRight",
  enter: "Enter",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  escape: "Escape",
  mouseLeft: "MouseLeft",
  mouseRight: "MouseRight",
  metaLeft: "MetaLeft",
};

/**
 * Map from property names to human-readable labels.
 *
 * Example: 'keyA' → 'A', 'mouseLeft' → 'LMB'
 *
 * Used for displaying key bindings in UI.
 */
export const propToLabel = {
  keyA: "A",
  keyB: "B",
  keyC: "C",
  keyD: "D",
  keyE: "E",
  keyF: "F",
  keyG: "G",
  keyH: "H",
  keyI: "I",
  keyJ: "J",
  keyK: "K",
  keyL: "L",
  keyM: "M",
  keyN: "N",
  keyO: "O",
  keyP: "P",
  keyQ: "Q",
  keyR: "R",
  keyS: "S",
  keyT: "T",
  keyU: "U",
  keyV: "V",
  keyW: "W",
  keyX: "X",
  keyY: "Y",
  keyZ: "Z",
  digit0: "0",
  digit1: "1",
  digit2: "2",
  digit3: "3",
  digit4: "4",
  digit5: "5",
  digit6: "6",
  digit7: "7",
  digit8: "8",
  digit9: "9",
  minus: "-",
  equal: "=",
  bracketLeft: "[",
  bracketRight: "]",
  backslash: "\\",
  semicolon: ";",
  quote: '"',
  backquote: "`",
  comma: ",",
  period: ".",
  slash: "/",
  arrowUp: "Up",
  arrowDown: "Down",
  arrowLeft: "Left",
  arrowRight: "Right",
  home: "Home",
  end: "End",
  pageUp: "PageUp",
  pageDown: "PageDown",
  tab: "Tab",
  capsLock: "CapsLock",
  shiftLeft: "Shift",
  shiftRight: "Shift",
  controlLeft: "Ctrl",
  controlRight: "Ctrl",
  altLeft: "Alt",
  altRight: "Alt",
  enter: "Enter",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  escape: "Esc",
  mouseLeft: "LMB",
  mouseRight: "RMB",
  metaLeft: "Cmd",
};
