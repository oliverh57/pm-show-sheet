// Inputs that keep a local draft and commit on blur / Enter, so typing doesn't create an undo step per key.
import { useEffect, useState } from "react";

interface Props {
  value: string;
  onCommit: (value: string) => void;
  multiline?: boolean;
  placeholder?: string;
  className?: string;
  mono?: boolean;
}

export function DraftInput({ value, onCommit, multiline, placeholder, className, mono }: Props) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const commit = () => draft !== value && onCommit(draft);
  const common = {
    value: draft,
    placeholder,
    className: [className, mono && "mono"].filter(Boolean).join(" "),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === "Escape") {
        setDraft(value);
        (e.target as HTMLElement).blur();
      } else if (e.key === "Enter" && (!multiline || e.metaKey)) {
        (e.target as HTMLElement).blur();
      }
    },
  };
  return multiline ? <textarea rows={3} {...common} /> : <input {...common} />;
}
