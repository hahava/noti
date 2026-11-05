export type CollectionStatus = "todo" | "in_progress" | "review" | "done";
export type CollectionViewMode = "table" | "board" | "calendar" | "gallery" | "list";
export type CollectionSortBy = "manual" | "title" | "date" | "status" | string;
export type CollectionSortDirection = "asc" | "desc";
export type CollectionOptionColor = "gray" | "blue" | "green" | "amber" | "purple" | "rose";

export type CollectionFilterOperator =
  | "contains"
  | "not_contains"
  | "equals"
  | "not_equals"
  | "gt"
  | "lt"
  | "is_empty"
  | "is_not_empty"
  | "is_checked"
  | "is_not_checked";

export interface CollectionFilterRule {
  propertyId: string;
  operator: CollectionFilterOperator;
  value: string;
}

export interface CollectionSortRule {
  propertyId: string;
  direction: CollectionSortDirection;
}

export type CollectionCalculationType =
  | "none"
  | "count_all"
  | "count_values"
  | "count_empty"
  | "count_unique"
  | "percent_checked"
  | "percent_unchecked"
  | "sum"
  | "average"
  | "min"
  | "max";

export interface CollectionView {
  id: string;
  name: string;
  mode: CollectionViewMode;
  statusFilter: CollectionStatus | "all";
  tagFilter: string | "all";
  propertyFilterId?: string;
  propertyFilterValue?: string;
  sortBy: CollectionSortBy;
  sortDirection: CollectionSortDirection;
  sorts?: CollectionSortRule[];
  hideCompleted: boolean;
  groupBy?: string;
  collapsedGroups?: string[];
  datePropertyId?: string;
  hiddenPropertyIds?: string[];
  filters?: CollectionFilterRule[];
  filterMode?: "and" | "or";
  peekMode?: "side" | "center";
  showTitle?: boolean;
  titleWidth?: number;
  boardColumnWidth?: number;
  galleryCardWidth?: number;
  peekWidth?: number;
  peekLabelWidth?: number;
}

export interface CollectionTagOption {
  id: string;
  label: string;
  color: CollectionOptionColor;
}

export interface CollectionRow {
  id: string;
  title: string;
  icon?: string;
  status?: CollectionStatus;
  tags?: string[];
  date?: string;
  checked?: boolean;
  text?: string;
  linkedPageId?: string;
  values?: Record<string, string | boolean>;
}

export type CollectionPropertyType =
  | "text"
  | "number"
  | "select"
  | "status"
  | "multi_select"
  | "date"
  | "checkbox"
  | "url"
  | "email"
  | "phone"
  | "relation"
  | "rollup"
  | "formula";

export interface CollectionProperty {
  id: string;
  name: string;
  type: CollectionPropertyType;
  options?: string[];
  optionColors?: Record<string, CollectionOptionColor>;
  width?: number;
  calculation?: CollectionCalculationType;
  numberFormat?: "number" | "comma" | "krw" | "usd" | "percent";
  relationCollectionId?: string;
  rollupRelationId?: string;
  rollupPropertyId?: string;
  rollupFunction?: "count" | "sum" | "average" | "min" | "max" | "show_unique";
  formula?: string;
}

export interface CollectionTemplate {
  id: string;
  name: string;
  icon?: string;
  defaultTitle?: string;
  values?: Record<string, string | boolean>;
}

export interface CollectionData {
  collectionId?: string;
  schemaVersion?: 2;
  title: string;
  icon?: string;
  activeViewId: string;
  views: CollectionView[];
  tagOptions: CollectionTagOption[];
  properties: CollectionProperty[];
  rows: CollectionRow[];
  templates?: CollectionTemplate[];
}
