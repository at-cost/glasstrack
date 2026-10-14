import { createStore, useStore } from "./store";

export interface Toast {
  id: number;
  kind: "error" | "info" | "success";
  message: string;
}

let next = 1;
export const toastStore = createStore<Toast[]>([]);
export const useToasts = () => useStore(toastStore);

export function dismissToast(id: number) {
  toastStore.set((list) => list.filter((t) => t.id !== id));
}

export function toast(message: string, kind: Toast["kind"] = "info") {
  const id = next++;
  toastStore.set((list) => [...list.slice(-3), { id, kind, message }]);
  setTimeout(() => dismissToast(id), kind === "error" ? 7000 : 4000);
}

export const toastError = (message: string) => toast(message, "error");
