import { DatabaseSync } from "node:sqlite";

export class SQLiteAdapter {
  #database;
  #transactionDepth = 0;

  constructor(path, options = {}) {
    this.#database = new DatabaseSync(path, options);

    this.#registerFunctions();
    this.exec("PRAGMA journal_mode = WAL");
    this.exec("PRAGMA foreign_keys = ON");
  }

  exec(sql) {
    return this.#database.exec(sql);
  }

  prepare(sql) {
    return this.#database.prepare(sql);
  }

  transaction(fn) {
    return (...args) => {
      const savepoint = `docqlite_transaction_${this.#transactionDepth}`;
      const isNested = this.#transactionDepth > 0;

      this.exec(isNested ? `SAVEPOINT ${savepoint}` : "BEGIN");
      this.#transactionDepth += 1;

      try {
        const result = fn(...args);
        this.#transactionDepth -= 1;
        this.exec(isNested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
        return result;
      } catch (error) {
        this.#transactionDepth -= 1;
        this.exec(isNested ? `ROLLBACK TO SAVEPOINT ${savepoint}` : "ROLLBACK");

        if (isNested) {
          this.exec(`RELEASE SAVEPOINT ${savepoint}`);
        }

        throw error;
      }
    };
  }

  close() {
    this.#database.close();
  }

  #registerFunctions() {
    this.#database.function(
      "regexp",
      { deterministic: true },
      (pattern, value, flags) => {
        if (typeof pattern !== "string" || typeof value !== "string") {
          return 0;
        }

        return new RegExp(pattern, typeof flags === "string" ? flags : "").test(
          value,
        )
          ? 1
          : 0;
      },
    );
  }
}
