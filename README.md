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
  jellyfishCaught: 42,
  hobbies: ["jellyfishing"],
  address: { city: "Bikini Bottom", street: "124 Conch Street" },
});

const fryCooks = Characters.find({ job: "fry cook" });

console.log(fryCooks);

db.close();
```

## Insert documents

```js
const result = Characters.insertOne({
  name: "Patrick Star",
  job: "professional best friend",
  jellyfishCaught: 15,
  hobbies: ["jellyfishing", "napping"],
  address: { city: "Bikini Bottom", street: "120 Conch Street" },
});

console.log(result.insertedId);
```

If a document does not include `_id`, DocQLite generates a 24-character time-sortable hex string inspired by MongoDB ObjectId. The generated value is stored as a plain string.

You may also provide a custom `_id` value, such as a string, number, boolean, `null`, and even object:

```js
Characters.insertOne({
  _id: "squidward-tentacles",
  name: "Squidward Tentacles",
  job: "cashier",
  jellyfishCaught: 0,
  hobbies: ["playing clarinet", "painting"],
  badges: [],
  address: { city: "Bikini Bottom", street: "122 Conch Street" },
});
```

Custom `_id` values cannot be arrays, regular expressions, `undefined`, functions, symbols, non-finite numbers, or objects with keys that start with `$`.

```js
Characters.insertMany([
  {
    name: "SpongeBob SquarePants",
    job: "fry cook",
    jellyfishCaught: 42,
    krabbyPattiesMade: 1000,
    hobbies: ["jellyfishing"],
    badges: [],
    address: { city: "Bikini Bottom", street: "124 Conch Street" },
  },
  {
    name: "Patrick Star",
    job: "professional best friend",
    jellyfishCaught: 15,
    krabbyPattiesMade: 0,
    hobbies: ["jellyfishing", "napping"],
    badges: ["best-friend"],
    address: { city: "Bikini Bottom", street: "120 Conch Street" },
  },
  {
    name: "Squidward Tentacles",
    job: "cashier",
    jellyfishCaught: 0,
    krabbyPattiesMade: 9,
    hobbies: ["playing clarinet", "painting"],
    badges: ["clarinetist-master", "optimist"],
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
  $and: [{ jellyfishCaught: { $gte: 30 } }, { hobbies: "jellyfishing" }],
});
```

Sorting and pagination:

```js
Characters.find(
  { hobbies: "jellyfishing" },
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
const expertJellyfishers = Characters.countDocuments({
  jellyfishCaught: { $gte: 30 },
});
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

## Look up related documents

`lookup()` joins documents from another collection in the same database, similar to MongoDB's `$lookup` stage. The first argument filters the documents in the current collection. The second argument describes the join:

```js
const Pets = db.collection("pets");

Pets.insertMany([
  { name: "Gary", species: "sea snail", ownerName: "SpongeBob SquarePants" },
  { name: "Rocky", species: "rock", ownerName: "Patrick Star" },
  { name: "Snellie", species: "sea snail", ownerName: "Squidward Tentacles" },
]);

const charactersWithPets = Characters.lookup(
  { "address.city": "Bikini Bottom" },
  {
    from: Pets,
    localField: "name",
    foreignField: "ownerName",
    as: "pets",
  },
);

console.log(charactersWithPets);

// [
//   {
//     name: "SpongeBob SquarePants",
//     ...
//     _id: "...",
//     pets: [
//       { name: "Gary", species: "sea snail", ownerName: "SpongeBob SquarePants", _id: "..." },
//     ],
//   },
//   ...
// ]
```

Lookup options:

- `from`: the collection to join. It must come from the same database.
- `localField`: the field path on documents in the current collection.
- `foreignField`: the field path on documents in the `from` collection.
- `as`: the field path where the array of matching documents is stored.

All of these fields support dot paths:

```js
const Orders = db.collection("orders");

Orders.insertMany([
  { customer: { id: "patrick" }, item: "Krabby Patty" },
  { customer: { id: "patrick" }, item: "Kelp Shake" },
]);

Characters.insertOne({ _id: "patrick", name: "Patrick Star" });

const [patrick] = Characters.lookup(
  { _id: "patrick" },
  {
    from: Orders,
    localField: "_id",
    foreignField: "customer.id",
    as: "receipts.orders",
  },
);

console.log(patrick.receipts.orders.length); // 2
```

Every matching document in the current collection is returned. If nothing in `from` matches, `as` is set to an empty array. Values are matched strictly by JSON type, so `1` does not match `"1"`. Array fields are also compared as whole values, not element by element.

## Update documents

```js
Characters.updateOne(
  { name: "SpongeBob SquarePants" },
  {
    $set: { hasBoatLicense: false },
    $inc: { krabbyPattiesMade: 1 },
  },
);
```

Update many documents:

```js
Characters.updateMany(
  { hobbies: "jellyfishing" },
  {
    $addToSet: { badges: "jellyfishing-champion" },
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
  { name: "Sandy Cheeks" },
  {
    $set: { name: "Sandy Cheeks" },
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
