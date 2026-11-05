import { MULTI_VALUE_SEPARATOR } from "./collection-schema";
import type {
  CollectionCalculationType,
  CollectionData,
  CollectionProperty,
  CollectionRow,
} from "./collection-types";

export type ComputedValue = string | number | boolean;
type Collections = Record<string, CollectionData>;

function relatedRows(data: CollectionData, row: CollectionRow, relation: CollectionProperty, collections: Collections): CollectionRow[] {
  const target = relation.relationCollectionId === data.collectionId
    ? data : collections[relation.relationCollectionId ?? ""];
  if (!target) return [];
  const ids = new Set(String(row.values?.[relation.id] ?? "").split(MULTI_VALUE_SEPARATOR).filter(Boolean));
  return target.rows.filter((item) => ids.has(item.id));
}

export function computePropertyValue(
  data: CollectionData,
  row: CollectionRow,
  property: CollectionProperty,
  collections: Collections = {},
  visiting = new Set<string>(),
): ComputedValue {
  const key = `${data.collectionId ?? "local"}:${row.id}:${property.id}`;
  if (visiting.has(key)) return "#CYCLE";
  visiting.add(key);
  try {
    if (property.type === "relation") {
      return relatedRows(data, row, property, collections).map((item) => item.title || "제목 없음").join(", ");
    }
    if (property.type === "rollup") {
      const relation = data.properties.find((item) => item.id === property.rollupRelationId && item.type === "relation");
      if (!relation) return "";
      const target = relation.relationCollectionId === data.collectionId
        ? data : collections[relation.relationCollectionId ?? ""];
      if (!target) return "";
      const linked = relatedRows(data, row, relation, collections);
      if (property.rollupFunction === "count") return linked.length;
      const targetProperty = target.properties.find((item) => item.id === property.rollupPropertyId);
      const values = linked.map((item) => property.rollupPropertyId === "title" ? item.title
        : targetProperty ? computePropertyValue(target, item, targetProperty, collections, visiting) : "");
      if (property.rollupFunction === "show_unique") return [...new Set(values.map(String).filter(Boolean))].join(", ");
      const numbers = values.filter((value) => value !== "" && Number.isFinite(Number(value))).map(Number);
      if (property.rollupFunction === "sum") return numbers.reduce((sum, value) => sum + value, 0);
      if (property.rollupFunction === "average") return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : "";
      if (property.rollupFunction === "min") return numbers.length ? Math.min(...numbers) : "";
      if (property.rollupFunction === "max") return numbers.length ? Math.max(...numbers) : "";
      return values.map(String).filter(Boolean).join(", ");
    }
    if (property.type === "formula") {
      return evaluateFormula(property.formula ?? "", (name) => {
        if (name === "이름" || name === "title") return row.title;
        const referenced = data.properties.find((item) => item.name === name || item.id === name);
        return referenced ? computePropertyValue(data, row, referenced, collections, visiting) : "";
      });
    }
    const raw = row.values?.[property.id] ?? "";
    if (property.type === "number") {
      if (raw === "") return "";
      return Number.isFinite(Number(raw)) ? Number(raw) : "#ERROR";
    }
    return raw;
  } finally {
    visiting.delete(key);
  }
}

export function computeColumnCalculation(
  data: CollectionData,
  rows: CollectionRow[],
  property: CollectionProperty,
  calculation: CollectionCalculationType | undefined,
  collections: Collections = {},
): string {
  if (!calculation || calculation === "none") return "";
  if (calculation === "count_all") return `${rows.length}`;
  const computed = rows.map((row) => computePropertyValue(data, row, property, collections));
  const nonEmpty = computed.filter((val) => val !== "" && val !== false && val !== undefined);
  if (calculation === "count_values") return `${nonEmpty.length}`;
  if (calculation === "count_empty") return `${rows.length - nonEmpty.length}`;
  if (calculation === "count_unique") {
    const unique = new Set(nonEmpty.flatMap((val) => String(val).split(MULTI_VALUE_SEPARATOR).filter(Boolean)));
    return `${unique.size}`;
  }
  if (calculation === "percent_checked" || calculation === "percent_unchecked") {
    if (rows.length === 0) return "0%";
    const checkedCount = computed.filter((val) => val === true || val === "true").length;
    const target = calculation === "percent_checked" ? checkedCount : rows.length - checkedCount;
    return `${Math.round((target / rows.length) * 100)}%`;
  }
  const numbers = computed
    .filter((val) => val !== "" && typeof val !== "boolean" && Number.isFinite(Number(val)))
    .map(Number);
  if (numbers.length === 0) return "0";
  if (calculation === "sum") {
    const sum = numbers.reduce((acc, n) => acc + n, 0);
    return Number.isInteger(sum) ? String(sum) : sum.toFixed(2);
  }
  if (calculation === "average") {
    const avg = numbers.reduce((acc, n) => acc + n, 0) / numbers.length;
    return Number.isInteger(avg) ? String(avg) : avg.toFixed(2);
  }
  if (calculation === "min") return String(Math.min(...numbers));
  if (calculation === "max") return String(Math.max(...numbers));
  return "";
}

type Token = { type: "number" | "string" | "word" | "operator"; value: string };

function tokenize(source: string): Token[] {
  if (source.length > 500) throw new Error("Formula too long");
  const tokens: Token[] = [];
  const pattern = /\s*(?:(\d+(?:\.\d+)?)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|([A-Za-z_][A-Za-z_0-9]*)|(==|!=|>=|<=|[+\-*/(),><]))/gy;
  let position = 0;
  while (position < source.trimEnd().length) {
    pattern.lastIndex = position;
    const match = pattern.exec(source);
    if (!match) throw new Error("Invalid formula");
    position = pattern.lastIndex;
    tokens.push({
      type: match[1] ? "number" : match[2] ? "string" : match[3] ? "word" : "operator",
      value: match[1] ?? match[2] ?? match[3] ?? match[4],
    });
  }
  return tokens;
}

function truthy(value: ComputedValue): boolean {
  return value !== false && value !== "" && value !== 0 && value !== "#CYCLE" && value !== "#ERROR";
}

export function evaluateFormula(source: string, propertyValue: (name: string) => ComputedValue): ComputedValue {
  if (!source.trim()) return "";
  try {
    const tokens = tokenize(source);
    let index = 0;
    const peek = () => tokens[index]?.value;
    const take = () => tokens[index++]?.value;
    const expect = (value: string) => { if (take() !== value) throw new Error("Invalid formula"); };
    const primary = (): ComputedValue => {
      const token = tokens[index++];
      if (!token) throw new Error("Invalid formula");
      if (token.value === "(") {
        const value = comparison();
        expect(")");
        return value;
      }
      if (token.type === "number") return Number(token.value);
      if (token.type === "string") return token.value[0] === "'"
        ? token.value.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\")
        : JSON.parse(token.value);
      if (token.value === "true") return true;
      if (token.value === "false") return false;
      if (token.type !== "word" || peek() !== "(") throw new Error("Invalid formula");
      take();
      const args: ComputedValue[] = [];
      if (peek() !== ")") {
        do {
          args.push(comparison());
          if (peek() !== ",") break;
          take();
        } while (true);
      }
      expect(")");
      if (token.value === "prop") return propertyValue(String(args[0] ?? ""));
      if (token.value === "if") return truthy(args[0]) ? args[1] ?? "" : args[2] ?? "";
      if (token.value === "round") {
        const digits = Math.min(10, Math.max(0, Number(args[1] ?? 0)));
        return Number(Number(args[0] ?? 0).toFixed(digits));
      }
      if (token.value === "concat") return args.map(String).join("");
      if (token.value === "empty") return args[0] === "" || args[0] === undefined;
      if (token.value === "length") return String(args[0] ?? "").length;
      if (token.value === "upper") return String(args[0] ?? "").toUpperCase();
      if (token.value === "lower") return String(args[0] ?? "").toLowerCase();
      throw new Error("Unknown function");
    };
    const unary = (): ComputedValue => peek() === "-" ? (take(), -Number(unary())) : primary();
    const multiply = (): ComputedValue => {
      let value = unary();
      while (["*", "/"].includes(peek() ?? "")) {
        const operator = take();
        const right = unary();
        value = operator === "*" ? Number(value) * Number(right) : Number(value) / Number(right);
      }
      return value;
    };
    const add = (): ComputedValue => {
      let value = multiply();
      while (["+", "-"].includes(peek() ?? "")) {
        const operator = take();
        const right = multiply();
        value = operator === "+" && (typeof value === "string" || typeof right === "string")
          ? String(value) + String(right)
          : operator === "+" ? Number(value) + Number(right) : Number(value) - Number(right);
      }
      return value;
    };
    const comparison = (): ComputedValue => {
      let value = add();
      while (["==", "!=", ">", "<", ">=", "<="].includes(peek() ?? "")) {
        const operator = take();
        const right = add();
        const left = value;
        value = operator === "==" ? left === right : operator === "!=" ? left !== right
          : operator === ">" ? left > right : operator === "<" ? left < right
            : operator === ">=" ? left >= right : left <= right;
      }
      return value;
    };
    const result = comparison();
    return index === tokens.length && (typeof result !== "number" || Number.isFinite(result)) ? result : "#ERROR";
  } catch { return "#ERROR"; }
}
