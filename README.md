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
  tags: ["krusty-krab", "jellyfisher"],
});

const fryCooks = Characters.find({ job: "fry cook" });

console.log(fryCooks);

db.close();
```

## Insert documents

```js
const result = Characters.insertOne({
  name: "Patrick Star",
  home: "under a rock",
});

console.log(result.insertedId);
```

If a document does not include `_id`, DocQLite generates a 24-character time-sortable hex string inspired by MongoDB ObjectId. The generated value is stored as a plain string.

You may also provide a custom MongoDB-style `_id` value, such as a string, number, boolean, `null`, or object:

```js
Characters.insertOne({
  _id: "spongebob",
  name: "SpongeBob SquarePants",
});
```

Custom `_id` values cannot be arrays, regular expressions, `undefined`, functions, symbols, non-finite numbers, or objects with keys that start with `$`.

```js
Characters.insertMany([
  {
    name: "SpongeBob SquarePants",
    email: "spongebob@krustykrab.example",
    job: "fry cook",
    location: "Krusty Krab",
    onShift: true,
    jellyfishCaught: 42,
    krabbyPattiesMade: 100,
    tags: ["krusty-krab", "jellyfisher"],
    address: { city: "Bikini Bottom" },
  },
  {
    name: "Patrick Star",
    job: "professional best friend",
    location: "Bikini Bottom",
    onShift: false,
    jellyfishCaught: 5,
    tags: ["jellyfisher"],
    address: { city: "Bikini Bottom" },
  },
  {
    name: "Squidward Tentacles",
    job: "cashier",
    location: "Krusty Krab",
    onShift: true,
    jellyfishCaught: 0,
    tags: ["krusty-krab", "happy"],
    address: { city: "Bikini Bottom" },
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
  { onShift: true },
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
    $set: { onShift: true },
    $inc: { krabbyPattiesMade: 1 },
  },
);
```

Update many documents:

```js
Characters.updateMany(
  { location: "Krusty Krab" },
  {
    $addToSet: { tags: "krusty-krab" },
  },
);
```

Array updates:

```js
Characters.updateOne(
  { name: "SpongeBob SquarePants" },
  {
    $push: { tags: "bubble-blower" },
  },
);

Characters.updateOne(
  { name: "Squidward Tentacles" },
  {
    $pull: { tags: "happy" },
  },
);
```

Upsert:

```js
Characters.updateOne(
  { email: "spongebob@krustykrab.example" },
  {
    $set: { name: "SpongeBob SquarePants", onShift: true },
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

## Notes

- DocQLite stores documents as JSON in SQLite.
- Date values should be stored as strings, for example `new Date().toISOString()`.
- `_id` is unique and immutable after insert.
- Custom MongoDB-style `_id` values are allowed. If omitted, DocQLite generates one with `createId()`.
- Query filters are translated into SQLite JSON operations where possible.
- This package is intended for local/server-side Node.js usage, not browser or Edge runtime usage.
