import test from "node:test";
import assert from "node:assert/strict";
import docqlite, { createId } from "../src/index.js";

const generatedIdPattern = /^[0-9a-f]{24}$/;

const spongebob = {
  name: "SpongeBob SquarePants",
  job: "fry cook",
  hobbies: ["jellyfishing"],
  badges: ["employee of the month"],
  jellyfishCaught: 42,
  onShift: true,
  boatingLicense: null,
  krabbyPattyRatings: [4, 10, 10],
  address: { city: "Bikini Bottom", street: "124 Conch Street" },
};

const patrick = {
  name: "Patrick Star",
  job: "professional best friend",
  hobbies: ["jellyfishing", "napping"],
  badges: ["goober"],
  jellyfishCaught: 15,
  onShift: false,
  krabbyPattyRatings: [3, 10],
  address: { city: "Bikini Bottom", street: "120 Conch Street" },
};

const squidward = {
  name: "Squidward Tentacles",
  job: "cashier",
  hobbies: ["clarinet", "painting"],
  badges: ["grumpy", "optimist"],
  jellyfishCaught: 0,
  onShift: true,
  krabbyPattyRatings: [1, 2, 6],
  address: { city: "Bikini Bottom", street: "122 Conch Street" },
};

const plankton = {
  name: "Plankton",
  job: "Chum Bucket owner",
};

const customIdCharacters = [
  { _id: "1", name: "Gary the Snail" },
  { _id: 1, name: "Sandy Cheeks" },
  { _id: null, name: "Mrs. Puff" },
  { _id: true, name: "Pearl Krabs" },
  { _id: { restaurant: "krusty-krab", role: "owner" }, name: "Mr. Krabs" },
];

const invalidIdCharacters = [
  { document: { _id: [], name: "Larry the Lobster" }, error: /array/ },
  { document: { _id: /sponge/, name: "Mermaid Man" }, error: /RegExp/ },
  {
    document: { _id: { $oid: "abc" }, name: "Barnacle Boy" },
    error: /cannot start with \$/,
  },
  {
    document: { _id: { nested: { $bad: true } }, name: "Flying Dutchman" },
    error: /cannot start with \$/,
  },
  {
    document: { _id: undefined, name: "Patchy the Pirate" },
    error: /JSON serializable/,
  },
  {
    document: { _id: Number.NaN, name: "Squilliam Fancyson" },
    error: /JSON serializable/,
  },
];

test("generates time-sortable ObjectId-like ids", () => {
  const ids = Array.from({ length: 5 }, () => createId());

  assert(ids.every((id) => generatedIdPattern.test(id)));
  assert.deepEqual([...ids].sort(), ids);
});

test("creates collections and inserts one document", () => {
  const db = docqlite(":memory:");
  const characters = db.collection("characters");

  const result = characters.insertOne(spongebob);

  assert.equal(result.acknowledged, true);
  assert.match(result.insertedId, generatedIdPattern);
  assert.deepEqual(characters.findOne({ _id: result.insertedId }), {
    _id: result.insertedId,
    ...spongebob,
  });

  db.close();
});

test("inserts many documents inside one transaction", () => {
  const db = docqlite(":memory:");
  const characters = db.collection("characters");

  const results = characters.insertMany([spongebob, patrick, squidward]);

  assert.equal(results.acknowledged, true);
  assert.equal(results.insertedCount, 3);
  assert.equal(characters.countDocuments(), 3);

  db.close();
});

test("queries with equality, nested paths, operators, sorting, and limits", () => {
  const db = docqlite(":memory:");
  const characters = db.collection("characters");

  const results = characters.insertMany([spongebob, patrick, squidward]);

  assert.deepEqual(
    characters
      .find(
        {
          $and: [
            { jellyfishCaught: { $gte: 10 } },
            { hobbies: "jellyfishing" },
          ],
        },
        {
          sort: { jellyfishCaught: -1 },
          limit: 1,
        },
      )
      .map(({ _id }) => _id),
    [results.insertedIds[0]],
  );

  assert.equal(
    characters.findOne({ "address.street": patrick.address.street })._id,
    results.insertedIds[1],
  );

  db.close();
});

test("looks up related documents for find and findOne", () => {
  const db = docqlite(":memory:");
  const characters = db.collection("characters");
  const orders = db.collection("orders");

  const results = characters.insertMany([spongebob, patrick, squidward]);
  orders.insertMany([
    { item: "Krabby Patty", customerId: results.insertedIds[0] },
    { item: "Kelp Shake", customerId: results.insertedIds[0] },
    { item: "Coral Bits", customerId: results.insertedIds[1] },
    { item: "Invisible Boatmobile Wax", customerId: "unknown" },
  ]);

  assert.equal(
    orders.createIndex({ customerId: 1 }, { name: "orders_customer_id_idx" }),
    "orders_customer_id_idx",
  );
  const spongebobWithOrders = characters.findOne(
    { _id: results.insertedIds[0] },
    {
      lookup: {
        from: orders,
        localField: "_id",
        foreignField: "customerId",
        as: "orders",
      },
    },
  );

  assert.deepEqual(spongebobWithOrders.orders.map(({ item }) => item).sort(), [
    "Kelp Shake",
    "Krabby Patty",
  ]);

  const charactersWithOrders = characters.find(
    {},
    {
      sort: { name: 1 },
      lookup: {
        from: orders,
        localField: "_id",
        foreignField: "customerId",
        as: "orders",
      },
    },
  );

  assert.deepEqual(
    charactersWithOrders.map((character) => [
      character.name,
      character.orders.map(({ item }) => item).sort(),
    ]),
    [
      [patrick.name, ["Coral Bits"]],
      [spongebob.name, ["Kelp Shake", "Krabby Patty"]],
      [squidward.name, []],
    ],
  );

  const ordersWithCustomers = orders.find(
    {},
    {
      sort: { item: 1 },
      lookup: {
        from: characters,
        localField: "customerId",
        foreignField: "_id",
        justOne: true,
        as: "customer",
      },
    },
  );

  assert.deepEqual(
    ordersWithCustomers.map((order) => [
      order.item,
      order.customer?.name ?? null,
    ]),
    [
      ["Coral Bits", patrick.name],
      ["Invisible Boatmobile Wax", null],
      ["Kelp Shake", spongebob.name],
      ["Krabby Patty", spongebob.name],
    ],
  );

  db.close();
});

test("creates indexes for document fields", () => {
  const db = docqlite(":memory:");
  const characters = db.collection("characters");

  const indexName = characters.createIndex(
    { "address.city": 1, jellyfishCaught: -1 },
    { name: "characters_city_jellyfish_idx" },
  );

  assert.equal(indexName, "characters_city_jellyfish_idx");

  const index = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(indexName);

  assert.match(
    index.sql,
    /json_extract\(document, '\$\."address"\."city"'\) ASC/,
  );
  assert.match(
    index.sql,
    /json_extract\(document, '\$\."jellyfishCaught"'\) DESC/,
  );

  assert.equal(
    characters.createIndex({ name: 1 }, { unique: true }),
    "characters_name_asc_idx",
  );
  assert.equal(characters.createIndex({ _id: 1 }), "_id_");
  assert.throws(() => characters.createIndex({}), /at least one field/);

  db.close();
});

test("updates one matching document with Mongo-like operators", () => {
  const db = docqlite(":memory:");
  const characters = db.collection("characters");

  const results = characters.insertMany([spongebob, patrick, squidward]);

  const result = characters.updateOne(
    { name: spongebob.name },
    {
      $set: { "address.city": "Rock Bottom" },
      $inc: { jellyfishCaught: 1 },
      $unset: { boatingLicense: "" },
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

  const updatedSpongebob = characters.findOne({ _id: results.insertedIds[0] });

  assert.equal(updatedSpongebob.jellyfishCaught, spongebob.jellyfishCaught + 1);
  assert.equal(updatedSpongebob.address.city, "Rock Bottom");
  assert.equal(Object.hasOwn(updatedSpongebob, "boatingLicense"), false);
  assert.deepEqual(updatedSpongebob.hobbies, [
    ...spongebob.hobbies,
    "blowing bubbles",
  ]);
  assert.equal(
    characters.findOne({ _id: results.insertedIds[1] }).jellyfishCaught,
    patrick.jellyfishCaught,
  );
  assert.equal(
    characters.findOne({ _id: results.insertedIds[2] }).jellyfishCaught,
    squidward.jellyfishCaught,
  );

  db.close();
});

test("updates many documents and supports addToSet and pull", () => {
  const db = docqlite(":memory:");
  const characters = db.collection("characters");

  const results = characters.insertMany([spongebob, patrick, squidward]);

  const result = characters.updateMany(
    { onShift: true },
    {
      $addToSet: {
        badges: { $each: ["employee of the month", "krusty krew"] },
      },
      $pull: { krabbyPattyRatings: { $lt: 5 } },
    },
  );

  assert.equal(result.matchedCount, 2);
  assert.equal(result.modifiedCount, 2);

  const updatedSpongebob = characters.findOne({ _id: results.insertedIds[0] });
  const updatedPatrick = characters.findOne({ _id: results.insertedIds[1] });
  const updatedSquidward = characters.findOne({ _id: results.insertedIds[2] });

  assert.deepEqual(updatedSpongebob.badges, [
    "employee of the month",
    "krusty krew",
  ]);
  assert.deepEqual(updatedSpongebob.krabbyPattyRatings, [10, 10]);
  assert.deepEqual(updatedSquidward.badges, [
    "grumpy",
    "optimist",
    "employee of the month",
    "krusty krew",
  ]);
  assert.deepEqual(updatedSquidward.krabbyPattyRatings, [6]);
  assert.deepEqual(updatedPatrick.badges, patrick.badges);
  assert.deepEqual(
    updatedPatrick.krabbyPattyRatings,
    patrick.krabbyPattyRatings,
  );

  db.close();
});

test("upserts a document when updateOne has no matches", () => {
  const db = docqlite(":memory:");
  const characters = db.collection("characters");

  const result = characters.updateOne(
    { name: plankton.name },
    {
      $set: { job: plankton.job },
      $setOnInsert: { createdBy: "Karen" },
      $inc: { formulaTheftAttempts: 1 },
    },
    { upsert: true },
  );

  assert.equal(result.matchedCount, 0);
  assert.equal(result.modifiedCount, 0);
  assert.equal(result.upsertedCount, 1);
  assert.match(result.upsertedId, generatedIdPattern);
  assert.deepEqual(characters.findOne({ _id: result.upsertedId }), {
    _id: result.upsertedId,
    ...plankton,
    createdBy: "Karen",
    formulaTheftAttempts: 1,
  });

  db.close();
});

test("allows custom _id values while keeping _id immutable", () => {
  const db = docqlite(":memory:");
  const characters = db.collection("characters");

  const results = characters.insertMany(customIdCharacters);

  assert.equal(characters.countDocuments(), customIdCharacters.length);

  for (const [index, character] of customIdCharacters.entries()) {
    assert.deepEqual(results.insertedIds[index], character._id);
    assert.equal(
      characters.findOne({ _id: results.insertedIds[index] }).name,
      character.name,
    );
  }

  assert.deepEqual(
    characters
      .find({ _id: { $in: [results.insertedIds[0], results.insertedIds[4]] } })
      .map(({ name }) => name)
      .sort(),
    [customIdCharacters[0].name, customIdCharacters[4].name].sort(),
  );

  assert.throws(
    () =>
      characters.updateOne(
        { _id: results.insertedIds[0] },
        { $set: { _id: results.insertedIds[1] } },
      ),
    /immutable field _id/,
  );

  assert.equal(
    characters.findOne({ _id: results.insertedIds[0] }).name,
    customIdCharacters[0].name,
  );

  db.close();
});

test("rejects invalid _id values", () => {
  const db = docqlite(":memory:");
  const characters = db.collection("characters");

  for (const { document, error } of invalidIdCharacters) {
    assert.throws(() => characters.insertOne(document), error);
  }

  assert.equal(characters.countDocuments(), 0);

  db.close();
});

test("deletes one matching document", () => {
  const db = docqlite(":memory:");
  const characters = db.collection("characters");

  const results = characters.insertMany([spongebob, patrick, squidward]);

  const result = characters.deleteOne({ onShift: true });

  assert.deepEqual(result, { acknowledged: true, deletedCount: 1 });
  assert.equal(characters.countDocuments(), 2);
  assert.equal(characters.findOne({ _id: results.insertedIds[0] }), null);
  assert.equal(
    characters.findOne({ _id: results.insertedIds[2] })._id,
    results.insertedIds[2],
  );

  assert.deepEqual(characters.deleteOne({ name: plankton.name }), {
    acknowledged: true,
    deletedCount: 0,
  });
  assert.equal(characters.countDocuments(), 2);

  db.close();
});

test("deletes many matching documents", () => {
  const db = docqlite(":memory:");
  const characters = db.collection("characters");

  const results = characters.insertMany([spongebob, patrick, squidward]);

  const result = characters.deleteMany({ hobbies: "jellyfishing" });

  assert.deepEqual(result, { acknowledged: true, deletedCount: 2 });
  assert.deepEqual(
    characters.find().map(({ _id }) => _id),
    [results.insertedIds[2]],
  );

  assert.deepEqual(characters.deleteMany(), {
    acknowledged: true,
    deletedCount: 1,
  });
  assert.equal(characters.countDocuments(), 0);

  db.close();
});

test("queries with object, array, null, boolean, regex, and exists filters", () => {
  const db = docqlite(":memory:");
  const characters = db.collection("characters");

  const results = characters.insertMany([spongebob, patrick, squidward]);

  assert.equal(
    characters.findOne({ address: spongebob.address })._id,
    results.insertedIds[0],
  );
  assert.equal(
    characters.findOne({ hobbies: patrick.hobbies })._id,
    results.insertedIds[1],
  );
  assert.equal(
    characters.findOne({ boatingLicense: null })._id,
    results.insertedIds[0],
  );
  assert.equal(characters.countDocuments({ onShift: true }), 2);
  assert.equal(
    characters.findOne({
      name: { $regex: "^spongebob squarepants$", $options: "i" },
    })._id,
    results.insertedIds[0],
  );
  assert.equal(
    characters.countDocuments({ boatingLicense: { $exists: false } }),
    2,
  );

  db.close();
});
