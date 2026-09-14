"use client";

import { useState } from "react";
import { label } from "@/lib/format";

/**
 * A capped multi-select. Hosts who tag a brief with everything get matched with
 * nobody in particular, so the cap is a product decision rather than a UI one.
 */
/**
 * `label` is imported here rather than passed in: a function cannot cross the
 * server/client boundary, and React refuses to serialise one. The helper is
 * pure and has no server-only imports, so the client can own it.
 */
export function CheckGroup({
  name,
  options,
  max,
  defaultSelected = [],
}: {
  name: string;
  options: string[];
  max?: number;
  defaultSelected?: string[];
}) {
  const [selected, setSelected] = useState<string[]>(defaultSelected);
  const atCap = max !== undefined && selected.length >= max;

  return (
    <>
      <div className="row" style={{ gap: 8 }}>
        {options.map((option) => {
          const on = selected.includes(option);
          return (
            <label
              key={option}
              className={`pill ${on ? "tag" : "plain"}`}
              style={{
                cursor: atCap && !on ? "not-allowed" : "pointer",
                opacity: atCap && !on ? 0.45 : 1,
                userSelect: "none",
              }}
            >
              <input
                type="checkbox"
                name={name}
                value={option}
                checked={on}
                disabled={atCap && !on}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, option]
                      : current.filter((value) => value !== option),
                  )
                }
                style={{ width: "auto", marginRight: 6, accentColor: "var(--maroon)" }}
              />
              {label(option)}
            </label>
          );
        })}
      </div>
      {max !== undefined && (
        <p className="hint">
          {selected.length} of {max} selected.
          {atCap ? " Deselect one to choose another." : ""}
        </p>
      )}
    </>
  );
}
