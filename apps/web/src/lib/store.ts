import { useSyncExternalStore } from "react";

export interface Store<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      const v = typeof next === "function" ? (next as (p: T) => T)(value) : next;
      if (Object.is(v, value)) return;
      value = v;
      for (const s of subs) s();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Set when the workspace is read-only (from its status or a 402 response). */
export const readOnlyStore = createStore(false);
export const setReadOnly = (v: boolean) => readOnlyStore.set(v);
export const useReadOnly = () => useStore(readOnlyStore);

export type PickerKind = "status" | "priority" | "assignee" | "labels";

export interface CreateDefaults {
  teamId?: string;
  statusId?: string;
  parentId?: string;
  assigneeId?: string | null;
}

export interface UiState {
  createOpen: boolean;
  createDefaults: CreateDefaults;
  paletteOpen: boolean;
  helpOpen: boolean;
  picker: { kind: PickerKind; issueRef: string } | null;
  navOpen: boolean;
}

export const uiStore = createStore<UiState>({
  createOpen: false,
  createDefaults: {},
  paletteOpen: false,
  helpOpen: false,
  picker: null,
  navOpen: false,
});
export const useUi = () => useStore(uiStore);
export const ui = {
  openCreate: (createDefaults: CreateDefaults = {}) => uiStore.set((s) => ({ ...s, createOpen: true, createDefaults })),
  closeCreate: () => uiStore.set((s) => ({ ...s, createOpen: false })),
  openPalette: () => uiStore.set((s) => ({ ...s, paletteOpen: true })),
  closePalette: () => uiStore.set((s) => ({ ...s, paletteOpen: false })),
  openHelp: () => uiStore.set((s) => ({ ...s, helpOpen: true })),
  closeHelp: () => uiStore.set((s) => ({ ...s, helpOpen: false })),
  openPicker: (kind: PickerKind, issueRef: string) => uiStore.set((s) => ({ ...s, picker: { kind, issueRef } })),
  closePicker: () => uiStore.set((s) => ({ ...s, picker: null })),
  setNav: (navOpen: boolean) => uiStore.set((s) => ({ ...s, navOpen })),
};

/** The issue keyboard shortcuts act on: the focused row/card or the open issue. */
export const currentIssueStore = createStore<string | null>(null);
export const useCurrentIssue = () => useStore(currentIssueStore);
