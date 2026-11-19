import { useEffect, useRef } from "react";
import { init, use, type ComposeOption, type EChartsType } from "echarts/core";
import { BarChart, LineChart, PieChart, type BarSeriesOption, type LineSeriesOption, type PieSeriesOption } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  type GridComponentOption,
  type LegendComponentOption,
  type TooltipComponentOption,
} from "echarts/components";
import { SVGRenderer } from "echarts/renderers";

// 쓰는 것만 등록해 번들을 줄인다. SVG 렌더러는 글자가 선명하고 확대해도 깨지지 않는다.
use([BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, SVGRenderer]);

export type EChartOption = ComposeOption<
  BarSeriesOption | LineSeriesOption | PieSeriesOption | GridComponentOption | LegendComponentOption | TooltipComponentOption
>;

/** ECharts 얇은 래퍼: 옵션이 바뀌면 다시 그리고 크기가 바뀌면 맞춘다 */
export function EChart({ option, height }: { option: EChartOption; height: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);

  useEffect(() => {
    const host = hostRef.current!;
    const chart = init(host, undefined, { renderer: "svg" });
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(host);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={hostRef} style={{ width: "100%", height }} />;
}
