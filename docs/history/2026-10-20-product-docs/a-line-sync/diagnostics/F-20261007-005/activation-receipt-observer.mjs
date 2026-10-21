const MAX_STRUCTURED_JSON_BYTES = 4096;
const MAX_PID = 0x7fffffff;
const MAX_U32 = 0xffffffff;
const SCHEMA = "cua.frontmost_window_diagnostic.v1";
const SOURCE = "observe_exact_window_existing_visible_windows_snapshot";
const STATES = new Set(["present", "missing", "invalid"]);
const RELATIONS = new Set(["same", "different", "unknown"]);

function isSafeInt(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function projectDiagnostic(structuredJson) {
  if (typeof structuredJson !== "string" || structuredJson.length > MAX_STRUCTURED_JSON_BYTES
    || Buffer.byteLength(structuredJson, "utf8") > MAX_STRUCTURED_JSON_BYTES) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(structuredJson);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const observed = parsed.observed;
  if (observed === null || typeof observed !== "object" || Array.isArray(observed)) return undefined;
  const diagnostic = observed.frontmost_window_diagnostic;
  if (diagnostic === null || typeof diagnostic !== "object" || Array.isArray(diagnostic)) return undefined;
  if (diagnostic.schema !== SCHEMA || diagnostic.source !== SOURCE || !STATES.has(diagnostic.state)
    || diagnostic.state !== "present") return undefined;

  const { frontmost_window_pid: pid, frontmost_window_id: windowId, layer, z, is_on_screen: isOnScreen } = diagnostic;
  const targetPidRelation = diagnostic.target_pid_relation;
  const targetWindowRelation = diagnostic.target_window_id_relation;
  if (!RELATIONS.has(targetPidRelation) || !RELATIONS.has(targetWindowRelation)) return undefined;
  const targetPid = parsed.pid;
  const targetWindowId = parsed.window_id;
  const legacyFrontmostWindowId = observed.frontmost_ordinary_window_id;
  if (!isSafeInt(pid, 1, MAX_PID) || !isSafeInt(windowId, 1, MAX_U32)
    || !isSafeInt(targetPid, 1, MAX_PID) || !isSafeInt(targetWindowId, 1, MAX_U32)
    || !isSafeInt(legacyFrontmostWindowId, 1, MAX_U32)
    || !Number.isInteger(layer) || layer < -128 || layer > 128
    || !isSafeInt(z, 1, MAX_U32) || typeof isOnScreen !== "boolean"
    || targetPidRelation !== (pid === targetPid ? "same" : "different")
    || targetWindowRelation !== (windowId === targetWindowId ? "same" : "different")
    || legacyFrontmostWindowId !== windowId) return undefined;

  return Object.freeze({
    schema: SCHEMA,
    source: SOURCE,
    state: diagnostic.state,
    target_pid: targetPid,
    target_window_id: targetWindowId,
    frontmost_window_pid: pid,
    frontmost_window_id: windowId,
    layer,
    z,
    is_on_screen: isOnScreen,
    target_pid_relation: targetPidRelation,
    target_window_id_relation: targetWindowRelation,
  });
}

function observedDriver(driver, onEvidence) {
  return new Proxy(driver, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property !== "callTool") return value.bind(target);
      return function callTool(name, argumentsJson, asyncOpts) {
        const originalPromise = Reflect.apply(value, target, [name, argumentsJson, asyncOpts]);
        if (name !== "bring_to_front") return originalPromise;
        try {
          void Promise.resolve(originalPromise).then((result) => {
            try {
              const projected = projectDiagnostic(result?.structuredJson);
              if (projected !== undefined) {
                const sinkResult = onEvidence(projected);
                if (sinkResult !== null && sinkResult !== undefined
                  && (typeof sinkResult === "object" || typeof sinkResult === "function")) {
                  void Promise.resolve(sinkResult).catch(() => {});
                }
              }
            } catch {
              // Diagnostics are observational and must never alter the native result.
            }
          }).catch(() => {});
        } catch {
          // A nonstandard thenable must not change the direct native return value.
        }
        return originalPromise;
      };
    },
  });
}

/**
 * Decorate the public app-runtime importer for an isolated run. `connectDriver`
 * must be supplied by the caller from its already-authorized public SDK binding.
 * No SDK private module path or global loader is used here.
 */
export function createObservedCuaImporter({ importCuaComputer, connectDriver, onEvidence }) {
  if (typeof importCuaComputer !== "function" || typeof connectDriver !== "function" || typeof onEvidence !== "function") {
    throw new TypeError("importer, public SDK connector, and evidence sink are required");
  }
  return async function importObservedCuaComputer() {
    const module = await importCuaComputer();
    const BaseComputer = module?.CuaDriverComputer;
    if (typeof BaseComputer !== "function") throw new TypeError("computer module has no CuaDriverComputer constructor");
    class ObservedCuaDriverComputer extends BaseComputer {
      constructor(options) {
        const originalFactory = options.driverFactory;
        super({
          ...options,
          driverFactory(socketPath) {
            const driver = originalFactory === undefined ? connectDriver(socketPath) : Reflect.apply(originalFactory, this, [socketPath]);
            return observedDriver(driver, onEvidence);
          },
        });
      }
    }
    return { ...module, CuaDriverComputer: ObservedCuaDriverComputer };
  };
}

export { projectDiagnostic };
