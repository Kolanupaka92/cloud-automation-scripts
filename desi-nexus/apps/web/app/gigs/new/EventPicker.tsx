"use client";

import { useState } from "react";
import { label } from "@/lib/format";

/**
 * Event type first, speciality second.
 *
 * Choosing the occasion narrows which crew the brief is even about, and the
 * suggested specialities below come from what that function customarily needs
 * -- so a first-time host does not discover at the Sangeet that nobody booked
 * a choreographer.
 */
const CUSTOMARY: Record<string, string[]> = {
  mehndi: ["henna_artist", "photographer", "mua"],
  haldi: ["photographer", "decorator", "mua"],
  sangeet: ["choreographer", "dj", "photographer", "videographer", "mua"],
  baraat: ["dhol_player", "photographer", "videographer"],
  hindu_ceremony: ["priest_pandit", "photographer", "videographer", "decorator", "mua"],
  nikah: ["photographer", "videographer", "decorator", "mua"],
  reception: ["photographer", "videographer", "dj", "mua", "decorator"],
  griha_pravesham: ["priest_pandit", "photographer", "caterer"],
  half_saree_function: ["mua", "photographer", "saree_draper", "decorator"],
  mundan_child_carnival: ["priest_pandit", "photographer", "decorator"],
  garba_navratri: ["dj", "live_musician", "photographer", "choreographer"],
  boutique_lookbook: ["photographer", "mua", "hair_stylist", "saree_draper"],
  brand_campaign_shoot: ["photographer", "videographer", "mua", "drone_operator"],
  corporate_diwali: ["event_planner", "decorator", "dj", "caterer", "photographer"],
};

export function EventPicker({
  groups,
  specialties,
}: {
  groups: Record<string, string[]>;
  specialties: string[];
}) {
  const [eventType, setEventType] = useState("");
  const suggested = CUSTOMARY[eventType] ?? [];

  return (
    <>
      <div className="field">
        <label htmlFor="eventType">What is the occasion?</label>
        <select
          id="eventType"
          name="eventType"
          required
          value={eventType}
          onChange={(event) => setEventType(event.target.value)}
        >
          <option value="" disabled>
            Choose the function
          </option>
          {Object.entries(groups).map(([group, events]) => (
            <optgroup key={group} label={label(group)}>
              {events.map((event) => (
                <option key={event} value={event}>
                  {label(event)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="specialty">Who do you need?</label>
        <select id="specialty" name="specialty" required defaultValue="">
          <option value="" disabled>
            Choose a speciality
          </option>
          {suggested.length > 0 && (
            <optgroup label="Usually needed for this function">
              {suggested.map((code) => (
                <option key={code} value={code}>
                  {label(code)}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label={suggested.length > 0 ? "Everyone else" : "All specialities"}>
            {specialties
              .filter((code) => !suggested.includes(code))
              .map((code) => (
                <option key={code} value={code}>
                  {label(code)}
                </option>
              ))}
          </optgroup>
        </select>
        {suggested.length > 0 && (
          <p className="hint">
            A {label(eventType)} usually needs: {suggested.map(label).join(", ")}. Post one gig
            per role.
          </p>
        )}
      </div>
    </>
  );
}
