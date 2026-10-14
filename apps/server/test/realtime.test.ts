import type { RealtimeEvent } from "@tracker/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createHarness, type Harness, setupWorkspace } from "./harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await h.reset();
  await h.deps.hub.start();
});
afterAll(async () => {
  await h?.close();
});

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};

it("committed changes reach subscribers of that workspace only; rolled back ones never do", async () => {
  const a = await setupWorkspace(h, "a@a.co", "alpha");
  const b = await setupWorkspace(h, "b@b.co", "bravo");
  const aId = (await a.c.ok("GET", "/api/v1/w/alpha")).id;
  const bId = (await b.c.ok("GET", "/api/v1/w/bravo")).id;
  const aUser = (await a.c.ok("GET", "/api/v1/me")).id;
  const seenA: RealtimeEvent[] = [];
  const seenB: RealtimeEvent[] = [];
  h.deps.hub.subscribe(aId, aUser, (e) => seenA.push(e));
  h.deps.hub.subscribe(bId, "someone", (e) => seenB.push(e));

  const issue = await a.c.ok("POST", "/api/v1/w/alpha/issues", { teamId: a.team.id, title: "live" });
  await waitFor(() => seenA.some((e) => e.t === "issue" && e.id === issue.id));
  expect(seenA.some((e) => e.t === "issue" && e.id === issue.id)).toBe(true);

  // A failing request (bad status id) rolls back, so no event.
  const before = seenA.length;
  const r = await a.c.patch(`/api/v1/w/alpha/issues/${issue.id}`, { title: "x", statusId: "00000000-0000-0000-0000-000000000000" });
  expect(r.status).toBe(400);
  await new Promise((res) => setTimeout(res, 200));
  expect(seenA.length).toBe(before);
  expect(seenB).toEqual([]);
});

it("SSE endpoint requires membership", async () => {
  const a = await setupWorkspace(h, "c@c.co", "charlie");
  expect((await a.c.get("/api/v1/w/nope/events")).status).toBe(404);
});
