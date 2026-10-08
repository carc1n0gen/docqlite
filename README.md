# DocQLite

DocQLite is a small document store for Node.js with a MongoDB like API, and uses SQLite under the hood for storage. It is synchronous and dependency-free, as it uses the built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) module.

## Installation

```sh
npm install docqlite
```

## Basic usage

```js
import docqlite from "docqlite";

const db = docqlite("bikini-bottom.db");
const Characters = db.collection("characters");

Characters.insertOne({
  name: "SpongeBob SquarePants",
  job: "fry cook",
  hobbies: ["jellyfishing"],
  badges: ["employee of the month"],
  jellyfishCaught: 42,
  address: { city: "Bikini Bottom", street: "124 Conch Street" },
});

const fryCooks = Characters.find({ job: "fry cook" });

console.log(fryCooks);

db.close();
```

## Insert a document

```js
const result = Characters.insertOne({
  name: "Patrick Star",
  job: "professional best friend",
  hobbies: ["jellyfishing", "napping"],
  badges: ["goober"],
  jellyfishCaught: 15,
  address: { city: "Bikini Bottom", street: "120 Conch Street" },
});

console.log(result.insertedId);
```

If a document does not include `_id`, DocQLite generates a 24-character time-sortable hex string inspired by MongoDB ObjectId. The generated value is stored as a plain string. A custom `_id` value must be a string, number, boolean, `null`, or object:

```js
Characters.insertOne({
  _id: "squidward",
  name: "Squidward Tentacles",
  job: "cashier",
  hobbies: ["clarinet", "painting"],
  badges: ["grumpy", "optimist"],
  jellyfishCaught: 0,
  address: { city: "Bikini Bottom", street: "122 Conch Street" },
});
```

Insert many documents:

```js
Characters.insertMany([
  {
    name: "SpongeBob SquarePants",
    job: "fry cook",
    hobbies: ["jellyfishing"],
    badges: ["employee of the month"],
    jellyfishCaught: 42,
    address: { city: "Bikini Bottom", street: "124 Conch Street" },
  },
  {
    name: "Patrick Star",
    job: "professional best friend",
    hobbies: ["jellyfishing", "napping"],
    badges: ["goober"],
    jellyfishCaught: 15,
    address: { city: "Bikini Bottom", street: "120 Conch Street" },
  },
  {
    name: "Squidward Tentacles",
    job: "cashier",
    hobbies: ["clarinet", "painting"],
    badges: ["grumpy", "optimist"],
    jellyfishCaught: 0,
    address: { city: "Bikini Bottom", street: "122 Conch Street" },
  },
]);
```

## Query documents

```js
Characters.find({ name: "SpongeBob SquarePants" });
```

Comparison operators:

```js
Characters.find({
  jellyfishCaught: { $gte: 30 },
});
```

Nested fields:

```js
Characters.find({
  "address.city": "Bikini Bottom",
});
```

Logical operators:

```js
Characters.find({
  $and: [{ jellyfishCaught: { $gte: 30 } }, { tags: "jellyfisher" }],
});
```

Sorting and pagination:

```js
Characters.find(
  {},
  {
    sort: { jellyfishCaught: -1 },
    limit: 10,
    skip: 20,
  },
);
```

Find one document:

```js
const character = Characters.findOne({ name: "SpongeBob SquarePants" });
```

Look up related documents from another collection:

```js
const character = Characters.findOne(
  { name: "Patrick Star" },
  {
    lookup: {
      from: Orders,
      localField: "_id",
      foreignField: "customerId",
      as: "orders",
    },
  },
);

console.log(character.orders); // array of matching order documents
```

Use `justOne: true` for many-to-one relationships:

```js
const orders = Orders.find(
  {},
  {
    lookup: {
      from: Characters,
      localField: "customerId",
      foreignField: "_id",
      justOne: true,
      as: "customer",
    },
  },
);

console.log(orders[0].customer); // matching character document, or null
```

`lookup.from` should be another DocQLite collection from the same database connection. Without `justOne`, the `as` field is always an array. With `justOne`, the `as` field is a single document or `null`.

Count documents:

```js
const onShiftCharacters = Characters.countDocuments({ onShift: true });
```

Supported query operators:

```text
$eq
$ne
$gt
$gte
$lt
$lte
$in
$nin
$exists
$regex
$and
$or
$nor
```

## Update documents

```js
Characters.updateOne(
  { name: "SpongeBob SquarePants" },
  {
    $set: { hasBoatLicense: false },
    $inc: { jellyfishCaught: 1 },
  },
);
```

Update many documents:

```js
Characters.updateMany(
  { $gt: { jellyfishCaught: 40 } },
  {
    $addToSet: { badges: "professional jellyfisher" },
  },
);
```

Array updates:

```js
Characters.updateOne(
  { name: "SpongeBob SquarePants" },
  {
    $push: { hobbies: "blowing bubbles" },
  },
);

Characters.updateOne(
  { name: "Squidward Tentacles" },
  {
    $pull: { badges: "optimist" },
  },
);
```

Upsert:

```js
Characters.updateOne(
  { name: "Plankton" },
  {
    $set: { name: "Plankton" },
    $setOnInsert: { createdAt: new Date().toISOString() },
  },
  { upsert: true },
);
```

Supported update operators:

```text
$set
$unset
$inc
$push
$pull
$addToSet
$setOnInsert
```

## Delete documents

Delete the first matching document:

```js
Characters.deleteOne({ name: "Plankton" });
```

Delete every matching document:

```js
const result = Characters.deleteMany({ onShift: false });

console.log(result.deletedCount);
```

Both methods accept the same query filters as `find`. Calling `deleteMany()` with no filter deletes every document in the collection.

## Creating Indexes

DocQLite compiles field paths into SQLite JSON expressions, so consumers can add SQLite expression indexes for document fields that are queried often. `createIndex` returns the index name.

Create an index when you repeatedly filter or sort by the same field:

```js
Characters.createIndex({ name: 1 });
Characters.find({ name: "Patrick Star" });

Characters.createIndex({ jellyfishCaught: -1 });
Characters.find({}, { sort: { jellyfishCaught: -1 } });
```

Nested document fields can be indexed with dot paths:

```js
Characters.createIndex({ "address.city": 1 });
Characters.find({ "address.city": "Bikini Bottom" });
```

Use compound indexes when the same query commonly uses multiple fields together, especially a filter followed by a sort:

```js
Characters.createIndex({ "address.city": 1, jellyfishCaught: -1 });

Characters.find(
  { "address.city": "Bikini Bottom" },
  { sort: { jellyfishCaught: -1 } },
);
```

Use a unique index when a document field should not be duplicated:

```js
Characters.createIndex({ name: 1 }, { unique: true });
```

Use `name` when you want a stable index name for migrations, debugging, or database inspection:

```js
Characters.createIndex(
  { "address.city": 1, jellyfishCaught: -1 },
  { name: "characters_city_jellyfish_idx" },
);
```

For `lookup`, index the looked-up collection's `foreignField`. For example, this lookup searches `Orders` by `customerId`:

```js
Characters.find(
  {},
  {
    lookup: {
      from: Orders,
      localField: "_id",
      foreignField: "customerId",
      as: "orders",
    },
  },
);

Orders.createIndex({ customerId: 1 });
```

You generally do not need indexes for fields that are rarely queried, fields on very small collections, or fields with values that change very frequently. Extra indexes can improve reads but add work to inserts and updates.

You do not need to create an index for `_id`. DocQLite stores `_id` in the collection's primary key column and uses that primary key for `_id` equality queries and lookups where `foreignField` is `_id`.
