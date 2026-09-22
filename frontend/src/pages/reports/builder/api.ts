import { apiFetch, apiExport, type ExportResult } from '../../../lib/api'
import type { PivotResult } from './model'

// respond() on the server wraps payloads as { data: … }; some routes return them bare.
export function unwrap<T>(r: any): T {
  return (r && typeof r === 'object' && !Array.isArray(r) && 'data' in r ? r.data : r) as T
}

const post = (path: string, body: unknown, signal?: AbortSignal) =>
  apiFetch(path, { method: 'POST', body: JSON.stringify(body), signal })

export interface TableResponse {
  columns: { key: string; label: string; type: string }[]
  rows: Record<string, any>[]
  total: number
  totals: Record<string, any> | null
  offset: number
  limit: number
}
export async function fetchTable(dsKey: string, body: unknown, signal?: AbortSignal): Promise<TableResponse> {
  return unwrap<TableResponse>(await post(`/api/reports/datasets/${encodeURIComponent(dsKey)}/table`, body, signal))
}

export interface UniquesResponse {
  column: string
  values: { value: string | null; count: number }[]
  distinct_total: number
  more: boolean
}
export async function fetchUniques(dsKey: string, body: unknown, signal?: AbortSignal): Promise<UniquesResponse> {
  return unwrap<UniquesResponse>(await post(`/api/reports/datasets/${encodeURIComponent(dsKey)}/uniques`, body, signal))
}

export async function fetchPivot(dsKey: string, body: unknown, signal?: AbortSignal): Promise<PivotResult> {
  return unwrap<PivotResult>(await post(`/api/reports/datasets/${encodeURIComponent(dsKey)}/pivot`, body, signal))
}

// The open report as a file, rendered by the server exactly as emails and schedules are.
export function downloadReport(format: 'xlsx' | 'csv', name: string, dataset: string, config: unknown): Promise<ExportResult> {
  return apiExport(`/api/reports/report-file?format=${format}`, { method: 'POST', body: { name, dataset, config }, fallbackName: name })
}

export interface ReportJson {
  columns: { key: string; label: string; type: string }[]
  data: Record<string, any>[]
  row_count: number
}
// The same render as json, for the PDF. Not unwrapped: the payload's own rows are `data`.
export function fetchReportJson(name: string, dataset: string, config: unknown): Promise<ReportJson> {
  return apiFetch<ReportJson>('/api/reports/report-file?format=json', {
    method: 'POST', body: JSON.stringify({ name, dataset, config }), timeoutMs: 120_000,
  })
}
