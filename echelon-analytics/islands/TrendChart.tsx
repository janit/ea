import { useSignal } from "@preact/signals";

interface TrendPoint {
  date: string;
  visits: number;
  visitors: number;
}

interface Props {
  data: TrendPoint[];
}

export default function TrendChart({ data }: Props) {
  const hovered = useSignal<number | null>(null);

  if (!data.length) {
    return <p class="text-[var(--ea-muted)] text-sm">No trend data.</p>;
  }

  const maxVal = Math.max(...data.map((d) => d.visits), 1);
  const W = 600;
  const H = 160;
  const barW = Math.max(4, (W - data.length * 2) / data.length);
  const gap = 2;

  return (
    <div style="overflow-x: auto">
      <svg
        viewBox={`0 0 ${W} ${H + 30}`}
        class="w-full h-auto"
        role="img"
        aria-label={`Daily views, ${data[0].date} to ${
          data[data.length - 1].date
        }`}
      >
        {data.map((d, i) => {
          const x = i * (barW + gap);
          const barH = Math.max(1, (d.visits / maxVal) * H);
          const y = H - barH;
          const isHovered = hovered.value === i;
          return (
            <g
              key={d.date}
              onMouseEnter={() => (hovered.value = i)}
              onMouseLeave={() => (hovered.value = null)}
              onClick={() => (hovered.value = i)}
            >
              <rect
                x={x}
                y={y}
                width={barW}
                height={barH}
                fill={isHovered ? "var(--ea-primary-hover)" : "var(--ea-text)"}
                rx={1}
              />
              {isHovered && (
                <text
                  x={x + barW / 2}
                  y={y - 4}
                  text-anchor="middle"
                  font-size="10"
                  fill="var(--ea-primary)"
                  font-family="'Courier New', monospace"
                >
                  {d.visits}
                </text>
              )}
              {i % Math.max(1, Math.floor(data.length / 8)) === 0 && (
                <text
                  x={x + barW / 2}
                  y={H + 16}
                  text-anchor="middle"
                  font-size="9"
                  fill="var(--ea-muted)"
                  font-family="'Courier New', monospace"
                >
                  {d.date.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hovered.value !== null && (
        <div class="text-xs text-[var(--ea-text)] mt-1">
          {data[hovered.value].date}: {data[hovered.value].visits} views,{" "}
          {data[hovered.value].visitors} visitors
        </div>
      )}
    </div>
  );
}
