import { createId } from "./id.js";

export class Collection {
  constructor(database, name) {
    if (!database) {
      throw new TypeError("Collection requires a database connection");
    }

    if (typeof name !== "string" || name.trim() === "") {
      throw new TypeError("Collection name must be a non-empty string");
    }

    this.database = database;
    this.name = name;
    this.tableName = quoteIdentifier(name);

    this.#createTable();
  }

  insertOne(document) {
    const record = prepareDocument(document);
    const statement = this.database.prepare(
      `INSERT INTO ${this.tableName} (_id, document) VALUES (?, ?)`,
    );

    statement.run(encodeId(record._id), stringifyDocument(record));

    return {
      acknowledged: true,
      insertedId: record._id,
    };
  }

  insertMany(documents) {
    if (!Array.isArray(documents)) {
      throw new TypeError("insertMany expects an array of documents");
    }

    const statement = this.database.prepare(
      `INSERT INTO ${this.tableName} (_id, document) VALUES (?, ?)`,
    );
    const insertedIds = {};

    const insertAll = this.database.transaction((records) => {
      for (const [index, document] of records.entries()) {
        const record = prepareDocument(document);
        statement.run(encodeId(record._id), stringifyDocument(record));
        insertedIds[index] = record._id;
      }
    });

    insertAll(documents);

    return {
      acknowledged: true,
      insertedCount: documents.length,
      insertedIds,
    };
  }

  find(query = {}, options = {}) {
    assertPlainObject(query, "find query");
    assertPlainObject(options, "find options");

    const sqlQuery = compileSelectSql(this.tableName, query, options);
    return this.database
      .prepare(sqlQuery.sql)
      .all(...sqlQuery.params)
      .map((row) => JSON.parse(row.document));
  }

  findOne(query = {}, options = {}) {
    return this.find(query, { ...options, limit: 1 })[0] ?? null;
  }

  updateOne(query, update, options = {}) {
    return this.#update(query, update, { upsert: options.upsert, limit: 1 });
  }

  updateMany(query, update, options = {}) {
    return this.#update(query, update, { upsert: options.upsert });
  }

  countDocuments(query = {}) {
    assertPlainObject(query, "countDocuments query");

    const compiledQuery = compileQuery(query);
    let sql = `SELECT COUNT(*) AS count FROM ${this.tableName}`;

    if (compiledQuery.sql) {
      sql += ` WHERE ${compiledQuery.sql}`;
    }

    return this.database.prepare(sql).get(...compiledQuery.params).count;
  }

  #update(query = {}, update, options = {}) {
    assertPlainObject(query, "update query");
    assertPlainObject(options, "update options");
    assertUpdateDocument(update);

    const selectQuery = compileSelectSql(
      this.tableName,
      query,
      {
        limit: options.limit,
      },
      "_id, document",
    );
    const updateStatement = this.database.prepare(
      `UPDATE ${this.tableName} SET document = ? WHERE _id = ?`,
    );
    const insertStatement = this.database.prepare(
      `INSERT INTO ${this.tableName} (_id, document) VALUES (?, ?)`,
    );

    const runUpdate = this.database.transaction(() => {
      const rows = this.database
        .prepare(selectQuery.sql)
        .all(...selectQuery.params);

      if (rows.length === 0) {
        if (!options.upsert) {
          return {
            acknowledged: true,
            matchedCount: 0,
            modifiedCount: 0,
            upsertedCount: 0,
            upsertedId: null,
          };
        }

        const upsertedDocument = prepareDocument(
          applyUpdate(buildUpsertDocument(query), update, { isInsert: true }),
        );
        insertStatement.run(
          encodeId(upsertedDocument._id),
          stringifyDocument(upsertedDocument),
        );

        return {
          acknowledged: true,
          matchedCount: 0,
          modifiedCount: 0,
          upsertedCount: 1,
          upsertedId: upsertedDocument._id,
        };
      }

      let modifiedCount = 0;

      for (const row of rows) {
        const document = JSON.parse(row.document);
        const originalJson = stringifyDocument(document);
        const updatedDocument = applyUpdate(document, update, {
          isInsert: false,
        });

        if (encodeId(updatedDocument._id) !== row._id) {
          throw new Error("Cannot update immutable field _id");
        }

        const updatedJson = stringifyDocument(updatedDocument);

        if (updatedJson !== originalJson) {
          updateStatement.run(updatedJson, row._id);
          modifiedCount += 1;
        }
      }

      return {
        acknowledged: true,
        matchedCount: rows.length,
        modifiedCount,
        upsertedCount: 0,
        upsertedId: null,
      };
    });

    return runUpdate();
  }

  #createTable() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        _id TEXT PRIMARY KEY,
        document TEXT NOT NULL CHECK (json_valid(document))
      )
    `);
  }
}

function compileSelectSql(
  tableName,
  query,
  options = {},
  columns = "document",
) {
  const compiledQuery = compileQuery(query);
  let sql = `SELECT ${columns} FROM ${tableName}`;
  const params = [...compiledQuery.params];

  if (compiledQuery.sql) {
    sql += ` WHERE ${compiledQuery.sql}`;
  }

  if (options.sort) {
    const compiledSort = compileSort(options.sort);
    sql += ` ORDER BY ${compiledSort.sql}`;
    params.push(...compiledSort.params);
  }

  if (options.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(normalizeNonNegativeInteger(options.limit, "limit"));
  }

  if (options.skip !== undefined) {
    if (options.limit === undefined) {
      sql += " LIMIT -1";
    }

    sql += " OFFSET ?";
    params.push(normalizeNonNegativeInteger(options.skip, "skip"));
  }

  return { sql, params };
}

function assertUpdateDocument(update) {
  assertPlainObject(update, "update");

  const entries = Object.entries(update);

  if (entries.length === 0) {
    throw new TypeError("update must include at least one operator");
  }

  if (!entries.every(([operator]) => operator.startsWith("$"))) {
    throw new TypeError("update must use operators like $set, $unset, or $inc");
  }

  for (const [operator, value] of entries) {
    if (!isSupportedUpdateOperator(operator)) {
      throw new Error(`Unsupported update operator: ${operator}`);
    }

    assertPlainObject(value, `${operator} value`);
  }
}

function isSupportedUpdateOperator(operator) {
  return [
    "$set",
    "$unset",
    "$inc",
    "$push",
    "$pull",
    "$addToSet",
    "$setOnInsert",
  ].includes(operator);
}

function applyUpdate(document, update, { isInsert }) {
  for (const [operator, changes] of Object.entries(update)) {
    if (operator === "$setOnInsert" && !isInsert) {
      continue;
    }

    switch (operator) {
      case "$set":
      case "$setOnInsert":
        applySet(document, changes);
        break;
      case "$unset":
        applyUnset(document, changes);
        break;
      case "$inc":
        applyInc(document, changes);
        break;
      case "$push":
        applyPush(document, changes);
        break;
      case "$pull":
        applyPull(document, changes);
        break;
      case "$addToSet":
        applyAddToSet(document, changes);
        break;
      default:
        throw new Error(`Unsupported update operator: ${operator}`);
    }
  }

  return document;
}

function applySet(document, changes) {
  for (const [path, value] of Object.entries(changes)) {
    assertMutablePath(path);
    setByPath(document, path, cloneJson(value));
  }
}

function applyUnset(document, changes) {
  for (const path of Object.keys(changes)) {
    assertMutablePath(path);
    deleteByPath(document, path);
  }
}

function applyInc(document, changes) {
  for (const [path, amount] of Object.entries(changes)) {
    assertMutablePath(path);

    if (typeof amount !== "number" || Number.isNaN(amount)) {
      throw new TypeError("$inc values must be numbers");
    }

    const field = getByPath(document, path);

    if (!field.exists) {
      setByPath(document, path, amount);
      continue;
    }

    if (typeof field.value !== "number") {
      throw new TypeError(`Cannot apply $inc to non-number field: ${path}`);
    }

    setByPath(document, path, field.value + amount);
  }
}

function applyPush(document, changes) {
  for (const [path, value] of Object.entries(changes)) {
    assertMutablePath(path);

    const field = getByPath(document, path);
    const values = valuesForArrayUpdate(value);

    if (!field.exists) {
      setByPath(document, path, values);
      continue;
    }

    if (!Array.isArray(field.value)) {
      throw new TypeError(`Cannot apply $push to non-array field: ${path}`);
    }

    field.value.push(...values);
  }
}

function applyAddToSet(document, changes) {
  for (const [path, value] of Object.entries(changes)) {
    assertMutablePath(path);

    const field = getByPath(document, path);
    const values = valuesForArrayUpdate(value);

    if (!field.exists) {
      setByPath(document, path, []);
    } else if (!Array.isArray(field.value)) {
      throw new TypeError(`Cannot apply $addToSet to non-array field: ${path}`);
    }

    const target = getByPath(document, path).value;

    for (const item of values) {
      if (!target.some((existing) => deepEqual(existing, item))) {
        target.push(item);
      }
    }
  }
}

function applyPull(document, changes) {
  for (const [path, criteria] of Object.entries(changes)) {
    assertMutablePath(path);

    const field = getByPath(document, path);

    if (!field.exists) {
      continue;
    }

    if (!Array.isArray(field.value)) {
      throw new TypeError(`Cannot apply $pull to non-array field: ${path}`);
    }

    setByPath(
      document,
      path,
      field.value.filter((item) => !matchesPullCriteria(item, criteria)),
    );
  }
}

function valuesForArrayUpdate(value) {
  if (isPlainObject(value) && Object.hasOwn(value, "$each")) {
    if (!Array.isArray(value.$each)) {
      throw new TypeError("$each must be an array");
    }

    const keys = Object.keys(value);
    if (keys.length !== 1) {
      throw new Error("Only $each is currently supported for array updates");
    }

    return cloneJson(value.$each);
  }

  return [cloneJson(value)];
}

function matchesPullCriteria(value, criteria) {
  if (!isOperatorObject(criteria)) {
    return deepEqual(value, criteria);
  }

  for (const [operator, expected] of Object.entries(criteria)) {
    switch (operator) {
      case "$eq":
        if (!deepEqual(value, expected)) return false;
        break;
      case "$ne":
        if (deepEqual(value, expected)) return false;
        break;
      case "$gt":
        if (!(value > expected)) return false;
        break;
      case "$gte":
        if (!(value >= expected)) return false;
        break;
      case "$lt":
        if (!(value < expected)) return false;
        break;
      case "$lte":
        if (!(value <= expected)) return false;
        break;
      case "$in":
        if (!Array.isArray(expected)) {
          throw new TypeError("$in expects an array");
        }
        if (!expected.some((item) => deepEqual(value, item))) return false;
        break;
      case "$nin":
        if (!Array.isArray(expected)) {
          throw new TypeError("$nin expects an array");
        }
        if (expected.some((item) => deepEqual(value, item))) return false;
        break;
      default:
        throw new Error(`Unsupported $pull operator: ${operator}`);
    }
  }

  return true;
}

function buildUpsertDocument(query) {
  const document = {};

  for (const [path, condition] of Object.entries(query)) {
    if (path.startsWith("$")) {
      continue;
    }

    if (!isOperatorObject(condition)) {
      setByPath(document, path, cloneJson(condition));
      continue;
    }

    if (Object.hasOwn(condition, "$eq")) {
      setByPath(document, path, cloneJson(condition.$eq));
    }
  }

  return document;
}

function assertMutablePath(path) {
  assertFieldPath(path);

  if (path === "_id" || path.startsWith("_id.")) {
    throw new Error("Cannot update immutable field _id");
  }
}

function assertFieldPath(path) {
  if (
    typeof path !== "string" ||
    path.trim() === "" ||
    path.split(".").some((part) => part === "")
  ) {
    throw new TypeError("field path must be a non-empty dot path");
  }
}

function getByPath(document, path) {
  assertFieldPath(path);

  const parts = path.split(".");
  let value = document;

  for (const part of parts) {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, part)
    ) {
      return { exists: false, value: undefined };
    }

    value = value[part];
  }

  return { exists: true, value };
}

function setByPath(document, path, value) {
  assertFieldPath(path);

  const parts = path.split(".");
  let target = document;

  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(target[part])) {
      target[part] = {};
    }

    target = target[part];
  }

  target[parts.at(-1)] = value;
}

function deleteByPath(document, path) {
  assertFieldPath(path);

  const parts = path.split(".");
  let target = document;

  for (const part of parts.slice(0, -1)) {
    if (
      target === null ||
      typeof target !== "object" ||
      !Object.hasOwn(target, part)
    ) {
      return;
    }

    target = target[part];
  }

  if (target !== null && typeof target === "object") {
    delete target[parts.at(-1)];
  }
}

function deepEqual(left, right) {
  if (Object.is(left, right)) {
    return true;
  }

  if (typeof left !== typeof right) {
    return false;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (
      !Array.isArray(left) ||
      !Array.isArray(right) ||
      left.length !== right.length
    ) {
      return false;
    }

    return left.every((value, index) => deepEqual(value, right[index]));
  }

  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) {
      return false;
    }

    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);

    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    return leftKeys.every(
      (key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]),
    );
  }

  return false;
}

function compileQuery(query) {
  assertPlainObject(query, "query");

  const fragments = [];
  const params = [];

  for (const [key, condition] of Object.entries(query)) {
    const fragment = compileQueryEntry(key, condition);
    fragments.push(fragment.sql);
    params.push(...fragment.params);
  }

  return {
    sql: fragments.join(" AND "),
    params,
  };
}

function compileQueryEntry(key, condition) {
  if (key === "$and") {
    return compileLogicalQuery("$and", condition, "AND", false);
  }

  if (key === "$or") {
    return compileLogicalQuery("$or", condition, "OR", false);
  }

  if (key === "$nor") {
    return compileLogicalQuery("$nor", condition, "OR", true);
  }

  if (key.startsWith("$")) {
    throw new Error(`Unsupported query operator: ${key}`);
  }

  return compileFieldCondition(key, condition);
}

function compileLogicalQuery(operator, condition, joiner, negate) {
  assertQueryArray(condition, operator);

  if (condition.length === 0) {
    return { sql: negate ? "1 = 1" : "1 = 0", params: [] };
  }

  const fragments = condition.map((childQuery) => compileQuery(childQuery));
  const sql = fragments
    .map((fragment) => `(${fragment.sql || "1 = 1"})`)
    .join(` ${joiner} `);
  const params = fragments.flatMap((fragment) => fragment.params);

  return {
    sql: negate ? `NOT (${sql})` : `(${sql})`,
    params,
  };
}

function compileFieldCondition(path, condition) {
  if (!isOperatorObject(condition)) {
    return compileEquality(path, condition);
  }

  const fragments = [];
  const params = [];

  for (const [operator, expected] of Object.entries(condition)) {
    if (operator === "$options") {
      continue;
    }

    const fragment = compileFieldOperator(path, operator, expected, condition);
    fragments.push(fragment.sql);
    params.push(...fragment.params);
  }

  if (fragments.length === 0) {
    throw new Error(`Operator query for ${path} did not include an operator`);
  }

  return {
    sql: fragments.map((fragment) => `(${fragment})`).join(" AND "),
    params,
  };
}

function compileFieldOperator(path, operator, expected, condition) {
  switch (operator) {
    case "$eq":
      return compileEquality(path, expected);
    case "$ne": {
      const equality = compileEquality(path, expected);
      return {
        sql: `NOT (${equality.sql})`,
        params: equality.params,
      };
    }
    case "$gt":
      return compileComparison(path, ">", expected);
    case "$gte":
      return compileComparison(path, ">=", expected);
    case "$lt":
      return compileComparison(path, "<", expected);
    case "$lte":
      return compileComparison(path, "<=", expected);
    case "$in":
      return compileIn(path, expected, false);
    case "$nin":
      return compileIn(path, expected, true);
    case "$exists":
      return compileExists(path, expected);
    case "$regex":
      return compileRegex(path, expected, condition.$options);
    default:
      throw new Error(`Unsupported query operator: ${operator}`);
  }
}

function compileEquality(path, expected) {
  assertJsonComparable(expected, "equality value");

  const jsonPath = toJsonPath(path);
  const exact = compileJsonValueComparison(
    "json_extract(document, ?)",
    "json_type(document, ?)",
    [jsonPath, jsonPath],
    expected,
  );

  if (Array.isArray(expected)) {
    return exact;
  }

  const contains = compileArrayContains(jsonPath, expected);

  return {
    sql: `((${exact.sql}) OR (${contains.sql}))`,
    params: [...exact.params, ...contains.params],
  };
}

function compileComparison(path, operator, expected) {
  if (!isComparableScalar(expected)) {
    throw new TypeError(
      `${operator} expects a string, number, boolean, or null`,
    );
  }

  const jsonPath = toJsonPath(path);

  return {
    sql: `(json_type(document, ?) IS NOT NULL AND json_extract(document, ?) ${operator} ?)`,
    params: [jsonPath, jsonPath, expected],
  };
}

function compileIn(path, expected, negate) {
  if (!Array.isArray(expected)) {
    throw new TypeError(`${negate ? "$nin" : "$in"} expects an array`);
  }

  if (expected.length === 0) {
    return { sql: negate ? "1 = 1" : "1 = 0", params: [] };
  }

  const fragments = expected.map((value) => compileEquality(path, value));
  const sql = fragments.map((fragment) => `(${fragment.sql})`).join(" OR ");
  const params = fragments.flatMap((fragment) => fragment.params);

  return {
    sql: negate ? `NOT (${sql})` : `(${sql})`,
    params,
  };
}

function compileExists(path, expected) {
  const jsonPath = toJsonPath(path);
  const operator = Boolean(expected) ? "IS NOT" : "IS";

  return {
    sql: `json_type(document, ?) ${operator} NULL`,
    params: [jsonPath],
  };
}

function compileRegex(path, expected, options = "") {
  const jsonPath = toJsonPath(path);
  let pattern = expected;
  let flags = options;

  if (expected instanceof RegExp) {
    pattern = expected.source;
    flags = expected.flags;
  }

  if (typeof pattern !== "string") {
    throw new TypeError("$regex expects a string or RegExp");
  }

  if (typeof flags !== "string") {
    throw new TypeError("$options expects a string");
  }

  return {
    sql: `(json_type(document, ?) = 'text' AND regexp(?, json_extract(document, ?), ?) = 1)`,
    params: [jsonPath, pattern, jsonPath, flags],
  };
}

function compileArrayContains(jsonPath, expected) {
  const alias = "item";
  const comparison = compileJsonValueComparison(
    `${alias}.value`,
    `${alias}.type`,
    [],
    expected,
  );

  return {
    sql: `(json_type(document, ?) = 'array' AND EXISTS (SELECT 1 FROM json_each(document, ?) AS ${alias} WHERE ${comparison.sql}))`,
    params: [jsonPath, jsonPath, ...comparison.params],
  };
}

function compileJsonValueComparison(valueSql, typeSql, fieldParams, expected) {
  const typeParamCount = fieldParamsFor(typeSql);
  const typeParams = fieldParams.slice(0, typeParamCount);
  const valueParams = fieldParams.slice(typeParamCount);

  if (expected === null) {
    return {
      sql: `${typeSql} = 'null'`,
      params: typeParams,
    };
  }

  if (typeof expected === "string") {
    return {
      sql: `(${typeSql} = 'text' AND ${valueSql} = ?)`,
      params: [...typeParams, ...valueParams, expected],
    };
  }

  if (typeof expected === "number") {
    return {
      sql: `(${typeSql} IN ('integer', 'real') AND ${valueSql} = ?)`,
      params: [...typeParams, ...valueParams, expected],
    };
  }

  if (typeof expected === "boolean") {
    return {
      sql: `${typeSql} = ?`,
      params: [...typeParams, expected ? "true" : "false"],
    };
  }

  const json = stringifyDocument(expected);
  const jsonType = Array.isArray(expected) ? "array" : "object";

  return {
    sql: `(${typeSql} = ? AND json(${valueSql}) = json(?))`,
    params: [...typeParams, jsonType, ...valueParams, json],
  };
}

function fieldParamsFor(sql) {
  return (sql.match(/\?/g) ?? []).length;
}

function compileSort(sort) {
  assertPlainObject(sort, "sort");

  const clauses = [];
  const params = [];

  for (const [path, direction] of Object.entries(sort)) {
    const normalizedDirection = normalizeSortDirection(direction);
    clauses.push(`json_extract(document, ?) ${normalizedDirection}`);
    params.push(toJsonPath(path));
  }

  if (clauses.length === 0) {
    throw new TypeError("sort must include at least one field");
  }

  return {
    sql: clauses.join(", "),
    params,
  };
}

function normalizeSortDirection(direction) {
  if (direction === -1 || direction === "desc" || direction === "descending") {
    return "DESC";
  }

  if (direction === 1 || direction === "asc" || direction === "ascending") {
    return "ASC";
  }

  throw new TypeError("sort direction must be 1, -1, 'asc', or 'desc'");
}

function toJsonPath(path) {
  if (typeof path !== "string" || path.trim() === "") {
    throw new TypeError("field path must be a non-empty string");
  }

  return `$${path
    .split(".")
    .map((part) => `.${JSON.stringify(part)}`)
    .join("")}`;
}

function prepareDocument(document) {
  assertPlainObject(document, "document");

  if (Object.hasOwn(document, "_id")) {
    assertValidId(document._id);
  }

  const record = cloneJson(document);

  if (!Object.hasOwn(record, "_id") || record._id === undefined) {
    record._id = createId();
  }

  return record;
}

function assertValidId(value) {
  if (Array.isArray(value)) {
    throw new TypeError("_id cannot be an array");
  }

  assertJsonComparable(value, "_id");
  assertValidIdObject(value);
}

function assertValidIdObject(value) {
  if (value === null || typeof value !== "object" || value instanceof Date) {
    return;
  }

  for (const [key, childValue] of Object.entries(value)) {
    if (key.startsWith("$")) {
      throw new TypeError("_id object keys cannot start with $");
    }

    if (childValue instanceof RegExp) {
      throw new TypeError("_id cannot contain a RegExp");
    }

    if (
      childValue === undefined ||
      typeof childValue === "function" ||
      typeof childValue === "symbol"
    ) {
      throw new TypeError("_id must be JSON serializable");
    }

    assertValidIdObject(childValue);
  }
}

function stringifyDocument(document) {
  const json = JSON.stringify(document);

  if (json === undefined) {
    throw new TypeError("Document must be JSON serializable");
  }

  return json;
}

function cloneJson(value) {
  const json = stringifyDocument(value);
  return JSON.parse(json);
}

function encodeId(value) {
  if (value === null) {
    return "null:null";
  }

  if (typeof value === "string") {
    return `string:${value}`;
  }

  if (typeof value === "number") {
    return `number:${value}`;
  }

  if (typeof value === "boolean") {
    return `boolean:${value}`;
  }

  return `json:${JSON.stringify(value)}`;
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }

  return value;
}

function assertQueryArray(value, operator) {
  if (!Array.isArray(value) || !value.every(isPlainObject)) {
    throw new TypeError(`${operator} expects an array of query objects`);
  }
}

function isOperatorObject(value) {
  return (
    isPlainObject(value) &&
    Object.keys(value).some((key) => key.startsWith("$"))
  );
}

function assertJsonComparable(value, label) {
  if (value instanceof RegExp) {
    throw new TypeError(`${label} cannot be a RegExp; use $regex instead`);
  }

  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new TypeError(`${label} must be JSON serializable`);
  }

  stringifyDocument(value);
}

function isComparableScalar(value) {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}
