const RESERVED_IDENTIFIERS = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "arguments",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const words = (value: string): string[] =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);

const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();

export const toPascalCase = (value: string, fallback = "Generated"): string => {
  const parts = words(value);
  const fallbackParts = words(fallback);
  const identifier = (parts.length === 0 ? fallbackParts : parts).map(capitalize).join("") || "Generated";
  return /^\d/.test(identifier) ? `_${identifier}` : identifier;
};

export const toCamelCase = (value: string, fallback = "generated"): string => {
  const pascal = toPascalCase(value, fallback);
  const identifier = pascal.charAt(0).toLowerCase() + pascal.slice(1);
  return RESERVED_IDENTIFIERS.has(identifier) ? `${identifier}_` : identifier;
};
