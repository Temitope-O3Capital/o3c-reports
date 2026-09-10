// Endpoint value label for trend charts.
//
// O3 trend charts drop the Y-axis scale and instead stamp ONE reference figure — the
// latest value — at the end of each line/area. This keeps the chart clean and legible
// whether the range holds 7 points or 365, where a label on every point would overlap
// into an unreadable pile. Exact per-point values still come from the hover tooltip.
//
// Use as the `content` of a recharts <LabelList> on an <Area>/<Line>:
//   const lastIdx = data.length - 1
//   <Area dataKey="Inbound" ...><LabelList dataKey="Inbound" content={endpointLabel(BLUE, lastIdx)} /></Area>
export function endpointLabel(color: string, lastIdx: number, format?: (v: number) => string) {
  return (props: any) => {
    const { x, y, value, index } = props
    if (index !== lastIdx || value == null || x == null || y == null) return null
    const text = format ? format(Number(value)) : Number(value).toLocaleString()
    return (
      <text x={x} y={y} dx={6} dy={4} fill={color} fontSize={11} fontWeight={700} textAnchor="start">{text}</text>
    )
  }
}
