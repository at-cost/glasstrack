import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Upload } from "lucide-react";
import { useState } from "react";
import { Card } from "../../components/Card";
import { Spinner } from "../../components/Feedback";
import { api, errorMessage, type ImportSource, type ImportSummary } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { paths } from "../../lib/paths";
import { keys, useTeams } from "../../lib/queries";
import { toastError } from "../../lib/toast";
import { useWs } from "../shell/context";

const SOURCES: { id: ImportSource; label: string; accept: string; where: string }[] = [
  { id: "linear", label: "Linear (CSV)", accept: ".csv,text/csv", where: "In Linear: Settings, Import/export, Export CSV." },
  { id: "jira", label: "Jira (CSV)", accept: ".csv,text/csv", where: "In Jira: Filters, Export, Export Excel CSV (all fields)." },
  {
    id: "trello",
    label: "Trello (JSON)",
    accept: ".json,application/json",
    where: "In Trello: board menu, Print, export and share, Export as JSON. Lists become statuses.",
  },
];
const MAX_BYTES = 25 * 1024 * 1024;

export function Import() {
  const { slug, canEdit, workspace } = useWs();
  const qc = useQueryClient();
  const teams = useTeams(slug);
  const [source, setSource] = useState<ImportSource>("linear");
  const [teamId, setTeamId] = useState("");
  const [file, setFile] = useState<{ name: string; size: number; content: string } | null>(null);
  const [preview, setPreview] = useState<ImportSummary | null>(null);
  const [result, setResult] = useState<ImportSummary | null>(null);
  const [busy, setBusy] = useState<"read" | "preview" | "import" | null>(null);
  const team = teams.data?.find((t) => t.id === (teamId || teams.data?.[0]?.id));
  const src = SOURCES.find((s) => s.id === source)!;

  if (workspace.role === "guest") {
    return (
      <Card title="Import">
        <p className="muted">Guests can't import issues.</p>
      </Card>
    );
  }

  const reset = () => {
    setPreview(null);
    setResult(null);
  };
  const pick = async (f: File | undefined) => {
    reset();
    setFile(null);
    if (!f) return;
    if (f.size > MAX_BYTES) {
      toastError("That file is over 25 MB. Split the export and import it in parts.");
      return;
    }
    setBusy("read");
    try {
      setFile({ name: f.name, size: f.size, content: await f.text() });
    } catch {
      toastError("Could not read that file.");
    } finally {
      setBusy(null);
    }
  };
  const run = async (dryRun: boolean) => {
    if (!file || !team) return;
    setBusy(dryRun ? "preview" : "import");
    try {
      const r = await api.ws(slug).runImport({ source, teamId: team.id, content: file.content, dryRun });
      if (dryRun) setPreview(r);
      else {
        setResult(r);
        setPreview(null);
        setFile(null);
        qc.invalidateQueries({ queryKey: keys.issuesAll(slug) });
        qc.invalidateQueries({ queryKey: keys.states(slug) });
        qc.invalidateQueries({ queryKey: keys.labels(slug) });
      }
    } catch (err) {
      toastError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Card title="Import issues">
        <p className="muted small">
          Bring issues, comments and labels in from another tracker. You see a preview before anything is saved.
        </p>
        <fieldset className="fieldset">
          <legend className="field-label">From</legend>
          <div className="radio-row">
            {SOURCES.map((s) => (
              <label key={s.id} className="check-row">
                <input
                  type="radio"
                  name="import-source"
                  checked={source === s.id}
                  onChange={() => {
                    setSource(s.id);
                    setFile(null);
                    reset();
                  }}
                />
                {s.label}
              </label>
            ))}
          </div>
          <p className="field-hint">{src.where}</p>
        </fieldset>
        <div className="field">
          <label className="field-label" htmlFor="import-team">
            Into team
          </label>
          <select
            id="import-team"
            className="select"
            value={team?.id ?? ""}
            onChange={(e) => {
              setTeamId(e.target.value);
              reset();
            }}
          >
            {teams.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.key})
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <span className="field-label" id="import-file-label">
            Export file
          </span>
          <label className="file-pick">
            <input
              type="file"
              accept={src.accept}
              aria-labelledby="import-file-label"
              disabled={!canEdit}
              onChange={(e) => {
                void pick(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <Upload size={14} aria-hidden="true" />
            {file ? "Choose another file" : "Choose file"}
          </label>
          {file && (
            <p className="small" data-testid="import-file">
              {file.name} ({formatBytes(file.size)})
            </p>
          )}
        </div>
        <div className="row">
          <button type="button" className="btn btn-primary" disabled={!file || !team || busy !== null || !canEdit} onClick={() => run(true)}>
            {busy === "preview" && <Spinner label="Checking file" />}
            Preview import
          </button>
        </div>
      </Card>
      {preview && team && (
        <Card title="Preview">
          <div role="status">
            <Summary s={preview} />
          </div>
          <p className="muted small">Nothing has been saved yet.</p>
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => run(false)}>
              {busy === "import" && <Spinner label="Importing" />}
              Import {preview.issues} {preview.issues === 1 ? "issue" : "issues"} into {team.name}
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={reset}>
              Cancel
            </button>
          </div>
        </Card>
      )}
      {result && team && (
        <Card title="Import finished">
          <div role="status">
            <Summary s={result} done />
          </div>
          <div>
            <Link to={paths.teamIssues(slug, team.key)} className="btn btn-primary">
              Open {team.name} issues
            </Link>
          </div>
        </Card>
      )}
    </>
  );
}

function Summary({ s, done }: { s: ImportSummary; done?: boolean }) {
  return (
    <ul className="summary-list">
      <li>
        <strong>{s.issues}</strong> {s.issues === 1 ? "issue" : "issues"} and <strong>{s.comments}</strong>{" "}
        {s.comments === 1 ? "comment" : "comments"} {done ? "imported" : "will be imported"}.
      </li>
      {s.statusesCreated.length > 0 && (
        <li>
          New statuses: <strong>{s.statusesCreated.join(", ")}</strong>
        </li>
      )}
      {s.labelsCreated.length > 0 && (
        <li>
          New labels: <strong>{s.labelsCreated.join(", ")}</strong>
        </li>
      )}
      {s.unmatchedAssignees.length > 0 && (
        <li>
          No member matches {s.unmatchedAssignees.length === 1 ? "this person" : "these people"}, so their issues are left unassigned:{" "}
          <strong>{s.unmatchedAssignees.join(", ")}</strong>
        </li>
      )}
    </ul>
  );
}
