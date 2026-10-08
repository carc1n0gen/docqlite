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

  createIndex(keys, options = {}) {
    assertPlainObject(options, "createIndex options");

    const index = compileCreateIndexSql(this, keys, options);

    if (index.sql) {
      this.database.exec(index.sql);
    }

    return index.name;
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

    const lookup =
      options.lookup === undefined
        ? null
        : normalizeLookup(options.lookup, this);
    const sqlQuery = compileFindSql(this, query, options, lookup);

    return this.database
      .prepare(sqlQuery.sql)
      .all(...sqlQuery.params)
      .map((row) => hydrateDocument(row, lookup));
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

  deleteOne(query = {}) {
    return this.#delete(query, { limit: 1 });
  }

  deleteMany(query = {}) {
    return this.#delete(query);
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

  #delete(query, options = {}) {
    assertPlainObject(query, "delete query");

    const selectQuery = compileSelectSql(
      this.tableName,
      query,
      { limit: options.limit },
      "_id",
    );
    const result = this.database
      .prepare(
        `DELETE FROM ${this.tableName} WHERE _id IN (${selectQuery.sql})`,
      )
      .run(...selectQuery.params);

    return {
      acknowledged: true,
      deletedCount: Number(result.changes),
    };
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

function compileFindSql(collection, query, options, lookup) {
  if (!lookup) {
    return compileSelectSql(collection.tableName, query, options);
  }

  const sourceAlias = "__docqlite_source";
  const documentSql = `${sourceAlias}.document`;
  const idSql = `${sourceAlias}._id`;
  const lookupSql = compileLookupSql(lookup, documentSql, idSql);

  return compileSelectSql(
    `${collection.tableName} AS ${sourceAlias}`,
    query,
    options,
    `${documentSql} AS document, ${lookupSql} AS __docqlite_lookup`,
    documentSql,
    idSql,
  );
}

function compileCreateIndexSql(collection, keys, options) {
  const fields = normalizeIndexKeys(keys);

  if (options.name !== undefined) {
    normalizeIndexName(options.name);
  }

  if (options.unique !== undefined && typeof options.unique !== "boolean") {
    throw new TypeError("createIndex unique option must be a boolean");
  }

  if (fields.length === 1 && isIdPath(fields[0].path)) {
    return { name: "_id_", sql: null };
  }

  const name = options.name ?? defaultIndexName(collection.name, fields);
  const unique = options.unique ? "UNIQUE " : "";
  const expressions = fields.map(({ path, direction }) => {
    if (isIdPath(path)) {
      return `_id ${direction}`;
    }

    return `json_extract(document, ${toJsonPathSql(path)}) ${direction}`;
  });

  return {
    name,
    sql: `CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdentifier(name)} ON ${collection.tableName} (${expressions.join(", ")})`,
  };
}

function normalizeIndexKeys(keys) {
  if (typeof keys === "string") {
    assertIndexFieldPath(keys);
    return [{ path: keys, direction: "ASC" }];
  }

  assertPlainObject(keys, "createIndex keys");

  const entries = Object.entries(keys);

  if (entries.length === 0) {
    throw new TypeError("createIndex keys must include at least one field");
  }

  return entries.map(([path, direction]) => {
    assertIndexFieldPath(path);

    return {
      path,
      direction: normalizeSortDirection(direction),
    };
  });
}

function assertIndexFieldPath(path) {
  assertFieldPath(path);

  if (path.startsWith("$")) {
    throw new TypeError("createIndex field paths cannot start with $");
  }
}

function normalizeIndexName(name) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError("createIndex name option must be a non-empty string");
  }

  return name;
}

function defaultIndexName(collectionName, fields) {
  return `${sanitizeIndexNamePart(collectionName)}_${fields
    .map(
      ({ path, direction }) =>
        `${sanitizeIndexNamePart(path)}_${direction.toLowerCase()}`,
    )
    .join("_")}_idx`;
}

function sanitizeIndexNamePart(value) {
  return (
    value.replaceAll(/[^A-Za-z0-9]+/g, "_").replaceAll(/^_+|_+$/g, "") ||
    "field"
  );
}

function compileSelectSql(
  tableName,
  query,
  options = {},
  columns = "document",
  documentSql = "document",
  idSql = "_id",
) {
  const compiledQuery = compileQuery(query, documentSql, idSql);
  let sql = `SELECT ${columns} FROM ${tableName}`;
  const params = [...compiledQuery.params];

  if (compiledQuery.sql) {
    sql += ` WHERE ${compiledQuery.sql}`;
  }

  if (options.sort) {
    const compiledSort = compileSort(options.sort, documentSql);
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

function normalizeLookup(lookup, collection) {
  assertPlainObject(lookup, "lookup");

  if (!(lookup.from instanceof Collection)) {
    throw new TypeError("lookup.from must be a DocQLite collection");
  }

  if (lookup.from.database !== collection.database) {
    throw new TypeError("lookup.from must use the same database connection");
  }

  if (
    Object.hasOwn(lookup, "foreignField") &&
    Object.hasOwn(lookup, "foreinField")
  ) {
    throw new TypeError(
      "lookup cannot include both foreignField and foreinField",
    );
  }

  const foreignField = lookup.foreignField ?? lookup.foreinField;

  assertLookupField(lookup.localField, "lookup.localField");
  assertLookupField(foreignField, "lookup.foreignField");
  assertLookupField(lookup.as, "lookup.as");

  if (lookup.justOne !== undefined && typeof lookup.justOne !== "boolean") {
    throw new TypeError("lookup.justOne must be a boolean");
  }

  return {
    from: lookup.from,
    localField: lookup.localField,
    foreignField,
    as: lookup.as,
    justOne: lookup.justOne === true,
  };
}

function assertLookupField(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function compileLookupSql(lookup, sourceDocumentSql, sourceIdSql) {
  const lookupAlias = "__docqlite_lookup";
  const lookupDocumentSql = `${lookupAlias}.document`;
  const lookupIdSql = `${lookupAlias}._id`;
  const fieldEquality = compileFieldReferenceEquality(
    sourceDocumentSql,
    sourceIdSql,
    lookup.localField,
    lookupDocumentSql,
    lookupIdSql,
    lookup.foreignField,
  );

  if (lookup.justOne) {
    return `(
      SELECT ${lookupDocumentSql}
      FROM ${lookup.from.tableName} AS ${lookupAlias}
      WHERE ${fieldEquality.sql}
      LIMIT 1
    )`;
  }

  return `(
    SELECT COALESCE(json_group_array(json(${lookupDocumentSql})), json('[]'))
    FROM ${lookup.from.tableName} AS ${lookupAlias}
    WHERE ${fieldEquality.sql}
  )`;
}

function compileFieldReferenceEquality(
  leftDocumentSql,
  leftIdSql,
  leftPath,
  rightDocumentSql,
  rightIdSql,
  rightPath,
) {
  if (isIdPath(rightPath)) {
    const leftValue = compileEncodedFieldReference(
      leftDocumentSql,
      leftIdSql,
      leftPath,
    );

    return {
      sql: `(${leftValue.existsSql} AND ${rightIdSql} = ${leftValue.sql})`,
      params: [],
    };
  }

  return compileJsonFieldReferenceEquality(
    leftDocumentSql,
    leftPath,
    rightDocumentSql,
    rightPath,
  );
}

function compileJsonFieldReferenceEquality(
  leftDocumentSql,
  leftPath,
  rightDocumentSql,
  rightPath,
) {
  const leftPathSql = toJsonPathSql(leftPath);
  const rightPathSql = toJsonPathSql(rightPath);
  const leftType = `json_type(${leftDocumentSql}, ${leftPathSql})`;
  const rightType = `json_type(${rightDocumentSql}, ${rightPathSql})`;
  const leftValue = `json_extract(${leftDocumentSql}, ${leftPathSql})`;
  const rightValue = `json_extract(${rightDocumentSql}, ${rightPathSql})`;

  return {
    sql: `(${leftType} IS NOT NULL AND ${rightType} IS NOT NULL AND ${rightValue} IS ${leftValue} AND (${rightType} = ${leftType} OR (${rightType} IN ('integer', 'real') AND ${leftType} IN ('integer', 'real'))))`,
    params: [],
  };
}

function compileEncodedFieldReference(documentSql, idSql, path) {
  if (isIdPath(path)) {
    return { sql: idSql, existsSql: `${idSql} IS NOT NULL` };
  }

  const pathSql = toJsonPathSql(path);
  const typeSql = `json_type(${documentSql}, ${pathSql})`;
  const valueSql = `json_extract(${documentSql}, ${pathSql})`;

  return {
    sql: `(CASE ${typeSql}
      WHEN 'null' THEN 'null:null'
      WHEN 'text' THEN 'string:' || ${valueSql}
      WHEN 'integer' THEN 'number:' || ${valueSql}
      WHEN 'real' THEN 'number:' || ${valueSql}
      WHEN 'true' THEN 'boolean:true'
      WHEN 'false' THEN 'boolean:false'
      WHEN 'object' THEN 'json:' || json(${valueSql})
      WHEN 'array' THEN 'json:' || json(${valueSql})
    END)`,
    existsSql: `${typeSql} IS NOT NULL`,
  };
}

function hydrateDocument(row, lookup) {
  const document = JSON.parse(row.document);

  if (!lookup) {
    return document;
  }

  document[lookup.as] = lookup.justOne
    ? row.__docqlite_lookup === null
      ? null
      : JSON.parse(row.__docqlite_lookup)
    : JSON.parse(row.__docqlite_lookup ?? "[]");

  return document;
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

function compileQuery(query, documentSql = "document", idSql = "_id") {
  assertPlainObject(query, "query");

  const fragments = [];
  const params = [];

  for (const [key, condition] of Object.entries(query)) {
    const fragment = compileQueryEntry(key, condition, documentSql, idSql);
    fragments.push(fragment.sql);
    params.push(...fragment.params);
  }

  return {
    sql: fragments.join(" AND "),
    params,
  };
}

function compileQueryEntry(key, condition, documentSql, idSql) {
  if (key === "$and") {
    return compileLogicalQuery(
      "$and",
      condition,
      "AND",
      false,
      documentSql,
      idSql,
    );
  }

  if (key === "$or") {
    return compileLogicalQuery(
      "$or",
      condition,
      "OR",
      false,
      documentSql,
      idSql,
    );
  }

  if (key === "$nor") {
    return compileLogicalQuery(
      "$nor",
      condition,
      "OR",
      true,
      documentSql,
      idSql,
    );
  }

  if (key.startsWith("$")) {
    throw new Error(`Unsupported query operator: ${key}`);
  }

  return compileFieldCondition(key, condition, documentSql, idSql);
}

function compileLogicalQuery(
  operator,
  condition,
  joiner,
  negate,
  documentSql,
  idSql,
) {
  assertQueryArray(condition, operator);

  if (condition.length === 0) {
    return { sql: negate ? "1 = 1" : "1 = 0", params: [] };
  }

  const fragments = condition.map((childQuery) =>
    compileQuery(childQuery, documentSql, idSql),
  );
  const sql = fragments
    .map((fragment) => `(${fragment.sql || "1 = 1"})`)
    .join(` ${joiner} `);
  const params = fragments.flatMap((fragment) => fragment.params);

  return {
    sql: negate ? `NOT (${sql})` : `(${sql})`,
    params,
  };
}

function compileFieldCondition(path, condition, documentSql, idSql) {
  if (!isOperatorObject(condition)) {
    return compileEquality(path, condition, documentSql, idSql);
  }

  const fragments = [];
  const params = [];

  for (const [operator, expected] of Object.entries(condition)) {
    if (operator === "$options") {
      continue;
    }

    const fragment = compileFieldOperator(
      path,
      operator,
      expected,
      condition,
      documentSql,
      idSql,
    );
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

function compileFieldOperator(
  path,
  operator,
  expected,
  condition,
  documentSql,
  idSql,
) {
  switch (operator) {
    case "$eq":
      return compileEquality(path, expected, documentSql, idSql);
    case "$ne": {
      const equality = compileEquality(path, expected, documentSql, idSql);
      return {
        sql: `NOT (${equality.sql})`,
        params: equality.params,
      };
    }
    case "$gt":
      return compileComparison(path, ">", expected, documentSql);
    case "$gte":
      return compileComparison(path, ">=", expected, documentSql);
    case "$lt":
      return compileComparison(path, "<", expected, documentSql);
    case "$lte":
      return compileComparison(path, "<=", expected, documentSql);
    case "$in":
      return compileIn(path, expected, false, documentSql, idSql);
    case "$nin":
      return compileIn(path, expected, true, documentSql, idSql);
    case "$exists":
      return compileExists(path, expected, documentSql);
    case "$regex":
      return compileRegex(path, expected, condition.$options, documentSql);
    default:
      throw new Error(`Unsupported query operator: ${operator}`);
  }
}

function compileIdEquality(expected, idSql) {
  return {
    sql: `${idSql} = ?`,
    params: [encodeQueryId(expected)],
  };
}

function compileIdIn(expected, negate, idSql) {
  const placeholders = expected.map(() => "?").join(", ");

  return {
    sql: `${idSql} ${negate ? "NOT IN" : "IN"} (${placeholders})`,
    params: expected.map(encodeQueryId),
  };
}

function compileEquality(path, expected, documentSql, idSql) {
  if (isIdPath(path)) {
    return compileIdEquality(expected, idSql);
  }

  assertJsonComparable(expected, "equality value");

  const jsonPathSql = toJsonPathSql(path);
  const exact = compileJsonValueComparison(
    `json_extract(${documentSql}, ${jsonPathSql})`,
    `json_type(${documentSql}, ${jsonPathSql})`,
    [],
    expected,
  );

  if (Array.isArray(expected)) {
    return exact;
  }

  const contains = compileArrayContains(documentSql, jsonPathSql, expected);

  return {
    sql: `((${exact.sql}) OR (${contains.sql}))`,
    params: [...exact.params, ...contains.params],
  };
}

function compileComparison(path, operator, expected, documentSql) {
  if (!isComparableScalar(expected)) {
    throw new TypeError(
      `${operator} expects a string, number, boolean, or null`,
    );
  }

  const jsonPathSql = toJsonPathSql(path);

  return {
    sql: `(json_type(${documentSql}, ${jsonPathSql}) IS NOT NULL AND json_extract(${documentSql}, ${jsonPathSql}) ${operator} ?)`,
    params: [expected],
  };
}

function compileIn(path, expected, negate, documentSql, idSql) {
  if (!Array.isArray(expected)) {
    throw new TypeError(`${negate ? "$nin" : "$in"} expects an array`);
  }

  if (expected.length === 0) {
    return { sql: negate ? "1 = 1" : "1 = 0", params: [] };
  }

  if (isIdPath(path)) {
    return compileIdIn(expected, negate, idSql);
  }

  const fragments = expected.map((value) =>
    compileEquality(path, value, documentSql, idSql),
  );
  const sql = fragments.map((fragment) => `(${fragment.sql})`).join(" OR ");
  const params = fragments.flatMap((fragment) => fragment.params);

  return {
    sql: negate ? `NOT (${sql})` : `(${sql})`,
    params,
  };
}

function compileExists(path, expected, documentSql) {
  const jsonPathSql = toJsonPathSql(path);
  const operator = Boolean(expected) ? "IS NOT" : "IS";

  return {
    sql: `json_type(${documentSql}, ${jsonPathSql}) ${operator} NULL`,
    params: [],
  };
}

function compileRegex(path, expected, options = "", documentSql) {
  const jsonPathSql = toJsonPathSql(path);
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
    sql: `(json_type(${documentSql}, ${jsonPathSql}) = 'text' AND regexp(?, json_extract(${documentSql}, ${jsonPathSql}), ?) = 1)`,
    params: [pattern, flags],
  };
}

function compileArrayContains(documentSql, jsonPathSql, expected) {
  const alias = "item";
  const comparison = compileJsonValueComparison(
    `${alias}.value`,
    `${alias}.type`,
    [],
    expected,
  );

  return {
    sql: `(json_type(${documentSql}, ${jsonPathSql}) = 'array' AND EXISTS (SELECT 1 FROM json_each(${documentSql}, ${jsonPathSql}) AS ${alias} WHERE ${comparison.sql}))`,
    params: [...comparison.params],
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

function compileSort(sort, documentSql = "document") {
  assertPlainObject(sort, "sort");

  const clauses = [];
  const params = [];

  for (const [path, direction] of Object.entries(sort)) {
    const normalizedDirection = normalizeSortDirection(direction);
    clauses.push(
      `json_extract(${documentSql}, ${toJsonPathSql(path)}) ${normalizedDirection}`,
    );
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

function toJsonPathSql(path) {
  return quoteSqlString(toJsonPath(path));
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

function encodeQueryId(value) {
  assertValidId(value);
  return encodeId(cloneJson(value));
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

function isIdPath(path) {
  return path === "_id";
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteSqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
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
