// Apple Fitness–style three concentric rings.
// effort, accuracy, speed are 0–1 floats; values > 1 still render as full ring.

export const RING_COLORS = {
  effort:   "#fa3e3e", // Apple Move red
  accuracy: "#9aff00", // Apple Exercise green
  speed:    "#3bc1f3", // Apple Stand blue
};

const TRACK_ALPHA = 0.18;

function track(color) {
  // Convert hex to rgba(low alpha) for the unfilled track
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${TRACK_ALPHA})`;
}

export function Rings({
  effort = 0,
  accuracy = 0,
  speed = 0,
  size = 200,
  stroke = 16,
  gap = 6,
}) {
  const cx = size / 2;
  const cy = size / 2;
  const rings = [
    { value: effort,   color: RING_COLORS.effort },
    { value: accuracy, color: RING_COLORS.accuracy },
    { value: speed,    color: RING_COLORS.speed },
  ];

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {rings.map((ring, i) => {
        const radius = size / 2 - stroke / 2 - i * (stroke + gap);
        if (radius <= 0) return null;
        const circumference = 2 * Math.PI * radius;
        const v = Math.min(1, Math.max(0, ring.value));
        const dash = circumference * v;
        return (
          <g key={i} transform={`rotate(-90 ${cx} ${cy})`}>
            <circle
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke={track(ring.color)}
              strokeWidth={stroke}
            />
            <circle
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke={ring.color}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${dash} ${circumference}`}
              style={{
                transition:
                  "stroke-dasharray 320ms cubic-bezier(0.2, 0.8, 0.2, 1)",
              }}
            />
          </g>
        );
      })}
    </svg>
  );
}

export function RingsLegend() {
  return (
    <div className="rings-legend">
      <div className="legend-item">
        <span className="dot" style={{ background: RING_COLORS.effort }} />
        Effort
      </div>
      <div className="legend-item">
        <span className="dot" style={{ background: RING_COLORS.accuracy }} />
        Accuracy
      </div>
      <div className="legend-item">
        <span className="dot" style={{ background: RING_COLORS.speed }} />
        Speed
      </div>
    </div>
  );
}
