/**
 * The price calculators on / and /pricing. Uses the same pricing module as the
 * nightly charge, so the page and the bill can never disagree. The server renders
 * the default result; this only updates it as the sliders move.
 */
import {
  AVG_DAYS_PER_MONTH,
  creditLastsDays,
  dailyCharge,
  estimateEmails,
  monthlyCost,
  type PricingSettings,
  serverShareMicro,
} from "@glasstrack/shared/pricing";
import { centsSplit, int, usd, usdWhole } from "../fmt";

interface CalcData {
  settings: PricingSettings;
  sharedFixedMonthMicro: number;
  activeWorkspaces: number;
  typicalStorageGb: number;
  competitors: { vendor: string; perUserMonthUsd: number; freeUpToUsers?: number }[];
}

const el = document.getElementById("pricing-data");
const data: CalcData | null = el ? (JSON.parse(el.textContent ?? "null") as CalcData) : null;

function cost(storageGb: number, emails: number) {
  return monthlyCost({
    settings: data!.settings,
    sharedFixedMonthMicro: data!.sharedFixedMonthMicro,
    activeWorkspaces: data!.activeWorkspaces,
    storageGb,
    emailsPerMonth: emails,
  });
}

const num = (input: HTMLInputElement | null, fallback: number) => {
  const v = Number(input?.value);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

function setText(scope: ParentNode, sel: string, text: string) {
  for (const n of scope.querySelectorAll<HTMLElement>(sel)) n.textContent = text;
}

function competitors(scope: ParentNode, team: number) {
  for (const c of data!.competitors) {
    const monthly = c.freeUpToUsers !== undefined && team <= c.freeUpToUsers ? 0 : c.perUserMonthUsd * team;
    setText(scope, `[data-competitor="${c.vendor}"]`, `$${int(monthly)}${scope instanceof HTMLElement && scope.hasAttribute("data-mini-calc") ? "/mo" : ""}`);
  }
}

/** Home: team size only. */
function miniCalc(root: HTMLElement) {
  const team = root.querySelector<HTMLInputElement>('[data-in="team"]');
  const update = () => {
    const n = Math.max(1, Math.round(num(team, 20)));
    const b = cost(data!.typicalStorageGb, estimateEmails(n));
    setText(root, '[data-out="team"]', `${int(n)} ${n === 1 ? "person" : "people"}`);
    setText(root, '[data-out="gt"]', `~${usdWhole(b.totalMicro)}/mo`);
    competitors(root, n);
  };
  team?.addEventListener("input", update);
}

/** Pricing: team, storage and emails, with the full breakdown. */
function fullCalc(root: HTMLElement) {
  const team = root.querySelector<HTMLInputElement>('[data-in="team"]');
  const storage = root.querySelector<HTMLInputElement>('[data-in="storage"]');
  const emails = root.querySelector<HTMLInputElement>('[data-in="emails"]');
  const reset = root.querySelector<HTMLButtonElement>("[data-reset-emails]");
  const page = root.ownerDocument;
  let emailsDetached = false;

  const update = () => {
    const n = Math.max(1, Math.round(num(team, 20)));
    const gb = num(storage, 0);
    if (!emailsDetached && emails) emails.value = String(estimateEmails(n));
    const e = Math.round(num(emails, estimateEmails(n)));
    const b = cost(gb, e);
    const [server, store, mail, fees] = centsSplit([b.serverShareMicro, b.storageMicro, b.emailMicro, b.feesAndReserveMicro], b.totalMicro) as [
      number,
      number,
      number,
      number,
    ];
    const total = server + store + mail + fees;
    setText(root, '[data-out="team"]', int(n));
    setText(page, '[data-out="team2"]', int(n));
    setText(root, '[data-out="storage"]', `${int(gb)} GB`);
    setText(root, '[data-out="server"]', usd(server));
    setText(root, '[data-out="storageCost"]', usd(store));
    setText(root, '[data-out="email"]', usd(mail));
    setText(root, '[data-out="fees"]', usd(fees));
    for (const k of ["total", "total2"]) setText(root, `[data-out="${k}"]`, usd(total));
    setText(page, '[data-out="total3"]', usd(total));
    setText(root, '[data-out="daily"]', usd(dailyCharge(b, AVG_DAYS_PER_MONTH).totalMicro));
    const days = creditLastsDays(data!.settings.signupCreditUsd * 1_000_000, b.totalMicro);
    setText(root, '[data-out="lasts"]', days === null ? "forever" : `${int(days)} days`);
    const compare = page.getElementById("compare");
    if (compare) competitors(compare, n);
    if (reset) reset.hidden = !emailsDetached;
  };
  team?.addEventListener("input", update);
  storage?.addEventListener("input", update);
  emails?.addEventListener("input", () => {
    emailsDetached = true;
    update();
  });
  reset?.addEventListener("click", () => {
    emailsDetached = false;
    update();
    emails?.focus();
  });
}

/** Pricing: "if N teams were using Glasstrack". */
function whatIf(root: HTMLElement) {
  const teams = root.querySelector<HTMLInputElement>('[data-in="teams"]');
  teams?.addEventListener("input", () => {
    const n = Math.max(1, Math.round(num(teams, 1)));
    setText(root, '[data-out="teams"]', int(n));
    setText(root, '[data-out="teams2"]', int(n));
    setText(root, '[data-out="share"]', usd(serverShareMicro(data!.settings, data!.sharedFixedMonthMicro, n)));
  });
}

if (data) {
  for (const r of document.querySelectorAll<HTMLElement>("[data-mini-calc]")) miniCalc(r);
  for (const r of document.querySelectorAll<HTMLElement>("[data-calc]")) fullCalc(r);
  for (const r of document.querySelectorAll<HTMLElement>("[data-what-if]")) whatIf(r);
}
