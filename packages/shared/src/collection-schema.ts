import type { CollectionData, CollectionProperty, CollectionRow } from "./collection-types";

export const MULTI_VALUE_SEPARATOR = "\u001f";

export function createDefaultCollectionData(customTitle = "컬렉션"): CollectionData {
  return {
    schemaVersion: 2,
    title: customTitle,
    activeViewId: "view-table",
    views: [
      {
        id: "view-table",
        name: "표",
        mode: "table",
        statusFilter: "all",
        tagFilter: "all",
        sortBy: "manual",
        sortDirection: "asc",
        hideCompleted: false,
      },
    ],
    tagOptions: [],
    properties: [],
    rows: [],
  };
}

const STATUS_LABELS: Record<string, string> = {
  todo: "시작 전",
  in_progress: "진행 중",
  review: "검토 중",
  done: "완료",
};

/** Preserve data from collections created before properties became configurable. */
export function migrateLegacyCollectionData(data: CollectionData): CollectionData {
  if (data.schemaVersion === 2) return data;

  const hasBoard = data.views.some((view) => view.mode === "board");
  const hasCalendar = data.views.some((view) => view.mode === "calendar");
  const used = {
    status:
      hasBoard ||
      data.views.some((view) => view.statusFilter !== "all" || view.sortBy === "status") ||
      data.rows.some((row) => row.status && row.status !== "todo"),
    tags:
      data.views.some((view) => view.tagFilter !== "all") ||
      data.rows.some((row) => (row.tags?.length ?? 0) > 0),
    date:
      hasCalendar ||
      data.views.some((view) => view.sortBy === "date") ||
      data.rows.some((row) => Boolean(row.date)),
    checked: data.rows.some((row) => row.checked),
    text: data.rows.some((row) => Boolean(row.text)),
  };
  const additions: CollectionProperty[] = [];
  if (used.status) {
    additions.push({
      id: "legacy-status",
      name: "상태",
      type: "select",
      options: Object.values(STATUS_LABELS),
    });
  }
  if (used.tags) {
    additions.push({
      id: "legacy-tags",
      name: "태그",
      type: "multi_select",
      options: data.tagOptions.map((tag) => tag.label),
    });
  }
  if (used.date) additions.push({ id: "legacy-date", name: "날짜", type: "date" });
  if (used.checked) additions.push({ id: "legacy-checked", name: "완료", type: "checkbox" });
  if (used.text) additions.push({ id: "legacy-text", name: "메모", type: "text" });

  const existingIds = new Set(data.properties.map((property) => property.id));
  const properties = [
    ...data.properties,
    ...additions.filter((property) => !existingIds.has(property.id)),
  ];
  const tagLabels = new Map(data.tagOptions.map((tag) => [tag.id, tag.label]));
  const rows: CollectionRow[] = data.rows.map((row) => ({
    id: row.id,
    title: row.title,
    ...(row.icon ? { icon: row.icon } : {}),
    ...(row.linkedPageId ? { linkedPageId: row.linkedPageId } : {}),
    values: {
      ...row.values,
      ...(used.status && row.values?.["legacy-status"] === undefined
        ? { "legacy-status": STATUS_LABELS[row.status ?? "todo"] ?? "시작 전" }
        : {}),
      ...(used.tags && row.values?.["legacy-tags"] === undefined
        ? {
            "legacy-tags": (row.tags ?? [])
              .map((tag) => tagLabels.get(tag))
              .filter(Boolean)
              .join(MULTI_VALUE_SEPARATOR),
          }
        : {}),
      ...(used.date && row.values?.["legacy-date"] === undefined ? { "legacy-date": row.date ?? "" } : {}),
      ...(used.checked && row.values?.["legacy-checked"] === undefined
        ? { "legacy-checked": Boolean(row.checked) }
        : {}),
      ...(used.text && row.values?.["legacy-text"] === undefined ? { "legacy-text": row.text ?? "" } : {}),
    },
  }));
  return {
    ...data,
    schemaVersion: 2,
    properties,
    rows,
    views: data.views.map((view) => ({
      ...view,
      groupBy: view.mode === "board" && used.status ? "legacy-status" : view.groupBy,
      datePropertyId: view.mode === "calendar" && used.date ? "legacy-date" : view.datePropertyId,
      propertyFilterId:
        view.statusFilter !== "all" && used.status
          ? "legacy-status"
          : view.tagFilter !== "all" && used.tags
            ? "legacy-tags"
            : view.propertyFilterId,
      propertyFilterValue:
        view.statusFilter !== "all" && used.status
          ? STATUS_LABELS[view.statusFilter]
          : view.tagFilter !== "all" && used.tags
            ? tagLabels.get(view.tagFilter) ?? ""
            : view.propertyFilterValue,
      sortBy:
        view.sortBy === "status" && used.status
          ? "legacy-status"
          : view.sortBy === "date" && used.date
            ? "legacy-date"
            : view.sortBy,
    })),
  };
}
