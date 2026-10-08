export function safePath(value) {
  const path = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!path || path.includes("..") || path.includes("\0")) throw new Error("Invalid runtime path.");
  return path;
}

export function runtimeCommands(meta) {
  const type = String(meta.runtime_type || "").toLowerCase();
  const entrypoint = safePath(meta.entrypoint || "");
  const config = meta.runtime_config && typeof meta.runtime_config === "object" ? meta.runtime_config : {};
  const build = typeof config.buildCommand === "string" && config.buildCommand.trim() ? config.buildCommand.trim() : null;
  const start = typeof config.startCommand === "string" && config.startCommand.trim() ? config.startCommand.trim() : null;
  const port = Number(config.port || 0);
  if (port && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("Invalid HTTP port.");

  if (["javascript", "node"].includes(type)) {
    return { install: "npm install", build, start: start || "npm start", port: port || 3000 };
  }
  if (type === "typescript") {
    return { install: "npm install", build: build || "npm run build", start: start || "npm start", port: port || 3000 };
  }
  if (type === "python") {
    const install = meta.verification?.requirementsTxt ? "python3 -m pip install --break-system-packages -r requirements.txt" : "python3 -m pip install --break-system-packages .";
    return { install, build, start: start || `python3 ${entrypoint}`, port: port || 8000 };
  }
  if (type === "container") {
    return { install: null, build: build || "docker build --network=host -t wcs-user-app .", start: start || "docker run --rm --network=host -p 3000:3000 wcs-user-app", port: port || 3000 };
  }
  throw new Error(`Unsupported runtime type: ${type}`);
}

export function assertInternalHeaders(headers) {
  if (headers.get("X-WebCode-Runtime") !== "webcode") throw new Error("Unauthorized runtime request.");
  const deployment = headers.get("X-WebCode-Deployment");
  const project = headers.get("X-WebCode-Project");
  if (!deployment || !project) throw new Error("Missing runtime deployment identity.");
  return { deployment, project };
}
