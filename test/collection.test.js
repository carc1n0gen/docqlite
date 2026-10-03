import test from "node:test";
import assert from "node:assert/strict";
import docqlite, { createId } from "../src/index.js";

const generatedIdPattern = /^[0-9a-f]{24}$/;

test("creates collections and inserts one document", () => {
  const db = docqlite(":memory:");
  const users = db.collection("users");

  const result = users.insertOne({ name: "Ada", age: 36 });

  assert.equal(result.acknowledged, true);
  assert.match(result.insertedId, generatedIdPattern);
  assert.deepEqual(users.findOne({ _id: result.insertedId }), {
    _id: result.insertedId,
    name: "Ada",
    age: 36,
  });

  db.close();
});

test("generates time-sortable ObjectId-like ids", () => {
  const ids = Array.from({ length: 5 }, () => createId());

  assert(ids.every((id) => generatedIdPattern.test(id)));
  assert.deepEqual([...ids].sort(), ids);
});

test("inserts many documents inside one transaction", () => {
  const db = docqlite(":memory:");
  const users = db.collection("users");

  const result = users.insertMany([
    { name: "Ada", age: 36 },
    { name: "Grace", age: 29 },
  ]);

  assert.equal(result.acknowledged, true);
  assert.equal(result.insertedCount, 2);
  assert.equal(users.countDocuments(), 2);

  db.close();
});

test("queries with equality, nested paths, operators, sorting, and limits", () => {
  const db = docqlite(":memory:");
  const users = db.collection("users");

  users.insertMany([
    { name: "Ada", age: 36, tags: ["admin"], address: { city: "London" } },
    {
      name: "Grace",
      age: 29,
      tags: ["maintainer"],
      address: { city: "New York" },
    },
    { name: "Linus", age: 54, tags: ["admin"], address: { city: "Helsinki" } },
  ]);

  assert.deepEqual(
    users
      .find(
        {
          $and: [{ age: { $gte: 30 } }, { tags: "admin" }],
        },
        {
          sort: { age: -1 },
          limit: 1,
        },
      )
      .map(({ name, age }) => ({ name, age })),
    [{ name: "Linus", age: 54 }],
  );

  assert.equal(users.findOne({ "address.city": "London" }).name, "Ada");

  db.close();
});

test("updates one matching document with Mongo-like operators", () => {
  const db = docqlite(":memory:");
  const users = db.collection("users");

  users.insertMany([
    { name: "Ada", age: 36, profile: { role: "admin" }, tags: ["user"] },
    { name: "Grace", age: 29, profile: { role: "maintainer" }, tags: ["user"] },
  ]);

  const result = users.updateOne(
    { name: "Ada" },
    {
      $set: { "profile.role": "owner" },
      $inc: { age: 1 },
      $unset: { unused: "" },
      $push: { tags: "admin" },
    },
  );

  assert.deepEqual(result, {
    acknowledged: true,
    matchedCount: 1,
    modifiedCount: 1,
    upsertedCount: 0,
    upsertedId: null,
  });
  assert.equal(users.findOne({ name: "Ada" }).age, 37);
  assert.equal(users.findOne({ name: "Ada" }).profile.role, "owner");
  assert.deepEqual(users.findOne({ name: "Ada" }).tags, ["user", "admin"]);
  assert.equal(users.findOne({ name: "Grace" }).age, 29);

  db.close();
});

test("updates many documents and supports addToSet and pull", () => {
  const db = docqlite(":memory:");
  const users = db.collection("users");

  users.insertMany([
    { name: "Ada", active: true, tags: ["user", "admin"], scores: [1, 2, 3] },
    { name: "Grace", active: true, tags: ["user"], scores: [2, 3, 4] },
    { name: "Linus", active: false, tags: ["user"], scores: [3, 4, 5] },
  ]);

  const result = users.updateMany(
    { active: true },
    {
      $addToSet: { tags: { $each: ["user", "active"] } },
      $pull: { scores: { $gte: 3 } },
    },
  );

  assert.equal(result.matchedCount, 2);
  assert.equal(result.modifiedCount, 2);
  assert.deepEqual(users.findOne({ name: "Ada" }).tags, [
    "user",
    "admin",
    "active",
  ]);
  assert.deepEqual(users.findOne({ name: "Ada" }).scores, [1, 2]);
  assert.deepEqual(users.findOne({ name: "Grace" }).tags, ["user", "active"]);
  assert.deepEqual(users.findOne({ name: "Grace" }).scores, [2]);
  assert.deepEqual(users.findOne({ name: "Linus" }).scores, [3, 4, 5]);

  db.close();
});

test("upserts a document when updateOne has no matches", () => {
  const db = docqlite(":memory:");
  const users = db.collection("users");

  const result = users.updateOne(
    { name: "Ada" },
    {
      $set: { active: true },
      $setOnInsert: { createdBy: "test" },
      $inc: { visits: 1 },
    },
    { upsert: true },
  );

  assert.equal(result.matchedCount, 0);
  assert.equal(result.modifiedCount, 0);
  assert.equal(result.upsertedCount, 1);
  assert.match(result.upsertedId, generatedIdPattern);
  assert.deepEqual(users.findOne({ name: "Ada" }), {
    _id: result.upsertedId,
    name: "Ada",
    active: true,
    createdBy: "test",
    visits: 1,
  });

  db.close();
});

test("allows custom _id values while keeping _id immutable", () => {
  const db = docqlite(":memory:");
  const users = db.collection("users");

  users.insertMany([
    { _id: "1", name: "String ID" },
    { _id: 1, name: "Number ID" },
    { _id: null, name: "Null ID" },
    { _id: true, name: "Boolean ID" },
    { _id: { tenant: "krusty-krab", id: "spongebob" }, name: "Object ID" },
  ]);

  assert.equal(users.countDocuments(), 5);
  assert.equal(users.findOne({ _id: "1" }).name, "String ID");
  assert.equal(users.findOne({ _id: 1 }).name, "Number ID");
  assert.equal(users.findOne({ _id: null }).name, "Null ID");
  assert.equal(users.findOne({ _id: true }).name, "Boolean ID");
  assert.equal(
    users.findOne({ _id: { tenant: "krusty-krab", id: "spongebob" } }).name,
    "Object ID",
  );

  assert.throws(
    () => users.updateOne({ _id: "1" }, { $set: { _id: "grace" } }),
    /immutable field _id/,
  );

  assert.equal(users.findOne({ _id: "1" }).name, "String ID");

  db.close();
});

test("rejects invalid _id values", () => {
  const db = docqlite(":memory:");
  const users = db.collection("users");

  assert.throws(() => users.insertOne({ _id: [], name: "Array ID" }), /array/);
  assert.throws(
    () => users.insertOne({ _id: /sponge/, name: "Regex ID" }),
    /RegExp/,
  );
  assert.throws(
    () => users.insertOne({ _id: { $oid: "abc" }, name: "Dollar Key ID" }),
    /cannot start with \$/,
  );
  assert.throws(
    () =>
      users.insertOne({
        _id: { nested: { $bad: true } },
        name: "Nested Dollar Key ID",
      }),
    /cannot start with \$/,
  );
  assert.throws(
    () => users.insertOne({ _id: undefined, name: "Undefined ID" }),
    /JSON serializable/,
  );
  assert.throws(
    () => users.insertOne({ _id: Number.NaN, name: "NaN ID" }),
    /JSON serializable/,
  );

  db.close();
});

test("pushes JSON object, array, null, boolean, regex, and exists queries into SQLite", () => {
  const db = docqlite(":memory:");
  const users = db.collection("users");

  users.insertMany([
    {
      name: "Ada",
      active: true,
      deletedAt: null,
      profile: { role: "admin" },
      scores: [1, 2, 3],
    },
    {
      name: "Grace",
      active: false,
      profile: { role: "maintainer" },
      scores: [2, 3],
    },
  ]);

  assert.equal(users.findOne({ profile: { role: "admin" } }).name, "Ada");
  assert.equal(users.findOne({ scores: [1, 2, 3] }).name, "Ada");
  assert.equal(users.findOne({ deletedAt: null }).name, "Ada");
  assert.equal(users.countDocuments({ active: true }), 1);
  assert.equal(
    users.findOne({ name: { $regex: "^ada$", $options: "i" } }).name,
    "Ada",
  );
  assert.equal(users.countDocuments({ deletedAt: { $exists: false } }), 1);

  db.close();
});
