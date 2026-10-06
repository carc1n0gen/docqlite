import test from "node:test";
import assert from "node:assert/strict";
import docqlite, { createId } from "../src/index.js";

const generatedIdPattern = /^[0-9a-f]{24}$/;

test("creates collections and inserts one document", () => {
  const db = docqlite(":memory:");
  const characters = db.collection("characters");

  const result = characters.insertOne({
    name: "SpongeBob SquarePants",
    jellyfishCaught: 42,
  });

  assert.equal(result.acknowledged, true);
  assert.match(result.insertedId, generatedIdPattern);
  assert.deepEqual(characters.findOne({ _id: result.insertedId }), {
    _id: result.insertedId,
    name: "SpongeBob SquarePants",
    jellyfishCaught: 42,
  });

  db.close();
});

test("generates time-sortable ids", () => {
  const ids = Array.from({ length: 5 }, () => createId());

  assert(ids.every((id) => generatedIdPattern.test(id)));
  assert.deepEqual([...ids].sort(), ids);
});

test("inserts many documents inside one transaction", () => {
  const db = docqlite(":memory:");
  const characters = db.collection("characters");

  const result = characters.insertMany([
    { name: "SpongeBob SquarePants", jellyfishCaught: 42 },
    { name: "Patrick Star", jellyfishCaught: 15 },
  ]);

  assert.equal(result.acknowledged, true);
  assert.equal(result.insertedCount, 2);
  assert.equal(characters.countDocuments(), 2);

  db.close();
});

test("queries with equality, nested paths, operators, sorting, and limits", () => {
  const db = docqlite(":memory:");
  const characters = db.collection("characters");

  characters.insertMany([
    {
      name: "Patrick Star",
      jellyfishCaught: 31,
      hobbies: ["jellyfishing"],
      address: { city: "Bikini Bottom", street: "120 Conch Street" },
    },
    {
      name: "Squidward Tentacles",
      jellyfishCaught: 0,
      hobbies: ["playing clarinet"],
      address: { city: "Bikini Bottom", street: "122 Conch Street" },
    },
    {
      name: "SpongeBob SquarePants",
      jellyfishCaught: 42,
      hobbies: ["jellyfishing"],
      address: { city: "Bikini Bottom", street: "124 Conch Street" },
    },
  ]);

  assert.deepEqual(
    characters
      .find(
        {
          $and: [
            { jellyfishCaught: { $gte: 30 } },
            { hobbies: "jellyfishing" },
          ],
        },
        {
          sort: { jellyfishCaught: -1 },
          limit: 1,
        },
      )
      .map(({ name, jellyfishCaught }) => ({ name, jellyfishCaught })),
    [{ name: "SpongeBob SquarePants", jellyfishCaught: 42 }],
  );

  assert.equal(
    characters.findOne({ "address.street": "122 Conch Street" }).name,
    "Squidward Tentacles",
  );

  db.close();
});

test("updates one matching document", () => {
  const db = docqlite(":memory:");
  const characters = db.collection("characters");

  characters.insertMany([
    {
      name: "SpongeBob SquarePants",
      krabbyPattiesMade: 1000,
      employment: { title: "fry cook" },
      hobbies: ["jellyfishing"],
    },
    {
      name: "Squidward Tentacles",
      krabbyPattiesMade: 9,
      employment: { title: "cashier" },
      hobbies: ["playing clarinet"],
    },
  ]);

  const result = characters.updateOne(
    { name: "SpongeBob SquarePants" },
    {
      $set: { "employment.title": "assistant manager" },
      $inc: { krabbyPattiesMade: 1 },
      $unset: { boatLicense: "" },
      $push: { hobbies: "blowing bubbles" },
    },
  );

  assert.deepEqual(result, {
    acknowledged: true,
    matchedCount: 1,
    modifiedCount: 1,
    upsertedCount: 0,
    upsertedId: null,
  });

  const spongebob = characters.findOne({ name: "SpongeBob SquarePants" });
  assert.equal(spongebob.krabbyPattiesMade, 1001);
  assert.equal(spongebob.employment.title, "assistant manager");
  assert.deepEqual(spongebob.hobbies, ["jellyfishing", "blowing bubbles"]);
  assert.equal(
    characters.findOne({ name: "Squidward Tentacles" }).krabbyPattiesMade,
    9,
  );

  db.close();
});

test("updates many documents and supports addToSet and pull", () => {
  const db = docqlite(":memory:");
  const characters = db.collection("characters");

  characters.insertMany([
    {
      name: "SpongeBob SquarePants",
      onShift: true,
      badges: ["krusty-krew", "employee-of-the-month"],
      tips: [1, 2, 3],
    },
    {
      name: "Squidward Tentacles",
      onShift: true,
      badges: ["krusty-krew"],
      tips: [2, 3, 4],
    },
    {
      name: "Mr. Krabs",
      onShift: false,
      badges: ["krusty-krew"],
      tips: [3, 4, 5],
    },
  ]);

  const result = characters.updateMany(
    { onShift: true },
    {
      $addToSet: { badges: { $each: ["krusty-krew", "on-the-clock"] } },
      $pull: { tips: { $gte: 3 } },
    },
  );

  assert.equal(result.matchedCount, 2);
  assert.equal(result.modifiedCount, 2);
  assert.deepEqual(
    characters.findOne({ name: "SpongeBob SquarePants" }).badges,
    ["krusty-krew", "employee-of-the-month", "on-the-clock"],
  );
  assert.deepEqual(
    characters.findOne({ name: "SpongeBob SquarePants" }).tips,
    [1, 2],
  );
  assert.deepEqual(characters.findOne({ name: "Squidward Tentacles" }).badges, [
    "krusty-krew",
    "on-the-clock",
  ]);
  assert.deepEqual(
    characters.findOne({ name: "Squidward Tentacles" }).tips,
    [2],
  );
  assert.deepEqual(characters.findOne({ name: "Mr. Krabs" }).tips, [3, 4, 5]);

  db.close();
});

test("upserts a document when updateOne has no matches", () => {
  const db = docqlite(":memory:");
  const characters = db.collection("characters");

  const result = characters.updateOne(
    { name: "Sandy Cheeks" },
    {
      $set: { home: "treedome" },
      $setOnInsert: { hometown: "Texas" },
      $inc: { karateChops: 1 },
    },
    { upsert: true },
  );

  assert.equal(result.matchedCount, 0);
  assert.equal(result.modifiedCount, 0);
  assert.equal(result.upsertedCount, 1);
  assert.match(result.upsertedId, generatedIdPattern);
  assert.deepEqual(characters.findOne({ name: "Sandy Cheeks" }), {
    _id: result.upsertedId,
    name: "Sandy Cheeks",
    home: "treedome",
    hometown: "Texas",
    karateChops: 1,
  });

  db.close();
});

test("allows custom _id values while keeping _id immutable", () => {
  const db = docqlite(":memory:");
  const characters = db.collection("characters");

  characters.insertMany([
    { _id: "spongebob", name: "SpongeBob SquarePants" },
    { _id: 1, name: "Patrick Star" },
    { _id: null, name: "Squidward Tentacles" },
    { _id: true, name: "Sandy Cheeks" },
    {
      _id: { restaurant: "krusty-krab", employee: "mr-krabs" },
      name: "Mr. Krabs",
    },
  ]);

  assert.equal(characters.countDocuments(), 5);
  assert.equal(
    characters.findOne({ _id: "spongebob" }).name,
    "SpongeBob SquarePants",
  );
  assert.equal(characters.findOne({ _id: 1 }).name, "Patrick Star");
  assert.equal(characters.findOne({ _id: null }).name, "Squidward Tentacles");
  assert.equal(characters.findOne({ _id: true }).name, "Sandy Cheeks");
  assert.equal(
    characters.findOne({
      _id: { restaurant: "krusty-krab", employee: "mr-krabs" },
    }).name,
    "Mr. Krabs",
  );

  assert.throws(
    () =>
      characters.updateOne({ _id: "spongebob" }, { $set: { _id: "plankton" } }),
    /immutable field _id/,
  );

  assert.equal(
    characters.findOne({ _id: "spongebob" }).name,
    "SpongeBob SquarePants",
  );

  db.close();
});

test("rejects invalid _id values", () => {
  const db = docqlite(":memory:");
  const characters = db.collection("characters");

  assert.throws(
    () => characters.insertOne({ _id: [], name: "Plankton" }),
    /array/,
  );
  assert.throws(
    () => characters.insertOne({ _id: /sponge/, name: "Karen" }),
    /RegExp/,
  );
  assert.throws(
    () => characters.insertOne({ _id: { $oid: "abc" }, name: "Man Ray" }),
    /cannot start with \$/,
  );
  assert.throws(
    () =>
      characters.insertOne({
        _id: { nested: { $bad: true } },
        name: "Dirty Bubble",
      }),
    /cannot start with \$/,
  );
  assert.throws(
    () => characters.insertOne({ _id: undefined, name: "Flying Dutchman" }),
    /JSON serializable/,
  );
  assert.throws(
    () => characters.insertOne({ _id: Number.NaN, name: "Bubble Bass" }),
    /JSON serializable/,
  );

  db.close();
});

test("looks up matching documents from another collection", () => {
  const db = docqlite(":memory:");
  const characters = db.collection("characters");
  const orders = db.collection("orders");

  characters.insertMany([
    { _id: "spongebob", name: "SpongeBob SquarePants" },
    { _id: "patrick", name: "Patrick Star" },
    { _id: "squidward", name: "Squidward Tentacles" },
  ]);
  orders.insertMany([
    { _id: 1, customerId: "patrick", item: "Krabby Patty" },
    { _id: 2, customerId: "patrick", item: "Kelp Shake" },
    { _id: 3, customerId: "squidward", item: "Coral Bits" },
    { _id: 4, customerId: "plankton", item: "Krabby Patty secret formula" },
  ]);

  const results = characters.lookup(
    {},
    {
      from: orders,
      localField: "_id",
      foreignField: "customerId",
      as: "orders",
    },
  );
  const byId = new Map(results.map((character) => [character._id, character]));
  const itemsFor = (id) =>
    byId
      .get(id)
      .orders.map(({ item }) => item)
      .sort();

  assert.equal(results.length, 3);
  assert.deepEqual(itemsFor("patrick"), ["Kelp Shake", "Krabby Patty"]);
  assert.deepEqual(itemsFor("squidward"), ["Coral Bits"]);
  assert.deepEqual(itemsFor("spongebob"), []);
  assert.deepEqual(byId.get("squidward").orders, [
    { _id: 3, customerId: "squidward", item: "Coral Bits" },
  ]);

  db.close();
});

test("looks up with a parent query and nested field paths", () => {
  const db = docqlite(":memory:");
  const characters = db.collection("characters");
  const pets = db.collection("pets");

  characters.insertMany([
    {
      name: "SpongeBob SquarePants",
      address: { city: "Bikini Bottom", street: "124 Conch Street" },
    },
    {
      name: "Patrick Star",
      address: { city: "Bikini Bottom", street: "120 Conch Street" },
    },
    {
      name: "Mermaid Man",
      address: { city: "Shady Shoals", street: "Shady Shoals Rest Home" },
    },
  ]);
  pets.insertMany([
    {
      name: "Gary",
      species: "sea snail",
      home: { street: "124 Conch Street" },
    },
    { name: "Rocky", species: "rock", home: { street: "120 Conch Street" } },
    {
      name: "Snellie",
      species: "sea snail",
      home: { street: "122 Conch Street" },
    },
  ]);

  const results = characters.lookup(
    { "address.city": "Bikini Bottom" },
    {
      from: pets,
      localField: "address.street",
      foreignField: "home.street",
      as: "household.pets",
    },
  );

  assert.deepEqual(
    results
      .map(({ name, household }) => ({
        name,
        pets: household.pets.map((pet) => pet.name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    [
      { name: "Patrick Star", pets: ["Rocky"] },
      { name: "SpongeBob SquarePants", pets: ["Gary"] },
    ],
  );

  db.close();
});

test("looks up using type-strict equality", () => {
  const db = docqlite(":memory:");
  const characters = db.collection("characters");
  const orders = db.collection("orders");

  characters.insertMany([
    { name: "Patrick Star", tableNumber: 1 },
    { name: "Squidward Tentacles", tableNumber: "2" },
    { name: "SpongeBob SquarePants" },
  ]);
  orders.insertMany([
    { tableNumber: 1, item: "Krabby Patty" },
    { tableNumber: 2, item: "Kelp Shake" },
  ]);

  const results = characters.lookup(
    {},
    {
      from: orders,
      localField: "tableNumber",
      foreignField: "tableNumber",
      as: "orders",
    },
  );
  const itemsFor = (name) =>
    results
      .find((character) => character.name === name)
      .orders.map(({ item }) => item);

  assert.deepEqual(itemsFor("Patrick Star"), ["Krabby Patty"]);
  assert.deepEqual(itemsFor("Squidward Tentacles"), []);
  assert.deepEqual(itemsFor("SpongeBob SquarePants"), []);

  db.close();
});

test("rejects invalid lookup options", () => {
  const db = docqlite(":memory:");
  const otherDb = docqlite(":memory:");
  const characters = db.collection("characters");
  const pets = db.collection("pets");
  const chumBucketPets = otherDb.collection("pets");
  const validOptions = {
    from: pets,
    localField: "name",
    foreignField: "ownerName",
    as: "pets",
  };

  assert.throws(
    () => characters.lookup({}, { ...validOptions, from: "pets" }),
    /DocQLite collection/,
  );
  assert.throws(
    () => characters.lookup({}, { ...validOptions, from: chumBucketPets }),
    /same database/,
  );
  assert.throws(
    () => characters.lookup({}, { ...validOptions, localField: "" }),
    /field path/,
  );
  assert.throws(
    () => characters.lookup({}, { ...validOptions, as: "household..pets" }),
    /field path/,
  );

  otherDb.close();
  db.close();
});
