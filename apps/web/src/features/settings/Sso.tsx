import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Card } from "../../components/Card";
import { CopyField } from "../../components/CopyField";
import { ConfirmDialog } from "../../components/Dialog";
import { Empty, Skeleton, Spinner } from "../../components/Feedback";
import { api, errorMessage, type SsoSettings } from "../../lib/api";
import { keys } from "../../lib/queries";
import { toast, toastError } from "../../lib/toast";
import { useWs } from "../shell/context";

const DOMAIN = /^[a-z0-9.-]+\.[a-z]{2,}$/;

const PROVIDERS = [
  {
    name: "Okta",
    steps:
      "In the Admin Console, open Applications, Create App Integration, pick OIDC and Web Application. Add the callback URL as a sign-in redirect URI, then copy the client ID and secret. The issuer is your Okta domain, like https://acme.okta.com.",
  },
  {
    name: "Microsoft Entra ID",
    steps:
      "In App registrations, add a New registration with a Web redirect URI set to the callback URL. Create a client secret under Certificates and secrets. The issuer is https://login.microsoftonline.com/<tenant id>/v2.0.",
  },
  {
    name: "Google Workspace",
    steps:
      "In Google Cloud Console, open APIs and Services, Credentials, Create credentials, OAuth client ID, Web application. Add the callback URL as an authorized redirect URI. The issuer is https://accounts.google.com.",
  },
  {
    name: "Keycloak or Authentik",
    steps:
      "Create an OpenID Connect client (Keycloak) or an OAuth2/OpenID provider and application (Authentik) with client authentication on and the callback URL as a valid redirect URI. The issuer is the realm or application URL, like https://sso.acme.com/realms/acme.",
  },
];

export function Sso() {
  const { slug, isAdmin } = useWs();
  const q = useQuery({ queryKey: keys.sso(slug), queryFn: () => api.ws(slug).sso(), enabled: isAdmin });
  if (!isAdmin) {
    return (
      <Card title="Single sign-on">
        <p className="muted">Only admins can set up single sign-on.</p>
      </Card>
    );
  }
  if (q.isPending) return <Skeleton rows={4} />;
  if (q.error) return <Empty title="Could not load single sign-on">{errorMessage(q.error)}</Empty>;
  return <SsoForm key={"issuer" in q.data ? "set" : "unset"} settings={q.data} />;
}

function SsoForm({ settings }: { settings: SsoSettings }) {
  const { slug, canEdit } = useWs();
  const qc = useQueryClient();
  const id = useId();
  const configured = "issuer" in settings;
  const [issuer, setIssuer] = useState(configured ? settings.issuer : "");
  const [clientId, setClientId] = useState(configured ? settings.clientId : "");
  const [secret, setSecret] = useState("");
  const [domains, setDomains] = useState<string[]>(configured ? settings.allowedDomains : []);
  const [domainDraft, setDomainDraft] = useState("");
  const [autoJoin, setAutoJoin] = useState<"member" | "guest" | null>(configured ? settings.autoJoinRole : null);
  const [enforce, setEnforce] = useState(configured ? settings.enforce : false);
  const [enabled, setEnabled] = useState(configured ? settings.enabled : true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const hasSecret = configured && settings.hasSecret;

  useEffect(() => {
    if (enforce && domains.length === 0) setEnforce(false);
  }, [enforce, domains.length]);

  const addDomains = (raw: string) => {
    const parts = raw
      .split(/[\s,;]+/)
      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean);
    const bad = parts.filter((d) => !DOMAIN.test(d));
    if (bad.length) {
      setError(`${bad[0]} doesn't look like an email domain. Use something like acme.com.`);
      return false;
    }
    setDomains((cur) => [...new Set([...cur, ...parts])].slice(0, 20));
    setDomainDraft("");
    setError(null);
    return true;
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (domainDraft.trim() && !addDomains(domainDraft)) return;
    const allDomains = domainDraft.trim()
      ? [
          ...new Set([
            ...domains,
            ...domainDraft
              .split(/[\s,;]+/)
              .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
              .filter(Boolean),
          ]),
        ]
      : domains;
    if (!issuer.trim() || !clientId.trim()) return setError("Add the issuer URL and client ID.");
    if (!hasSecret && !secret) return setError("Add the client secret.");
    setBusy(true);
    setError(null);
    try {
      const next = await api.ws(slug).saveSso({
        issuer: issuer.trim(),
        clientId: clientId.trim(),
        ...(secret ? { clientSecret: secret } : {}),
        allowedDomains: allDomains,
        autoJoinRole: autoJoin,
        enforce: enforce && allDomains.length > 0,
        enabled,
      });
      qc.setQueryData(keys.sso(slug), next);
      setSecret("");
      toast("Single sign-on saved", "success");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      await api.ws(slug).removeSso();
      await qc.invalidateQueries({ queryKey: keys.sso(slug) });
      toast("Single sign-on removed", "success");
    } catch (err) {
      toastError(errorMessage(err));
    }
  };

  const disabled = !canEdit || busy;
  return (
    <>
      <Card title="Single sign-on">
        <p className="small">
          Let people sign in with your company's identity provider over OpenID Connect. Works with Okta, Microsoft Entra ID, Google
          Workspace, Keycloak, Authentik and other OIDC providers.
        </p>
        <form className="stack" onSubmit={save} noValidate>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="field">
            <label className="field-label" htmlFor={`${id}-issuer`}>
              Issuer URL
            </label>
            <input
              id={`${id}-issuer`}
              className="input"
              type="url"
              inputMode="url"
              placeholder="https://acme.okta.com"
              value={issuer}
              disabled={disabled}
              onChange={(e) => setIssuer(e.target.value)}
              aria-describedby={`${id}-issuer-hint`}
            />
            <p className="field-hint" id={`${id}-issuer-hint`}>
              We check it by reading its /.well-known/openid-configuration when you save.
            </p>
          </div>
          <div className="form-grid">
            <div className="field">
              <label className="field-label" htmlFor={`${id}-client`}>
                Client ID
              </label>
              <input
                id={`${id}-client`}
                className="input"
                value={clientId}
                disabled={disabled}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setClientId(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`${id}-secret`}>
                Client secret
              </label>
              <input
                id={`${id}-secret`}
                className="input"
                type="password"
                autoComplete="new-password"
                placeholder={hasSecret ? "Saved" : ""}
                value={secret}
                disabled={disabled}
                onChange={(e) => setSecret(e.target.value)}
                aria-describedby={hasSecret ? `${id}-secret-hint` : undefined}
              />
              {hasSecret && (
                <p className="field-hint" id={`${id}-secret-hint`}>
                  Leave empty to keep the saved secret.
                </p>
              )}
            </div>
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${id}-domain`}>
              Allowed email domains
            </label>
            {domains.length > 0 && (
              <ul className="chip-list" aria-label="Allowed domains">
                {domains.map((d) => (
                  <li key={d} className="label-chip domain-chip">
                    {d}
                    <button
                      type="button"
                      className="chip-remove"
                      aria-label={`Remove ${d}`}
                      disabled={disabled}
                      onClick={() => setDomains((cur) => cur.filter((x) => x !== d))}
                    >
                      <X size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="add-row">
              <input
                id={`${id}-domain`}
                className="input"
                placeholder="acme.com"
                value={domainDraft}
                disabled={disabled}
                autoComplete="off"
                spellCheck={false}
                aria-describedby={`${id}-domain-hint`}
                onChange={(e) => setDomainDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    if (domainDraft.trim()) addDomains(domainDraft);
                  } else if (e.key === "Backspace" && !domainDraft && domains.length) {
                    setDomains((cur) => cur.slice(0, -1));
                  }
                }}
              />
              <button type="button" className="btn" disabled={disabled || !domainDraft.trim()} onClick={() => addDomains(domainDraft)}>
                Add
              </button>
            </div>
            <p className="field-hint" id={`${id}-domain-hint`}>
              People with these email domains can find this workspace on the sign-in page. Leave empty to allow any email the provider
              sends.
            </p>
          </div>
          <fieldset className="fieldset">
            <legend className="field-label">New people who sign in with SSO</legend>
            <div className="radio-row">
              {(
                [
                  [null, "Need an invite"],
                  ["member", "Join as members"],
                  ["guest", "Join as guests"],
                ] as const
              ).map(([v, label]) => (
                <label key={String(v)} className="check-row">
                  <input type="radio" name={`${id}-join`} checked={autoJoin === v} disabled={disabled} onChange={() => setAutoJoin(v)} />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="check-row">
            <input
              type="checkbox"
              checked={enforce}
              disabled={disabled || domains.length === 0}
              onChange={(e) => setEnforce(e.target.checked)}
              aria-describedby={`${id}-enforce-hint`}
            />
            Require SSO for members
          </label>
          <p className="field-hint check-hint" id={`${id}-enforce-hint`}>
            {domains.length === 0
              ? "Add at least one email domain first."
              : "Members and guests must sign in through SSO to open this workspace. Admins can always sign in another way, so a broken setup can be fixed."}
          </p>
          <label className="check-row">
            <input type="checkbox" checked={enabled} disabled={disabled} onChange={(e) => setEnabled(e.target.checked)} />
            Single sign-on is on
          </label>
          <div className="row wrap">
            <button type="submit" className="btn btn-primary" disabled={disabled}>
              {busy && <Spinner label="Checking the provider" />}
              {busy ? "Checking the provider..." : "Save"}
            </button>
            {configured && (
              <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => setRemoving(true)}>
                Remove single sign-on
              </button>
            )}
          </div>
        </form>
      </Card>
      <Card title="Set up your identity provider">
        <ol className="steps">
          <li>Create an OpenID Connect web application in your provider.</li>
          <li>
            <CopyField
              label="Callback URL"
              value={settings.callbackUrl}
              hint="Add it as the redirect URI (sometimes called the sign-in redirect or reply URL)."
            />
          </li>
          <li>
            Allow the scopes <span className="mono">openid email profile</span>.
          </li>
          <li>Copy the issuer URL, client ID and client secret into the form above, then save.</li>
        </ol>
        <dl className="provider-list">
          {PROVIDERS.map((p) => (
            <div key={p.name} className="provider">
              <dt>{p.name}</dt>
              <dd className="small">{p.steps}</dd>
            </div>
          ))}
        </dl>
      </Card>
      {removing && (
        <ConfirmDialog
          title="Remove single sign-on?"
          message="People can no longer sign in with SSO. Members keep their access and can sign in with an email link."
          confirmLabel="Remove"
          danger
          onConfirm={remove}
          onClose={() => setRemoving(false)}
        />
      )}
    </>
  );
}
