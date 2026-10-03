import { Collection } from "./collection.js";
import { SQLiteAdapter } from "./sqlite.js";

export class Database {
  constructor(path, options = {}) {
    if (typeof path !== "string" || path.trim() === "") {
      throw new TypeError("Database path must be a non-empty string");
    }

    this.sqlite = new SQLiteAdapter(path, options);
    this.collections = new Map();
  }

  collection(name) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new Collection(this.sqlite, name));
    }

    return this.collections.get(name);
  }

  exec(sql) {
    return this.sqlite.exec(sql);
  }

  prepare(sql) {
    return this.sqlite.prepare(sql);
  }

  transaction(fn) {
    return this.sqlite.transaction(fn);
  }

  close() {
    this.sqlite.close();
  }
}
