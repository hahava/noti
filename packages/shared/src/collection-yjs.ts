import * as Y from "yjs";
import { migrateLegacyCollectionData, MULTI_VALUE_SEPARATOR } from "./collection-schema";
import type {
  CollectionCalculationType,
  CollectionData,
  CollectionFilterOperator,
  CollectionOptionColor,
  CollectionProperty,
  CollectionRow,
  CollectionSortRule,
  CollectionTagOption,
  CollectionTemplate,
  CollectionView,
} from "./collection-types";

type RecordMap = Y.Map<unknown>;

const VALID_FILTER_OPERATORS: CollectionFilterOperator[] = [
  "contains",
  "not_contains",
  "equals",
  "not_equals",
  "gt",
  "lt",
  "is_empty",
  "is_not_empty",
  "is_checked",
  "is_not_checked",
];

const VALID_OPTION_COLORS: CollectionOptionColor[] = [
  "gray",
  "blue",
  "green",
  "amber",
  "purple",
  "rose",
];

function mapOf(parent: RecordMap, key: string): Y.Map<RecordMap> {
  let value = parent.get(key);
  if (!(value instanceof Y.Map)) {
    value = new Y.Map<RecordMap>();
    parent.set(key, value);
  }
  return value as Y.Map<RecordMap>;
}

function orderOf(parent: RecordMap, key: string): Y.Array<string> {
  let value = parent.get(key);
  if (!(value instanceof Y.Array)) {
    value = new Y.Array<string>();
    parent.set(key, value);
  }
  return value as Y.Array<string>;
}

function textOf(parent: RecordMap, key: string): Y.Text {
  let value = parent.get(key);
  if (!(value instanceof Y.Text)) {
    value = new Y.Text();
    parent.set(key, value);
  }
  return value as Y.Text;
}

function editText(parent: RecordMap, key: string, before: string, after: string): void {
  if (before === after) return;
  const text = textOf(parent, key);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix++;
  const removeCount = before.length - prefix - suffix;
  const position = Math.min(prefix, text.length);
  if (removeCount > 0) text.delete(position, Math.min(removeCount, text.length - position));
  const inserted = after.slice(prefix, after.length - suffix);
  if (inserted) text.insert(position, inserted);
}

function syncOrder(order: Y.Array<string>, ids: string[]): void {
  const current = order.toArray();
  if (current.length === ids.length && current.every((id, index) => id === ids[index])) return;
  order.delete(0, order.length);
  if (ids.length) order.insert(0, ids);
}

function syncRelationIds(order: Y.Array<string>, ids: string[]): void {
  const next = new Set(ids);
  for (let index = order.length - 1; index >= 0; index--) {
    if (!next.has(order.get(index))) order.delete(index, 1);
  }
  const current = new Set(order.toArray());
  for (const id of ids) if (!current.has(id)) { order.push([id]); current.add(id); }
}

function orderedIds<T>(order: Y.Array<string> | undefined, records: Y.Map<T>): string[] {
  const ids = [...(order?.toArray() ?? []), ...Array.from(records.keys())];
  return Array.from(new Set(ids)).filter((id) => records.has(id));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function patchRecord<T extends { id: string }>(
  records: Y.Map<RecordMap>,
  order: Y.Array<string>,
  previous: T[],
  next: T[],
  patch: (record: RecordMap, before: T | undefined, after: T) => void,
): void {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const nextIds = new Set(next.map((item) => item.id));
  for (const item of previous) if (!nextIds.has(item.id)) records.delete(item.id);
  for (const item of next) {
    let record = records.get(item.id);
    if (!record) {
      record = new Y.Map<unknown>();
      records.set(item.id, record);
    }
    patch(record, previousById.get(item.id), item);
  }
  if (previous.map((item) => item.id).join("\u0000") !== next.map((item) => item.id).join("\u0000")) {
    syncOrder(order, next.map((item) => item.id));
  }
}

function patchView(record: RecordMap, before: CollectionView | undefined, after: CollectionView): void {
  for (const key of [
    "name",
    "mode",
    "statusFilter",
    "tagFilter",
    "propertyFilterId",
    "propertyFilterValue",
    "sortBy",
    "sortDirection",
    "hideCompleted",
    "groupBy",
    "datePropertyId",
    "filterMode",
    "peekMode",
    "showTitle",
    "titleWidth",
    "boardColumnWidth",
    "galleryCardWidth",
    "peekWidth",
    "peekLabelWidth",
  ] as const) {
    if (!before || before[key] !== after[key]) {
      if (after[key] === undefined) record.delete(key);
      else record.set(key, after[key]);
    }
  }
  if (!before || JSON.stringify(before.hiddenPropertyIds ?? []) !== JSON.stringify(after.hiddenPropertyIds ?? [])) {
    syncOrder(orderOf(record, "hiddenPropertyIds"), after.hiddenPropertyIds ?? []);
  }
  if (before?.collapsedGroups !== undefined || after.collapsedGroups !== undefined) {
    if (!after.collapsedGroups || after.collapsedGroups.length === 0) {
      record.delete("collapsedGroups");
    } else if (!before || JSON.stringify(before.collapsedGroups ?? []) !== JSON.stringify(after.collapsedGroups)) {
      syncOrder(orderOf(record, "collapsedGroups"), after.collapsedGroups);
    }
  }
  if (!before || JSON.stringify(before.filters ?? []) !== JSON.stringify(after.filters ?? [])) {
    record.set("filtersJson", JSON.stringify(after.filters ?? []));
  }
  if (before?.sorts !== undefined || after.sorts !== undefined) {
    if (!after.sorts || after.sorts.length === 0) {
      record.delete("sortsJson");
    } else if (!before || JSON.stringify(before.sorts ?? []) !== JSON.stringify(after.sorts)) {
      record.set("sortsJson", JSON.stringify(after.sorts));
    }
  }
}

function patchTag(record: RecordMap, before: CollectionTagOption | undefined, after: CollectionTagOption): void {
  if (!before || before.label !== after.label) editText(record, "label", before?.label ?? "", after.label);
  if (!before || before.color !== after.color) record.set("color", after.color);
}

function patchProperty(record: RecordMap, before: CollectionProperty | undefined, after: CollectionProperty): void {
  if (!before || before.name !== after.name) editText(record, "name", before?.name ?? "", after.name);
  if (!before || before.type !== after.type) record.set("type", after.type);
  if (!before || before.options?.join("\u0000") !== after.options?.join("\u0000")) {
    const options = orderOf(record, "options");
    syncOrder(options, after.options ?? []);
  }
  if (before?.optionColors !== undefined || after.optionColors !== undefined) {
    const nextColors = after.optionColors ?? {};
    if (Object.keys(nextColors).length === 0) {
      record.delete("optionColors");
    } else {
      let colorMap = record.get("optionColors");
      if (!(colorMap instanceof Y.Map)) {
        colorMap = new Y.Map<string>();
        record.set("optionColors", colorMap);
      }
      const yColors = colorMap as Y.Map<string>;
      const prevColors = before?.optionColors ?? {};
      for (const key of Object.keys(prevColors)) {
        if (!(key in nextColors)) yColors.delete(key);
      }
      for (const [opt, color] of Object.entries(nextColors)) {
        if (prevColors[opt] !== color) yColors.set(opt, color);
      }
    }
  }
  for (const key of ["relationCollectionId", "rollupRelationId", "rollupPropertyId", "rollupFunction", "formula", "width", "calculation", "numberFormat"] as const) {
    if (!before || before[key] !== after[key]) {
      if (after[key] === undefined || after[key] === "none") record.delete(key);
      else record.set(key, after[key]);
    }
  }
}

function readOptionColors(value: unknown): Record<string, CollectionOptionColor> | undefined {
  if (!(value instanceof Y.Map)) return undefined;
  const entries = Array.from(value.entries()).filter(
    ([k, v]) => typeof k === "string" && VALID_OPTION_COLORS.includes(v as CollectionOptionColor),
  ) as Array<[string, CollectionOptionColor]>;
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function readFilters(value: unknown): CollectionView["filters"] {
  if (typeof value !== "string") return [];
  try {
    const filters = JSON.parse(value);
    return Array.isArray(filters) ? filters.filter((item) =>
      item && typeof item.propertyId === "string" && typeof item.value === "string" &&
      VALID_FILTER_OPERATORS.includes(item.operator)) : [];
  } catch { return []; }
}

function readSorts(value: unknown): CollectionSortRule[] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const sorts = JSON.parse(value);
    if (!Array.isArray(sorts)) return undefined;
    const valid = sorts.filter(
      (item): item is CollectionSortRule =>
        Boolean(item && typeof item.propertyId === "string" && (item.direction === "asc" || item.direction === "desc")),
    );
    return valid.length > 0 ? valid : undefined;
  } catch {
    return undefined;
  }
}

function patchTemplate(record: RecordMap, before: CollectionTemplate | undefined, after: CollectionTemplate): void {
  editText(record, "name", before?.name ?? "", after.name);
  if (before?.defaultTitle !== undefined || after.defaultTitle !== undefined) {
    editText(record, "defaultTitle", before?.defaultTitle ?? "", after.defaultTitle ?? "");
    if (after.defaultTitle === undefined) record.delete("defaultTitle");
  }
  if (!before || before.icon !== after.icon) {
    if (!after.icon) record.delete("icon");
    else record.set("icon", after.icon);
  }
  let values = record.get("values");
  if (!(values instanceof Y.Map)) {
    values = new Y.Map<unknown>();
    record.set("values", values);
  }
  const valueMap = values as Y.Map<unknown>;
  const beforeValues = before?.values ?? {};
  const afterValues = after.values ?? {};
  for (const key of Object.keys(beforeValues)) if (!(key in afterValues)) valueMap.delete(key);
  for (const [key, value] of Object.entries(afterValues)) {
    if (beforeValues[key] === value) continue;
    valueMap.set(key, value);
  }
}

function patchRow(record: RecordMap, before: CollectionRow | undefined, after: CollectionRow, relationIds: Set<string>): void {
  editText(record, "title", before?.title ?? "", after.title);
  if (before?.text !== undefined || after.text !== undefined) {
    editText(record, "text", before?.text ?? "", after.text ?? "");
    if (after.text === undefined) record.delete("text");
  }
  for (const key of ["icon", "status", "date", "checked", "linkedPageId"] as const) {
    if (!before || before[key] !== after[key]) {
      if (after[key] === undefined || after[key] === "") record.delete(key);
      else record.set(key, after[key]);
    }
  }
  if (before?.tags !== undefined || after.tags !== undefined) {
    if (after.tags === undefined) record.delete("tags");
    else if (!before || before.tags?.join("\u0000") !== after.tags.join("\u0000")) {
      syncOrder(orderOf(record, "tags"), after.tags);
    }
  }
  let values = record.get("values");
  if (!(values instanceof Y.Map)) {
    values = new Y.Map<unknown>();
    record.set("values", values);
  }
  const valueMap = values as Y.Map<unknown>;
  const beforeValues = before?.values ?? {};
  const afterValues = after.values ?? {};
  for (const key of Object.keys(beforeValues)) if (!(key in afterValues)) valueMap.delete(key);
  for (const [key, value] of Object.entries(afterValues)) {
    if (beforeValues[key] === value) continue;
    if (relationIds.has(key)) {
      let entries = valueMap.get(key);
      if (!(entries instanceof Y.Array)) {
        entries = new Y.Array<string>();
        const previous = beforeValues[key];
        const previousIds = typeof previous === "string" ? previous.split(MULTI_VALUE_SEPARATOR).filter(Boolean) : [];
        if (previousIds.length) (entries as Y.Array<string>).push(previousIds);
        valueMap.set(key, entries);
      }
      syncRelationIds(entries as Y.Array<string>, String(value).split(MULTI_VALUE_SEPARATOR).filter(Boolean));
    } else if (typeof value === "boolean") {
      valueMap.set(key, value);
    } else {
      editText(valueMap, key, String(beforeValues[key] ?? ""), value);
    }
  }
}

export function collectionMap(doc: Y.Doc, blockId: string): RecordMap {
  return doc.getMap<unknown>(`collection:${blockId}`);
}

export function editCollectionRowText(
  map: RecordMap,
  rowId: string,
  field: "title" | "text",
  before: string,
  after: string,
): void {
  const row = (map.get("rows") as Y.Map<RecordMap> | undefined)?.get(rowId);
  if (!row) return;
  map.doc?.transact(() => editText(row, field, before, after));
}

export function editCollectionCellText(
  map: RecordMap,
  rowId: string,
  propertyId: string,
  before: string,
  after: string,
): void {
  const row = (map.get("rows") as Y.Map<RecordMap> | undefined)?.get(rowId);
  if (!row) return;
  map.doc?.transact(() => {
    let values = row.get("values");
    if (!(values instanceof Y.Map)) {
      values = new Y.Map<unknown>();
      row.set("values", values);
    }
    editText(values as Y.Map<unknown>, propertyId, before, after);
  });
}

export function initializeCollectionMap(map: RecordMap, initial: CollectionData): void {
  if (map.get("version") === 1) {
    if (map.get("schemaVersion") !== 2) {
      const current = readCollectionMap(map);
      if (current) patchCollectionMap(map, current, migrateLegacyCollectionData(current));
    }
    return;
  }
  map.doc?.transact(() => {
    if (map.get("version") === 1) return;
    patchCollectionMap(map, {
      title: "",
      activeViewId: "",
      views: [],
      tagOptions: [],
      properties: [],
      rows: [],
    }, initial);
    map.set("version", 1);
  });
}

export function patchCollectionMap(map: RecordMap, previous: CollectionData, next: CollectionData): void {
  map.doc?.transact(() => {
    if (next.collectionId) map.set("collectionId", next.collectionId);
    if (next.schemaVersion === 2) map.set("schemaVersion", 2);
    editText(map, "title", previous.title, next.title);
    if (previous.icon !== next.icon) {
      if (!next.icon) map.delete("icon");
      else map.set("icon", next.icon);
    }
    if (previous.activeViewId !== next.activeViewId) map.set("activeViewId", next.activeViewId);
    patchRecord(mapOf(map, "views"), orderOf(map, "viewOrder"), previous.views, next.views, patchView);
    patchRecord(mapOf(map, "tags"), orderOf(map, "tagOrder"), previous.tagOptions, next.tagOptions, patchTag);
    patchRecord(mapOf(map, "properties"), orderOf(map, "propertyOrder"), previous.properties, next.properties, patchProperty);
    if ((previous.templates?.length ?? 0) > 0 || (next.templates?.length ?? 0) > 0) {
      patchRecord(
        mapOf(map, "templates"),
        orderOf(map, "templateOrder"),
        previous.templates ?? [],
        next.templates ?? [],
        patchTemplate,
      );
    }
    const relationIds = new Set(next.properties.filter((property) => property.type === "relation").map((property) => property.id));
    patchRecord(mapOf(map, "rows"), orderOf(map, "rowOrder"), previous.rows, next.rows,
      (record, before, after) => patchRow(record, before, after, relationIds));
    const textProperties = next.properties.filter((property) => property.type === "text");
    const relationProperties = next.properties.filter((property) => property.type === "relation");
    const rows = mapOf(map, "rows");
    for (const row of next.rows) {
      const record = rows.get(row.id);
      if (!record) continue;
      const values = record.get("values") as Y.Map<unknown>;
      for (const property of textProperties) textOf(values, property.id);
      for (const property of relationProperties) {
        if (values.get(property.id) instanceof Y.Array) continue;
        const ids = String(row.values?.[property.id] ?? "").split(MULTI_VALUE_SEPARATOR).filter(Boolean);
        const entries = new Y.Array<string>();
        if (ids.length) entries.push(ids);
        values.set(property.id, entries);
      }
    }
  });
}

export function readCollectionMap(map: RecordMap): CollectionData | null {
  if (map.get("version") !== 1) return null;
  const views = map.get("views") as Y.Map<RecordMap> | undefined;
  const tags = map.get("tags") as Y.Map<RecordMap> | undefined;
  const properties = map.get("properties") as Y.Map<RecordMap> | undefined;
  const rows = map.get("rows") as Y.Map<RecordMap> | undefined;
  const templates = map.get("templates") as Y.Map<RecordMap> | undefined;
  const resultViews: CollectionView[] = views
    ? orderedIds(map.get("viewOrder") as Y.Array<string> | undefined, views).map((id) => {
        const value = views.get(id)!;
        const sorts = readSorts(value.get("sortsJson"));
        const collapsedGroups = (value.get("collapsedGroups") as Y.Array<string> | undefined)?.toArray();
        const peekMode = value.get("peekMode");
        const showTitle = value.get("showTitle");
        const titleWidth = value.get("titleWidth");
        const boardColumnWidth = value.get("boardColumnWidth");
        const galleryCardWidth = value.get("galleryCardWidth");
        const peekWidth = value.get("peekWidth");
        const peekLabelWidth = value.get("peekLabelWidth");
        return {
          id,
          name: stringValue(value.get("name")),
          mode: ["board", "calendar", "gallery", "list"].includes(String(value.get("mode")))
            ? value.get("mode") as CollectionView["mode"]
            : "table",
          statusFilter: stringValue(value.get("statusFilter")) as CollectionView["statusFilter"],
          tagFilter: stringValue(value.get("tagFilter")),
          propertyFilterId: stringValue(value.get("propertyFilterId")),
          propertyFilterValue: stringValue(value.get("propertyFilterValue")),
          sortBy: stringValue(value.get("sortBy")) as CollectionView["sortBy"],
          sortDirection: value.get("sortDirection") === "desc" ? "desc" : "asc",
          ...(sorts ? { sorts } : {}),
          hideCompleted: Boolean(value.get("hideCompleted")),
          groupBy: stringValue(value.get("groupBy")),
          ...(collapsedGroups && collapsedGroups.length > 0 ? { collapsedGroups } : {}),
          datePropertyId: stringValue(value.get("datePropertyId")),
          hiddenPropertyIds: (value.get("hiddenPropertyIds") as Y.Array<string> | undefined)?.toArray() ?? [],
          filters: readFilters(value.get("filtersJson")),
          filterMode: value.get("filterMode") === "or" ? "or" : "and",
          ...(peekMode === "side" || peekMode === "center" ? { peekMode } : {}),
          ...(typeof showTitle === "boolean" ? { showTitle } : {}),
          ...(typeof titleWidth === "number" && Number.isFinite(titleWidth) ? { titleWidth } : {}),
          ...(typeof boardColumnWidth === "number" && Number.isFinite(boardColumnWidth) ? { boardColumnWidth } : {}),
          ...(typeof galleryCardWidth === "number" && Number.isFinite(galleryCardWidth) ? { galleryCardWidth } : {}),
          ...(typeof peekWidth === "number" && Number.isFinite(peekWidth) ? { peekWidth } : {}),
          ...(typeof peekLabelWidth === "number" && Number.isFinite(peekLabelWidth) ? { peekLabelWidth } : {}),
        };
      })
    : [];
  const tagOptions: CollectionTagOption[] = tags
    ? orderedIds(map.get("tagOrder") as Y.Array<string> | undefined, tags).map((id) => {
        const value = tags.get(id)!;
        return {
          id,
          label: (value.get("label") as Y.Text | undefined)?.toString() ?? "",
          color: stringValue(value.get("color")) as CollectionTagOption["color"],
        };
      })
    : [];
  const resultProperties: CollectionProperty[] = properties
    ? orderedIds(map.get("propertyOrder") as Y.Array<string> | undefined, properties).map((id) => {
        const value = properties.get(id)!;
        const optionColors = readOptionColors(value.get("optionColors"));
        const width = value.get("width");
        const calculation = stringValue(value.get("calculation"));
        const numberFormat = stringValue(value.get("numberFormat"));
        return {
          id,
          name: (value.get("name") as Y.Text | undefined)?.toString() ?? "",
          type: stringValue(value.get("type")) as CollectionProperty["type"],
          options: (value.get("options") as Y.Array<string> | undefined)?.toArray() ?? [],
          ...(optionColors ? { optionColors } : {}),
          ...(typeof width === "number" && Number.isFinite(width) ? { width } : {}),
          ...(calculation && calculation !== "none" ? { calculation: calculation as CollectionCalculationType } : {}),
          ...(numberFormat ? { numberFormat: numberFormat as CollectionProperty["numberFormat"] } : {}),
          relationCollectionId: stringValue(value.get("relationCollectionId")),
          rollupRelationId: stringValue(value.get("rollupRelationId")),
          rollupPropertyId: stringValue(value.get("rollupPropertyId")),
          rollupFunction: stringValue(value.get("rollupFunction")) as CollectionProperty["rollupFunction"],
          formula: stringValue(value.get("formula")),
        };
      })
    : [];
  const resultRows: CollectionRow[] = rows
    ? orderedIds(map.get("rowOrder") as Y.Array<string> | undefined, rows).map((id) => {
        const value = rows.get(id)!;
        const icon = stringValue(value.get("icon"));
        return {
          id,
          title: (value.get("title") as Y.Text | undefined)?.toString() ?? "",
          ...(icon ? { icon } : {}),
          ...(value.has("status") ? { status: stringValue(value.get("status")) as CollectionRow["status"] } : {}),
          ...(value.has("tags") ? { tags: Array.from(new Set((value.get("tags") as Y.Array<string>).toArray())) } : {}),
          ...(value.has("date") ? { date: stringValue(value.get("date")) } : {}),
          ...(value.has("checked") ? { checked: Boolean(value.get("checked")) } : {}),
          ...(value.has("text") ? { text: (value.get("text") as Y.Text).toString() } : {}),
          values: Object.fromEntries(
            Array.from((value.get("values") as Y.Map<unknown> | undefined)?.entries() ?? [])
              .map(([key, cell]) => [key, cell instanceof Y.Text ? cell.toString()
                : cell instanceof Y.Array ? cell.toArray().join(MULTI_VALUE_SEPARATOR) : Boolean(cell)]),
          ),
          ...(value.get("linkedPageId") ? { linkedPageId: stringValue(value.get("linkedPageId")) } : {}),
        };
      })
    : [];
  const resultTemplates: CollectionTemplate[] = templates
    ? orderedIds(map.get("templateOrder") as Y.Array<string> | undefined, templates).map((id) => {
        const value = templates.get(id)!;
        const icon = stringValue(value.get("icon"));
        const defaultTitle = (value.get("defaultTitle") as Y.Text | undefined)?.toString();
        return {
          id,
          name: (value.get("name") as Y.Text | undefined)?.toString() ?? "",
          ...(icon ? { icon } : {}),
          ...(defaultTitle ? { defaultTitle } : {}),
          values: Object.fromEntries(
            Array.from((value.get("values") as Y.Map<unknown> | undefined)?.entries() ?? [])
              .map(([key, cell]) => [key, typeof cell === "boolean" ? cell : String(cell ?? "")]),
          ),
        };
      })
    : [];
  const activeViewId = stringValue(map.get("activeViewId"));
  const icon = stringValue(map.get("icon"));
  return {
    collectionId: stringValue(map.get("collectionId")) || undefined,
    schemaVersion: map.get("schemaVersion") === 2 ? 2 : undefined,
    title: (map.get("title") as Y.Text | undefined)?.toString() ?? "",
    ...(icon ? { icon } : {}),
    activeViewId: resultViews.some((view) => view.id === activeViewId)
      ? activeViewId
      : resultViews[0]?.id ?? "",
    views: resultViews,
    tagOptions,
    properties: resultProperties,
    rows: resultRows,
    ...(resultTemplates.length > 0 ? { templates: resultTemplates } : {}),
  };
}
