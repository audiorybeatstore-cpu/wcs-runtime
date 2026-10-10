import { DurableObject } from "cloudflare:workers";
import { assertInternalHeaders, runtimeCommands, safePath } from "./validation.js";

const WORKSPACE = "/workspace";
const READY_TIMEOUT_MS = 60000;
const COMMAND_TIMEOUT_SECONDS = 900;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function shell(argv) {
  return ["timeout", "--kill-after=10", String(COMMAND_TIMEOUT_SECONDS), "sh", "-lc", argv];
}

async function readResult(process) {
  const result = await process.output();
  const decoder = new TextDecoder();
  return { exitCode: result.exitCode, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
}

async function exec(container, command, cwd = WORKSPACE) {
  const process = await container.exec(shell(command), { cwd });
  const result = await readResult(process);
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || `Command failed: ${command}`).slice(-12000);
    throw new Error(detail);
  }
  return result;
}

async function waitForPort(container, port) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await container.getTcpPort(port).fetch(`http://container/`, { signal: AbortSignal.timeout(1500) });
      await response.body?.cancel();
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Runtime did not become ready on HTTP port ${port}.`);
}

async function copySource(bucket, prefix, container) {
  const manifestObject = await bucket.get(`${prefix}/_manifest.json`);
  if (!manifestObject) throw new Error("Runtime source manifest was not found.");
  const manifest = await manifestObject.json();
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error("Runtime source manifest is empty.");
  await exec(container, `rm -rf ${WORKSPACE} && mkdir -p ${WORKSPACE}`);
  for (const file of manifest.files) {
    const path = safePath(file.path);
    const object = await bucket.get(`${prefix}/${path}`);
    if (!object) throw new Error(`Runtime source object missing: ${path}`);
    const bytes = new Uint8Array(await object.arrayBuffer());
    const encoded = Array.from(bytes, b => String.fromCharCode(b)).join("");
    const base64 = btoa(encoded);
    const target = `${WORKSPACE}/${path}`;
    const dir = target.slice(0, target.lastIndexOf("/"));
    await exec(container, `mkdir -p ${JSON.stringify(dir)} && printf '%s' ${JSON.stringify(base64)} | base64 -d > ${JSON.stringify(target)}`);
  }
  return manifest;
}

export class RuntimeContainer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.container = ctx.container;
    this.env = env;
  }

  async ensureRunning() {
    if (!this.container) throw new Error("Runtime container binding is unavailable.");
    if (!this.container.running) {
      this.container.start({ image: this.container.images.runtime, instance: "standard-1", enableInternet: true });
      await this.container.setInactivityTimeout(30 * 60 * 1000);
    }
  }

  async deploy(meta) {
    await this.ensureRunning();
    const commands = runtimeCommands(meta);
    await copySource(this.env.SOURCE_BUCKET, meta.source_prefix, this.container);
    await this.ctx.storage.put("port", commands.port);
    await this.ctx.storage.put("deployment", meta.deployment_id);
    await exec(this.container, "rm -f /tmp/wcs-start.log /tmp/wcs-start.pid");

    if (meta.runtime_type === "container") {
      await exec(this.container, commands.build);
      const start = `${commands.start} > /tmp/wcs-start.log 2>&1 & echo $! > /tmp/wcs-start.pid`;
      await exec(this.container, start);
    } else {
      if (commands.install) await exec(this.container, commands.install);
      if (commands.build) await exec(this.container, commands.build);
      const start = `${commands.start} > /tmp/wcs-start.log 2>&1 & echo $! > /tmp/wcs-start.pid`;
      await exec(this.container, start);
    }

    await waitForPort(this.container, commands.port);
    return { ok: true, status: "success", port: commands.port, deployment_id: meta.deployment_id };
  }

  async fetch(request) {
    if (request.method === "POST") {
      const body = await request.json();
      return json(await this.deploy(body));
    }
    const storedPort = await this.ctx.storage.get("port");
    const port = Number(request.headers.get("X-WebCode-Port") || storedPort || 3000);
    return this.container.getTcpPort(port).fetch(request);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "wcs-runtime", version: "1.0.0" });
    try {
      const identity = assertInternalHeaders(request.headers, env);
      const deploymentId = identity.deployment;
      const stub = env.RUNTIME_CONTAINER.get(env.RUNTIME_CONTAINER.idFromName(deploymentId));

      if (url.pathname === "/deploy" && request.method === "POST") {
        const body = await request.json();
        if (body.deployment_id !== deploymentId) return json({ error: "Deployment identity mismatch." }, 400);
        if (!body.source_prefix || !body.commit_sha || !body.runtime_type) return json({ error: "Incomplete runtime deployment metadata." }, 400);
        const result = await stub.deploy(body);
        return json(result, result.ok ? 200 : 502);
      }

      const headers = new Headers(request.headers);
      const port = Number(bodyPortFromHeaders(headers) || 3000);
      headers.set("X-WebCode-Port", String(port));
      const target = new Request(new URL(url.pathname + url.search, "https://runtime.internal"), { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body });
      return await stub.fetch(target);
    } catch (error) {
      return json({ error: String(error?.message || error) }, 403);
    }
  }
};

function bodyPortFromHeaders(headers) {
  const value = headers.get("X-WebCode-Port");
  return value && /^\d+$/.test(value) ? Number(value) : null;
}
