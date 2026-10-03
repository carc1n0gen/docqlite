import { randomBytes } from "node:crypto";

const processRandom = randomBytes(5);
let counter = randomBytes(3).readUIntBE(0, 3);

// Generates a time sortable similar to MongoDB ObjectId.
// The first 4 bytes are the current timestamp in seconds since the epoch.
// The next 5 bytes are a random value generated once per process.
// The last 3 bytes are an incrementing counter, initialized to a random value.
export function createId() {
  const buffer = Buffer.allocUnsafe(12);

  buffer.writeUInt32BE(Math.floor(Date.now() / 1000), 0);
  processRandom.copy(buffer, 4);

  counter = (counter + 1) % 0x1000000;
  buffer.writeUIntBE(counter, 9, 3);

  return buffer.toString("hex");
}
