# DocQLite

DocQLite is a small SQLite-backed document store for Node.js. It stores JSON documents in SQLite and provides a MongoDB-like collection API for common insert, query, and update operations.

DocQLite is synchronous and dependency-free. It uses Node.js' built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) module.

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

## Notes

- DocQLite stores documents as JSON in SQLite.
- Date values should be stored as strings, for example `new Date().toISOString()`.
- `_id` is unique and immutable after insert.
- Custom MongoDB-style `_id` values are allowed. If omitted, DocQLite generates one with `createId()`.
- Query filters are translated into SQLite JSON operations where possible.
- This package is intended for local/server-side Node.js usage, not browser or Edge runtime usage.
