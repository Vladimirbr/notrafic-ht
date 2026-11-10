import type { KeyboardEvent } from "react";

export function isPlainShortcut(event: KeyboardEvent): boolean {
  return (
    event.target === event.currentTarget &&
    !event.repeat &&
    !event.nativeEvent.isComposing &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

export function isDeleteKey(key: string): boolean {
  return key === "Delete" || key === "Backspace";
}
