import { useEffect, useRef, useState } from "react";
import { api, type Contact } from "../lib/api";

const SEP = /[,，;；]/;

const tail = (v: string) => {
  let i = -1;
  for (let k = v.length - 1; k >= 0; k--)
    if (SEP.test(v[k])) {
      i = k;
      break;
    }
  return { head: v.slice(0, i + 1), token: v.slice(i + 1).trim() };
};

const quote = (n: string) => (/[()<>,;:"@[\]]/.test(n) ? `"${n.replace(/"/g, "")}"` : n);

export const formatContact = (c: Contact) => (c.name ? `${quote(c.name)} <${c.email}>` : c.email);

let harvested = false;

export function harvestContacts() {
  if (harvested) return;
  harvested = true;
  api.contactsHarvest().catch(() => {
    harvested = false;
  });
}

export default function AddrInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [items, setItems] = useState<Contact[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const lookup = (v: string) => {
    const { token } = tail(v);
    const id = ++seq.current;
    window.clearTimeout(timer.current);
    if (!token || token.includes("<") || /@.+\./.test(token)) {
      setOpen(false);
      return;
    }
    let local: Contact[] = [];
    api
      .contactsSearch(token)
      .then((r) => {
        if (id !== seq.current) return;
        local = r;
        setItems(r);
        setActive(0);
        setOpen(r.length > 0);
      })
      .catch(() => undefined);
    timer.current = window.setTimeout(() => {
      api
        .contactsDirectory(token)
        .then((dir) => {
          if (id !== seq.current || !dir.length) return;
          const have = new Set(local.map((c) => c.email));
          const merged = [...local, ...dir.filter((c) => !have.has(c.email))];
          setItems(merged);
          setOpen(true);
        })
        .catch(() => undefined);
    }, 280);
  };

  const change = (v: string) => {
    onChange(v);
    lookup(v);
  };

  const pick = (c: Contact) => {
    const { head } = tail(value);
    const prefix = head ? head.replace(/\s*$/, "") + " " : "";
    onChange(prefix + formatContact(c) + "; ");
    seq.current++;
    setOpen(false);
    input.current?.focus();
  };

  const key = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || !items.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + items.length) % items.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pick(items[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <label className="mc-row addr">
      <span>{label}</span>
      <input
        ref={input}
        value={value}
        onChange={(e) => change(e.target.value)}
        onKeyDown={key}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
      />
      {open && items.length > 0 && (
        <div className="addr-pop" ref={list} role="listbox">
          {items.map((c, i) => (
            <div
              key={c.email}
              data-i={i}
              role="option"
              aria-selected={i === active}
              className={"addr-opt" + (i === active ? " on" : "")}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(c);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="addr-name">{c.name || c.email}</span>
              {c.dept && <span className="addr-dept">（{c.dept}）</span>}
              {c.name && <span className="addr-mail">{c.email}</span>}
            </div>
          ))}
        </div>
      )}
    </label>
  );
}
