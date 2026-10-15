import { describe, expect, it } from "vitest";
import { automationRuleSchema, conditionsMatch, type IssueSnapshot, triggerMatches, updateAutomationRuleSchema } from "./automation";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const snap = (s: Partial<IssueSnapshot> = {}): IssueSnapshot => ({
  teamId: A, statusId: A, category: "started", priority: 2, labelIds: [], assigneeIds: [], fields: {}, ...s,
});

describe("automation matching", () => {
  it("status trigger filters by status or category", () => {
    const ev = { type: "status_changed" as const, toStatusId: A, toCategory: "completed" as const };
    expect(triggerMatches("status_changed", {}, ev)).toBe(true);
    expect(triggerMatches("status_changed", { toCategories: ["completed"] }, ev)).toBe(true);
    expect(triggerMatches("status_changed", { toCategories: ["canceled"] }, ev)).toBe(false);
    expect(triggerMatches("status_changed", { toStatusIds: [B] }, ev)).toBe(false);
    expect(triggerMatches("issue_created", {}, ev)).toBe(false);
  });
  it("label trigger filters by label", () => {
    expect(triggerMatches("label_added", { labelIds: [A] }, { type: "label_added", labelIds: [A, B] })).toBe(true);
    expect(triggerMatches("label_added", { labelIds: [A] }, { type: "label_added", labelIds: [B] })).toBe(false);
  });
  it("conditions are ANDed", () => {
    expect(conditionsMatch({}, snap())).toBe(true);
    expect(conditionsMatch({ priorities: [1, 2], categories: ["started"] }, snap())).toBe(true);
    expect(conditionsMatch({ priorities: [1] }, snap())).toBe(false);
    expect(conditionsMatch({ assignee: "none" }, snap({ assigneeIds: [A] }))).toBe(false);
    expect(conditionsMatch({ assignee: [B] }, snap({ assigneeIds: [A, B] }))).toBe(true);
    expect(conditionsMatch({ labelIds: [A], notLabelIds: [B] }, snap({ labelIds: [A] }))).toBe(true);
    expect(conditionsMatch({ notLabelIds: [B] }, snap({ labelIds: [A, B] }))).toBe(false);
    expect(conditionsMatch({ fields: [{ fieldId: A, value: "s1" }] }, snap({ fields: { [A]: "s1" } }))).toBe(true);
    expect(conditionsMatch({ fields: [{ fieldId: A, value: "api" }] }, snap({ fields: { [A]: ["api", "ui"] } }))).toBe(true);
    expect(conditionsMatch({ fields: [{ fieldId: A, value: null }] }, snap())).toBe(true);
  });
  it("validates rules and keeps partial updates partial", () => {
    expect(() => automationRuleSchema.parse({ name: "x", trigger: "issue_created", actions: [] })).toThrow();
    expect(() => automationRuleSchema.parse({ name: "x", trigger: "issue_created", actions: [{ type: "nuke" }] })).toThrow();
    expect(automationRuleSchema.parse({ name: "x", trigger: "issue_created", actions: [{ type: "archive" }] }).enabled).toBe(true);
    expect(updateAutomationRuleSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });
});
