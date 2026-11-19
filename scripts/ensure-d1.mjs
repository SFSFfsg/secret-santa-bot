// Находит базу D1 «secret-santa-db» в аккаунте Cloudflare (или создаёт её) и подставляет её номер в wrangler.jsonc.
// Запускается автоматически при публикации — вручную ничего делать не нужно.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const NAME = "secret-santa-db";
const run = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const find = () => JSON.parse(run("npx wrangler d1 list --json")).find((d) => d.name === NAME);

let db = find();
if (!db) {
  console.log(`Создаю базу D1 «${NAME}»…`);
  run(`npx wrangler d1 create ${NAME}`);
  db = find();
}
const id = db?.uuid ?? db?.id;
if (!id) throw new Error("Не удалось найти или создать базу D1");
const cfg = readFileSync("wrangler.jsonc", "utf8").replace(/"database_id":\s*"[^"]*"/, `"database_id": "${id}"`);
writeFileSync("wrangler.jsonc", cfg);
console.log(`База D1 «${NAME}» готова.`);
