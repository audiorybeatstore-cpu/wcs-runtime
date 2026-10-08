import test from "node:test";
import assert from "node:assert/strict";
import { runtimeCommands, safePath } from "../src/validation.js";

test("node runtime commands", () => {
  const c = runtimeCommands({ runtime_type: "node", entrypoint: "server.js", runtime_config: {} });
  assert.equal(c.install, "npm install");
  assert.equal(c.start, "npm start");
  assert.equal(c.port, 3000);
});

test("typescript runtime commands", () => {
  const c = runtimeCommands({ runtime_type: "typescript", entrypoint: "src/server.ts", runtime_config: {} });
  assert.equal(c.build, "npm run build");
  assert.equal(c.start, "npm start");
});

test("python runtime commands", () => {
  const c = runtimeCommands({ runtime_type: "python", entrypoint: "app.py", runtime_config: {}, verification: { requirementsTxt: true } });
  assert.equal(c.install, "python3 -m pip install --break-system-packages -r requirements.txt");
  assert.equal(c.start, "python3 app.py");
});

test("container runtime commands", () => {
  const c = runtimeCommands({ runtime_type: "container", entrypoint: "Dockerfile", runtime_config: { port: 8080 } });
  assert.match(c.build, /docker build/);
  assert.equal(c.port, 8080);
});

test("path traversal rejected", () => {
  assert.throws(() => safePath("../secret"));
  assert.throws(() => safePath("a/../../secret"));
});
