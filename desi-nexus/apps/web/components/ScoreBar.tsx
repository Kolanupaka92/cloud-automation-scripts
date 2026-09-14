import type { ScoreBreakdown } from "@/lib/api";

const PARTS: Array<[keyof ScoreBreakdown, string]> = [
  ["cultural", "Cultural fit"],
  ["proximity", "Distance"],
  ["budget", "Budget"],
  ["language", "Language"],
  ["reputation", "Track record"],
  ["responsiveness", "Replies fast"],
];

/**
 * A match score with its components shown.
 *
 * The number on its own is an assertion; the breakdown is the reason. A host
 * deciding between two vendors needs to see that one won on cultural fit and
 * the other on price, not just that one scored 94 and the other 88.
 */
export function ScoreBar({ score, breakdown }: { score: number; breakdown?: ScoreBreakdown }) {
  return (
    <div>
      <div className="spread" style={{ marginBottom: 5 }}>
        <span className="faint">Match</span>
        <strong>{score}</strong>
      </div>
      <div className="meter" aria-label={`Match score ${score} out of 100`}>
        <i style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
      </div>
      {breakdown && (
        <details style={{ marginTop: 8 }}>
          <summary className="faint" style={{ cursor: "pointer" }}>
            Why this score
          </summary>
          <div className="breakdown" style={{ marginTop: 8 }}>
            {PARTS.map(([key, name]) => (
              <span key={key} style={{ display: "contents" }}>
                <span className="faint">{name}</span>
                <span>{Math.round((breakdown[key] ?? 0) * 100)}%</span>
              </span>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
