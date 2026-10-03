import { Database } from "./database.js";
import { Collection } from "./collection.js";
import { createId } from "./id.js";

export function docqlite(path, options) {
  return new Database(path, options);
}

export { Collection, createId, Database };
export default docqlite;
