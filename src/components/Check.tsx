type Props = { on: boolean; onClick: () => void; label: string; invert?: boolean; top?: boolean };

export default function Check({ on, onClick, label, invert, top }: Props) {
  return (
    <button
      type="button"
      className={"check" + (on ? " on" : "") + (invert ? " invert" : "") + (top ? " top" : "")}
      onClick={onClick}
      aria-pressed={on}
      aria-label={label}
    >
      {on && (
        <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12l5 5 9-10" />
        </svg>
      )}
    </button>
  );
}
