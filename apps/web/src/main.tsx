import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "./lib/api";
import { applyTheme, themeStore } from "./lib/theme";
import { router } from "./router";
import "./styles/base.css";
import "./styles/app.css";

applyTheme(themeStore.get());

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => {
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
        return count < 2;
      },
    },
  },
  queryCache: new QueryCache({
    onError: (err) => {
      // A lost session anywhere sends the user to sign in.
      if (err instanceof ApiError && err.status === 401 && !window.location.pathname.startsWith("/login")) {
        const redirect = window.location.pathname + window.location.search;
        if (!["/app", "/auth/verify"].includes(window.location.pathname) && !/^\/(invite|forms)\//.test(window.location.pathname)) {
          router.navigate({ to: "/login", search: { redirect }, replace: true });
        }
      }
    },
  }),
  mutationCache: new MutationCache(),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
