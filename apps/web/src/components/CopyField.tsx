import { Copy, Eye, EyeOff } from "lucide-react";
import { useId, useState } from "react";
import { toast, toastError } from "../lib/toast";

export async function copyText(text: string, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(what, "success");
  } catch {
    toastError("Could not copy. Select the text and copy it by hand.");
  }
}

/** A read-only value with a copy button. `secret` masks it until revealed. */
export function CopyField({ label, value, secret, hint }: { label: string; value: string; secret?: boolean; hint?: string }) {
  const id = useId();
  const [shown, setShown] = useState(!secret);
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="copy-row">
        <input
          id={id}
          className="input mono"
          readOnly
          value={shown ? value : "•".repeat(Math.min(32, value.length))}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onFocus={(e) => shown && e.target.select()}
        />
        {secret && (
          <button
            type="button"
            className="icon-btn bordered"
            aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
            aria-pressed={shown}
            onClick={() => setShown((s) => !s)}
          >
            {shown ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        )}
        <button type="button" className="btn" onClick={() => copyText(value, `${label} copied`)}>
          <Copy size={14} aria-hidden="true" />
          Copy
        </button>
      </div>
      {hint && (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}
