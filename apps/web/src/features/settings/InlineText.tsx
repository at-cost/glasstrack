import { useEffect, useState } from "react";

/** Text input that saves on blur or Enter and resets on Escape. */
export function InlineText({
  value,
  label,
  disabled,
  onSave,
  maxLength = 40,
}: {
  value: string;
  label: string;
  disabled?: boolean;
  onSave: (v: string) => void;
  maxLength?: number;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className="input input-sm grow"
      aria-label={label}
      value={v}
      disabled={disabled}
      maxLength={maxLength}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        const t = v.trim();
        if (!t) setV(value);
        else if (t !== value) onSave(t);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setV(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
