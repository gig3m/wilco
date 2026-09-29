import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

test("node:sqlite opens an in-memory database", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (a TEXT)");
  db.prepare("INSERT INTO t (a) VALUES (?)").run("hello");
  const row = db.prepare("SELECT a FROM t").get() as { a: string };
  assert.equal(row.a, "hello");
  db.close();
});

test("FTS5 is compiled in and MATCH works", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE VIRTUAL TABLE f USING fts5(body, tokenize = 'unicode61 remove_diacritics 2')`,
  );
  db.prepare("INSERT INTO f (body) VALUES (?)").run("the quick brown fox");
  const hit = db.prepare("SELECT count(*) AS c FROM f WHERE f MATCH ?").get('"brown"*') as {
    c: number;
  };
  assert.equal(hit.c, 1);
  db.close();
});

test("FTS5 tokenizer is remove_diacritics 2, not merely the unicode61 default", () => {
  // "thế" carries TWO diacritics. remove_diacritics 1 cannot fold it; 2 can.
  // Asserting both halves is what stops this test passing under the default
  // tokenizer, which is the vacuous pass it replaces.
  const folds = (tokenize: string): number => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE VIRTUAL TABLE f USING fts5(body, tokenize = '${tokenize}')`);
    db.prepare("INSERT INTO f (body) VALUES (?)").run("thế");
    const { c } = db.prepare("SELECT count(*) AS c FROM f WHERE f MATCH ?").get('"the"*') as {
      c: number;
    };
    db.close();
    return c;
  };

  assert.equal(folds("unicode61 remove_diacritics 2"), 1, "the config we ship must fold it");
  assert.equal(folds("unicode61 remove_diacritics 1"), 0, "mode 1 cannot; this is what makes the test discriminating");
});
