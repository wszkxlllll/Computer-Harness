import { describe, expect, it, vi } from "vitest";
import type { CuaDriverLike } from "./cua-sdk-contract.js";
import { assertTopologySuccessor, MacosTopologyError, parseMacosTargetTopology, parseMacosTopologyCapabilities, readMacosTargetTopology, topologyEvidence } from "./macos-target-topology.js";

const target = { pid: 41, windowId: 101 };
const nonce = "00000000-0000-0000-0000-000000000001";
const capability = () => ({
  schema_version: 2, producer_version: "harness-topology-v2",
  source_commit: "d114f35fec05ecd37bf529e5587be86852205b64",
  scope: "target-ax-closure-cg-all-layers-v1", read_only: true, global_topology_complete: false,
  identity_lifecycle: "bounded-observation", max_rows: 4096, max_nodes: 2048, max_elapsed_ms: 6000, max_queries: 32768,
});
const response = (requestNonce = nonce) => ({
  ...capability(), status: "verified", target: { pid:41, window_id:101 }, request_nonce:requestNonce,
  session_epoch: "00000000-0000-0000-0000-000000000002", sequence:1, started_unix_ms:Date.now(), elapsed_ms:10,
  cg_enumeration_complete:true, target_closure_complete:true, stable:true,
  cg_before:{ status:"success", raw_count:1, retained_count:1, skipped_count:0, duplicate_count:0,
    rows:[{ pid:41, window_id:101, layer:0, z_index:1, bounds:{ x:10,y:20,width:800,height:600 }, space_ids:[1],current_space_id:1 }] },
  cg_after:{ status:"success", raw_count:1, retained_count:1, skipped_count:0, duplicate_count:0,
    rows:[{ pid:41, window_id:101, layer:0, z_index:1, bounds:{ x:10,y:20,width:800,height:600 }, space_ids:[1],current_space_id:1 }] },
  ax:{ status:"success", target_resolved:true, closure_complete:true, query_count:20, node_count:4,
    target_identity_token:"00000000-0000-0000-0000-000000000003",
    skipped_count:0,truncated:false,root_role:"AXWindow",root_subrole:"AXStandardWindow",root_query_status:"success",root_classification:"ordinary",unassociated_menu_present:false,
    overlays:[] as Array<{identity_token:string,kind:string,pid:number,window_id:number,parent_window_id:number,path:string,visible:boolean,geometry_verified:boolean,visibility_source:string,frame:{x:number,y:number,width:number,height:number}}> },
});
const overlay = (path: string) => ({ kind:"menu",pid:41,window_id:101,parent_window_id:101,path,visible:true,
  identity_token:path.includes("sheets") ? "00000000-0000-0000-0000-000000000005" : "00000000-0000-0000-0000-000000000004",
  geometry_verified:true,visibility_source:"consistent_both",frame:{x:20,y:30,width:100,height:200} });
const toolResult = (value: unknown) => ({ text:"",images:[],isError:false,degraded:false,rawJson:"{}",structuredJson:JSON.stringify(value) });

describe("strict macOS target topology contract", () => {
  it("preserves complete u32 window IDs and rejects values beyond that range", () => {
    const value = response();
    value.target.window_id = 4294967295;
    value.cg_before.rows[0]!.window_id = value.cg_after.rows[0]!.window_id = 4294967295;
    expect(parseMacosTargetTopology(value, { pid: 41, windowId: 4294967295 }, nonce).target.windowId).toBe(4294967295);
    value.target.window_id = 4294967296;
    value.cg_before.rows[0]!.window_id = value.cg_after.rows[0]!.window_id = 4294967296;
    expect(() => parseMacosTargetTopology(value, { pid: 41, windowId: 4294967296 }, nonce)).toThrow();
  });
  it.each([
    { root_subrole: "AXDialog" }, { root_subrole: "AXSystemDialog" }, { root_subrole: "AXSheet" },
    { root_subrole: "AXFloatingWindow" }, { root_subrole: "AXUnknownSubrole" }, { root_subrole: undefined },
    { root_role: "AXSheet" }, { root_query_status: "unsupported" }, { root_classification: "dialog" },
  ])("does not admit a verified envelope with unsupported actual root evidence %j", (override) => {
    const value = response();
    expect(() => parseMacosTargetTopology({ ...value, ax: { ...value.ax, ...override } }, target, nonce)).toThrow();
  });
  it("rejects the old v1 capability rather than ignoring v2 root evidence", () => {
    expect(() => parseMacosTopologyCapabilities({ ...capability(), schema_version: 1, producer_version: "harness-topology-v1" })).toThrow();
  });
  it("keeps target closure distinct from global ownership and lifecycle evidence", () => {
    const parsed = parseMacosTargetTopology(response(),target,nonce);
    expect(parsed.overlays).toEqual([]);
    expect(topologyEvidence(parsed)).toContain('"globalTopologyComplete":false');
    expect(topologyEvidence(parsed)).toContain('"identityLifecycle":"bounded-observation"');
    expect(parsed).not.toHaveProperty("complete");
  });
  it.each([
    { schema_version:1 },{ source_commit:"unknown" },{ producer_version:"unknown" },{ scope:"desktop" },
    { read_only:false },{ global_topology_complete:true },{ identity_lifecycle:"native-generation" },{ max_nodes:999999 },
  ])("rejects a mismatched capability %j", (override) => {
    expect(() => parseMacosTopologyCapabilities({...capability(),...override})).toThrow(MacosTopologyError);
  });
  it.each([
    (v:ReturnType<typeof response>) => { v.target.window_id=102; },
    (v:ReturnType<typeof response>) => { v.request_nonce="wrong"; },
    (v:ReturnType<typeof response>) => { v.status="unknown"; },
    (v:ReturnType<typeof response>) => { v.cg_before.status="error"; },
    (v:ReturnType<typeof response>) => { v.cg_before.skipped_count=1; },
    (v:ReturnType<typeof response>) => { v.cg_before.raw_count=2; },
    (v:ReturnType<typeof response>) => { v.cg_after.rows[0]!.bounds.x++; },
    (v:ReturnType<typeof response>) => { v.cg_after.rows[0]!.space_ids=[]; },
    (v:ReturnType<typeof response>) => { v.ax.status="unsupported"; },
    (v:ReturnType<typeof response>) => { v.ax.truncated=true; },
    (v:ReturnType<typeof response>) => { v.ax.query_count=32769; },
    (v:ReturnType<typeof response>) => { v.ax.unassociated_menu_present=true; },
    (v:ReturnType<typeof response>) => { v.ax.root_role="AXUnknown"; },
  ])("rejects unknown, malformed, changed or incomplete evidence", (mutate) => {
    const value = response(); mutate(value);
    expect(() => parseMacosTargetTopology(value,target,nonce)).toThrow(MacosTopologyError);
  });
  it("retains different AX paths sharing a CGID instead of deduplicating sheets/menus by PID", () => {
    const value=response(); value.ax.overlays=[overlay("target/children.0"),{...overlay("target/sheets.0"),kind:"dialog"}];
    expect(parseMacosTargetTopology(value,target,nonce).overlays).toHaveLength(2);
  });
  it.each([
    {path:"app_menu/children.0"},{pid:42},{parent_window_id:102},{kind:"unknown"},
    {visible:false},{geometry_verified:false},{visibility_source:"inferred"},
    {frame:{x:0,y:0,width:900,height:800}},
  ])("rejects unproved overlay visibility, parent or geometry %j", (override) => {
    const value=response(); value.ax.overlays=[{...overlay("target/children.0"),...override}];
    expect(() => parseMacosTargetTopology(value,target,nonce)).toThrow(MacosTopologyError);
  });
  it("rejects duplicate paths, duplicate CGIDs and impossible node counts", () => {
    const value=response(); value.ax.overlays=[overlay("target/children.0"),overlay("target/children.0")];
    expect(() => parseMacosTargetTopology(value,target,nonce)).toThrow();
    value.ax.overlays=[]; value.cg_before.rows.push({...value.cg_before.rows[0]!}); value.cg_before.raw_count=2;value.cg_before.retained_count=2;
    expect(() => parseMacosTargetTopology(value,target,nonce)).toThrow();
    const impossible=response();impossible.ax.overlays=[overlay("target/children.0")];impossible.ax.node_count=1;
    expect(() => parseMacosTargetTopology(impossible,target,nonce)).toThrow();
  });
  it("rejects reused sample sequences and daemon epochs, not claiming to detect every OS ID reuse", () => {
    const parsed=parseMacosTargetTopology(response(),target,nonce);
    expect(() => assertTopologySuccessor(parsed,parsed)).toThrow();
    expect(() => assertTopologySuccessor(parsed,{...parsed,sequence:2,sessionEpoch:nonce})).toThrow();
    expect(() => assertTopologySuccessor(parsed,{...parsed,sequence:2})).not.toThrow();
    expect(() => assertTopologySuccessor(parsed,{...parsed,sequence:2,targetIdentityToken:nonce})).toThrow();
  });
  it("negotiates the real driver boundary and echoes a fresh nonce without content or screenshot tools", async () => {
    const calls:string[]=[];
    const driver={async callTool(name:string,args:string) {
      calls.push(name);return name.endsWith("_capabilities") ? toolResult(capability()) : toolResult(response((JSON.parse(args) as {request_nonce:string}).request_nonce));
    }} as unknown as CuaDriverLike;
    await expect(readMacosTargetTopology(driver,target,new AbortController().signal)).resolves.toMatchObject({target});
    expect(calls).toEqual(["get_target_window_topology_capabilities","get_target_window_topology"]);
  });
  it("does not fallback or query after unsupported capability", async () => {
    const calls:string[]=[];
    const driver={async callTool(name:string) {calls.push(name);return {...toolResult({}),isError:true,text:"PRIVATE_ERROR"};}} as unknown as CuaDriverLike;
    await expect(readMacosTargetTopology(driver,target,new AbortController().signal)).rejects.toMatchObject({reason:"unsupported"});
    expect(calls).toHaveLength(1);
  });
  it("does not start a late target query after the capability deadline", async () => {
    vi.useFakeTimers();
    try {
      let resolveCapability!:(value:ReturnType<typeof toolResult>)=>void;
      const calls:string[]=[];
      const driver={async callTool(name:string) {calls.push(name);return new Promise<ReturnType<typeof toolResult>>((resolve)=>{resolveCapability=resolve;});}} as unknown as CuaDriverLike;
      const pending=readMacosTargetTopology(driver,target,new AbortController().signal);
      const assertion=expect(pending).rejects.toMatchObject({reason:"timeout"});
      await vi.advanceTimersByTimeAsync(6500); await assertion;
      resolveCapability(toolResult(capability()));await vi.runAllTimersAsync();
      expect(calls).toEqual(["get_target_window_topology_capabilities"]);
    } finally {vi.useRealTimers();}
  });
  it("preserves cancellation priority and never starts a second query", async () => {
    const controller=new AbortController();const reason=new Error("cancelled fixture");
    const calls:string[]=[];
    const driver={async callTool(name:string) {calls.push(name);controller.abort(reason);return toolResult(capability());}} as unknown as CuaDriverLike;
    await expect(readMacosTargetTopology(driver,target,controller.signal)).rejects.toBe(reason);
    expect(calls).toHaveLength(1);
  });
});
