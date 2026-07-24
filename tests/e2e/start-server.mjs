import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const stateRoot = ".wrangler/e2e-state";
const configPath = "dist/server/wrangler.e2e.json";
const e2eEnvironment = {
  ...process.env,
  CI: "true",
  WRANGLER_LOG_PATH: ".wrangler/e2e-wrangler.log",
  WRANGLER_WRITE_LOGS: "false",
};

if (process.env.FIELDPROOF_E2E_SKIP_BUILD !== "true") {
  await run(npm, ["run", "build"]);
}

const generatedConfigPath = path.join(root, "dist/server/wrangler.json");
const generatedConfig = JSON.parse(await readFile(generatedConfigPath, "utf8"));
generatedConfig.d1_databases = generatedConfig.d1_databases.map((database) =>
  database.binding === "DB"
    ? { ...database, migrations_dir: "../../drizzle" }
    : database,
);
await writeFile(
  path.join(root, configPath),
  `${JSON.stringify(generatedConfig, null, 2)}\n`,
);

await run(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--config",
    configPath,
    "--persist-to",
    stateRoot,
  ],
  e2eEnvironment,
);

const server = spawn(
  npm,
  ["run", "dev", "--", "-H", "127.0.0.1", "-p", "4173"],
  {
    cwd: root,
    env: {
      ...e2eEnvironment,
      FIELDPROOF_E2E_STATE: stateRoot,
    },
    stdio: "inherit",
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal));
}

server.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with ${signal ?? code ?? "an unknown error"}.`,
          ),
        );
      }
    });
  });
}
