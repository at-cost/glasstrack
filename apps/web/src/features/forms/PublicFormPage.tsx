import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import type { PublicForm } from "@glasstrack/shared";
import { CircleCheck } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { FullPageLoading, Spinner } from "../../components/Feedback";
import { ApiError, api, errorMessage } from "../../lib/api";
import { keys } from "../../lib/queries";

const CLOSED = "This form doesn't exist or is closed.";

/** Public request form at /forms/:token. Works without signing in and without the app shell. */
export function PublicFormPage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const q = useQuery({ queryKey: keys.publicForm(token), queryFn: () => api.publicForm(token), retry: false, staleTime: 5 * 60_000 });
  useEffect(() => {
    if (q.data) document.title = `${q.data.name} · ${q.data.workspaceName}`;
    return () => {
      document.title = "Glasstrack";
    };
  }, [q.data]);
  return (
    <div className="public-page form-page">
      <main id="main" className="form-main">
        {q.isPending ? (
          <FullPageLoading />
        ) : q.error ? (
          <div className="form-card">
            <h1 className="form-title">{q.error instanceof ApiError && q.error.status === 404 ? CLOSED : "Could not load the form"}</h1>
            {!(q.error instanceof ApiError && q.error.status === 404) && <p className="muted">{errorMessage(q.error)}</p>}
          </div>
        ) : (
          <RequestForm token={token} form={q.data} />
        )}
        <p className="form-footer">
          Powered by{" "}
          <a href="https://github.com/at-cost/glasstrack" target="_blank" rel="noreferrer">
            Glasstrack
          </a>
        </p>
      </main>
    </div>
  );
}

/** Zod messages come as "field: text"; show them as a sentence. */
function friendly(e: unknown): string {
  if (e instanceof ApiError && e.status === 429) return "Too many requests, please try again later.";
  if (e instanceof ApiError && e.status === 404) return CLOSED;
  const m = errorMessage(e);
  const parts = /^(title|description|email|name): (.*)$/.exec(m);
  if (!parts) return m;
  const field = { title: "Title", description: "Details", email: "Email", name: "Name" }[parts[1] as "title"];
  return `${field}: ${parts[2]}`;
}

function RequestForm({ token, form }: { token: string; form: PublicForm }) {
  const uid = useId();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  // Spam trap: hidden from people, so only bots fill it in.
  const [website, setWebsite] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (sent) doneRef.current?.focus();
  }, [sent]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const t = title.trim();
    const em = email.trim();
    const tErr = t.length < 3 ? "Write a short title, at least 3 characters." : null;
    const eErr =
      form.requireEmail && !em ? "Your email address is needed." : em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em) ? "Check your email address." : null;
    setTitleError(tErr);
    setEmailError(eErr);
    if (tErr) return titleRef.current?.focus();
    if (eErr) return emailRef.current?.focus();
    setBusy(true);
    try {
      await api.submitForm(token, {
        title: t,
        description,
        ...(em ? { email: em } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
        website,
      });
      setSent(true);
    } catch (err) {
      setError(friendly(err));
    } finally {
      setBusy(false);
    }
  };

  const again = () => {
    setTitle("");
    setDescription("");
    setSent(false);
    setTimeout(() => titleRef.current?.focus(), 0);
  };

  if (sent) {
    return (
      <div className="form-card form-done" role="status">
        <CircleCheck size={28} aria-hidden="true" className="form-done-icon" />
        <h1 className="form-title" tabIndex={-1} ref={doneRef}>
          Thanks, your request was sent.
        </h1>
        <p className="muted">{form.workspaceName} will take it from here.</p>
        <div>
          <button type="button" className="btn" onClick={again}>
            Send another
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="form-card" onSubmit={submit} noValidate aria-labelledby={`${uid}-h`}>
      <div className="form-head">
        <p className="form-eyebrow">{form.workspaceName}</p>
        <h1 className="form-title" id={`${uid}-h`}>
          {form.name}
        </h1>
        {form.intro.trim() && <p className="form-intro">{form.intro}</p>}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="field">
        <label className="field-label" htmlFor={`${uid}-title`}>
          Title
        </label>
        <input
          ref={titleRef}
          id={`${uid}-title`}
          className="input"
          required
          maxLength={200}
          autoComplete="off"
          placeholder="A short summary"
          aria-invalid={titleError ? true : undefined}
          aria-describedby={titleError ? `${uid}-title-err` : undefined}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setTitleError(null);
          }}
        />
        {titleError && (
          <p className="field-error" id={`${uid}-title-err`}>
            {titleError}
          </p>
        )}
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`${uid}-desc`}>
          Details <span className="muted">(optional)</span>
        </label>
        <textarea
          id={`${uid}-desc`}
          className="input"
          rows={6}
          maxLength={10000}
          placeholder="What happened, what you expected, anything that helps"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="field-row">
        <div className="field">
          <label className="field-label" htmlFor={`${uid}-name`}>
            Your name <span className="muted">(optional)</span>
          </label>
          <input
            id={`${uid}-name`}
            className="input"
            maxLength={100}
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`${uid}-email`}>
            Email {!form.requireEmail && <span className="muted">(optional)</span>}
          </label>
          <input
            ref={emailRef}
            id={`${uid}-email`}
            className="input"
            type="email"
            required={form.requireEmail}
            maxLength={200}
            autoComplete="email"
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? `${uid}-email-err` : `${uid}-email-hint`}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setEmailError(null);
            }}
          />
          {emailError ? (
            <p className="field-error" id={`${uid}-email-err`}>
              {emailError}
            </p>
          ) : (
            <p className="field-hint" id={`${uid}-email-hint`}>
              Only used about this request.
            </p>
          )}
        </div>
      </div>
      <div className="hp-field" aria-hidden="true">
        <label htmlFor={`${uid}-website`}>Website</label>
        <input
          id={`${uid}-website`}
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </div>
      <div>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy && <Spinner label="Sending" />}
          Send request
        </button>
      </div>
    </form>
  );
}
