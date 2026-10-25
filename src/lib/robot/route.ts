// BioBuzz: turns a visualizer project into the robot's route file (autos/*.json, version 2)
// and back, and talks to the robot (or simulator) that serves this page.
//
// The route format is read by TeamCode's lib/AutoRoute.java. Keep the two in step.

import type {
  AtomicPath,
  BasePoint,
  Path,
  RobotEvent,
  SequenceItem,
  SequenceWaitItem,
  StartPose,
} from "../../types";
import { flattenToAtomicSegments } from "../../utils/pathTraversal";
import { makePathId } from "../../utils/ids";
import { normalizePaths, type StoredPath } from "../../utils/normalize";

export interface ActionParam {
  name: string;
  label: string;
  unit: string;
  default: number;
  min: number;
  max: number;
}

export interface RobotActionDef {
  name: string;
  label: string;
  description: string;
  kind: "instant" | "step";
  onPath: boolean;
  params: ActionParam[];
}

/** Used when the page is not served by a robot, so the editor still works offline. */
export const BUILT_IN_ACTIONS: RobotActionDef[] = [
  { name: "wait", label: "wait", description: "Do nothing for a while.", kind: "step", onPath: false,
    params: [{ name: "seconds", label: "Seconds", unit: "s", default: 0.5, min: 0, max: 30 }] },
  { name: "intakeOn", label: "intake on", description: "Start the intake.", kind: "instant", onPath: true, params: [] },
  { name: "intakeOff", label: "intake off", description: "Stop the intake.", kind: "instant", onPath: true, params: [] },
  { name: "flywheelsOn", label: "flywheels on", description: "Spin both flywheels up to their target RPMs.", kind: "instant", onPath: true, params: [] },
  { name: "flywheelsOff", label: "flywheels off", description: "Stop both flywheels.", kind: "instant", onPath: true, params: [] },
  { name: "deployStinger", label: "stinger down", description: "Lower the stinger.", kind: "instant", onPath: true, params: [] },
  { name: "stowStinger", label: "stinger up", description: "Raise the stinger.", kind: "instant", onPath: true, params: [] },
  { name: "waitForFlywheels", label: "wait for flywheels", description: "Wait until both flywheels are at speed, or the time limit runs out.", kind: "step", onPath: false,
    params: [{ name: "timeout", label: "Time limit", unit: "s", default: 2, min: 0, max: 10 }] },
  { name: "shoot", label: "shoot", description: "Spin up if needed, wait until ready (2 s limit), then feed balls for a while.", kind: "step", onPath: false,
    params: [{ name: "seconds", label: "Feed time", unit: "s", default: 3.5, min: 0.1, max: 15 }] },
  { name: "turnTo", label: "turn to", description: "Stand still and turn to face a field heading.", kind: "step", onPath: false,
    params: [{ name: "degrees", label: "Heading", unit: "°", default: 0, min: -360, max: 360 }] },
];

// ---- Talking to the robot ------------------------------------------------------

/** The robot's action list, or the built-in one when no robot serves this page. */
export async function fetchActions(): Promise<{ actions: RobotActionDef[]; online: boolean; robot: string }> {
  try {
    const [actions, state] = await Promise.all([
      fetch("/api/actions").then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
      fetch("/api/state").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (!Array.isArray(actions)) throw new Error("bad action list");
    return { actions, online: true, robot: state?.robot ?? "robot" };
  } catch {
    return { actions: BUILT_IN_ACTIONS, online: false, robot: "" };
  }
}

export async function listRobotRoutes(): Promise<string[]> {
  const files = await fetch("/api/files").then((r) => r.json());
  return files.map((f: { path: string }) => f.path).filter((p: string) => p.startsWith("autos/") && p.endsWith(".json"));
}

export async function loadRobotRoute(path: string): Promise<{ text: string; hash: string | null }> {
  const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
  if (!response.ok) throw new Error((await response.json()).error);
  return { text: await response.text(), hash: response.headers.get("X-Hash") };
}

/** Saves on the robot. The robot checks every path, step and action before keeping it. */
export async function saveRobotRoute(path: string, text: string, baseHash = "*"): Promise<{ hash: string }> {
  const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: { "X-Base-Hash": baseHash },
    body: text,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

// ---- Actions as sequence steps ------------------------------------------------

export function defaultParams(def: RobotActionDef): Record<string, number> {
  return Object.fromEntries(def.params.map((p) => [p.name, p.default]));
}

/** Roughly how long a step takes, so the playback timeline and the 30 s check are honest. */
export function estimateSeconds(name: string, params: Record<string, number>): number {
  switch (name) {
    case "wait": return params.seconds ?? 0;
    case "shoot": return (params.seconds ?? 3.5) + 0.6;
    case "waitForFlywheels": return Math.min(params.timeout ?? 2, 1);
    case "turnTo": return 0.7;
    default: return 0.05;
  }
}

export function actionStep(def: RobotActionDef, params = defaultParams(def)): SequenceWaitItem {
  return {
    kind: "wait",
    id: makePathId().replace("line-", "action-"),
    name: def.label,
    durationMs: Math.round(estimateSeconds(def.name, params) * 1000),
    robotAction: { name: def.name, params },
  };
}

export function describeStep(item: SequenceWaitItem): string {
  const action = item.robotAction;
  if (!action) return `wait ${(item.durationMs / 1000).toFixed(1)} s`;
  const values = Object.values(action.params);
  return values.length ? `${item.name} ${values.join(", ")}` : item.name;
}

// ---- Export: project -> route file ------------------------------------------------------

export interface RobotSize { width: number; length: number; safetyMargin: number }

export interface RouteFile {
  version: 2;
  name: string;
  start: { x: number; y: number; heading: number };
  /** The robot's size and safety margin (inches) the paths were drawn with. */
  robot?: RobotSize;
  paths: {
    name: string;
    points: number[][];
    heading: { type: "linear"; start: number; end: number } | { type: "constant"; degrees: number } | { type: "tangential"; reverse: boolean };
    events: { at: number; action: string; params: Record<string, number> }[];
    /** Top speed on this path, % of the robot's calibrated top speed (absent: 100%). */
    speedPercent?: number;
  }[];
  steps: ({ follow: string } | { action: string; params: Record<string, number> })[];
}

const round = (value: number) => Math.round(value * 10000) / 10000;

/** Path names the robot and telemetry show: the path's own name, else path1, path2, ... */
export function pathNames(lines: Path[], startPoint: BasePoint): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  flattenToAtomicSegments(startPoint, lines).forEach(({ line }, index) => {
    const given = (line.name || "").trim();
    // The editor's default names ("Path 1") become path1, like the robot's own routes.
    const plain = /^path\s*\d+$/i.test(given) ? given.replace(/\s+/g, "").toLowerCase() : given;
    let base = plain.replace(/[^A-Za-z0-9_-]+/g, "_") || `path${index + 1}`;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    names.set(line.id, name);
  });
  return names;
}

export function exportRoute(
  name: string,
  startPoint: StartPose,
  lines: Path[],
  sequence: SequenceItem[],
  actions: RobotActionDef[],
  robot?: RobotSize,
): { route: RouteFile; problems: string[] } {
  const problems: string[] = [];
  const known = new Map(actions.map((a) => [a.name, a]));
  const segments = flattenToAtomicSegments(startPoint, lines);
  const names = pathNames(lines, startPoint);

  const paths = segments.map(({ line, start, ancestors }) => {
    const pathName = names.get(line.id)!;
    if (line.throughPoints?.length) problems.push(`${pathName}: "curve through" paths are not supported on the robot yet`);
    if (ancestors.some((group) => group.heading)) problems.push(`${pathName}: group headings are not supported; set the heading on each path`);
    let heading: RouteFile["paths"][number]["heading"];
    switch (line.heading.type) {
      case "linear": heading = { type: "linear", start: line.heading.startDeg, end: line.heading.endDeg }; break;
      case "constant": heading = { type: "constant", degrees: line.heading.degrees }; break;
      case "tangential": heading = { type: "tangential", reverse: line.heading.reverse }; break;
      default:
        problems.push(`${pathName}: piecewise headings are not supported on the robot yet; using tangential`);
        heading = { type: "tangential", reverse: false };
    }
    const events = (line.robotEvents ?? []).map((event) => {
      const def = known.get(event.action);
      if (!def) problems.push(`${pathName}: unknown action "${event.action}"`);
      else if (!def.onPath) problems.push(`${pathName}: "${def.label}" takes time, so it can only go between paths`);
      return { at: round(Math.min(1, Math.max(0, event.at))), action: event.action, params: event.params ?? {} };
    }).sort((a, b) => a.at - b.at);
    return {
      name: pathName,
      points: [start, ...line.controlPoints, line.endPoint].map((p) => [round(p.x), round(p.y)]),
      heading,
      events,
      ...(line.speedPercent && line.speedPercent < 100 ? { speedPercent: Math.round(line.speedPercent) } : {}),
    };
  });

  const steps: RouteFile["steps"] = [];
  const order = sequence.length ? sequence : segments.map(({ line }) => ({ kind: "path" as const, lineId: line.id }));
  for (const item of order) {
    if (item.kind === "path") {
      const pathName = names.get(item.lineId);
      if (pathName) steps.push({ follow: pathName });
    } else if (item.robotAction) {
      if (!known.has(item.robotAction.name)) problems.push(`Step "${item.name}": unknown action "${item.robotAction.name}"`);
      steps.push({ action: item.robotAction.name, params: item.robotAction.params ?? {} });
    } else if (item.durationMs > 0) {
      steps.push({ action: "wait", params: { seconds: round(item.durationMs / 1000) } });
    }
  }
  if (!steps.some((s) => "follow" in s)) problems.push("The route never follows a path");

  return {
    route: {
      version: 2,
      name,
      start: { x: round(startPoint.x), y: round(startPoint.y), heading: round(startPoint.headingDeg) },
      ...(robot ? { robot: { width: round(robot.width), length: round(robot.length), safetyMargin: round(robot.safetyMargin) } } : {}),
      paths,
      steps,
    },
    problems,
  };
}

// ---- Import: route file -> project ----------------------------------------------------------

const COLORS = ["#f5b301", "#58a6ff", "#3fb950", "#bc8cff", "#ff7b72", "#39c5cf", "#ffa657", "#d2a8ff"];

export function importRoute(text: string, actions: RobotActionDef[]): {
  name: string; startPoint: StartPose; lines: Path[]; sequence: SequenceItem[]; problems: string[]; robot: RobotSize | null;
} {
  const route = JSON.parse(text) as RouteFile;
  if (route.version !== 2) throw new Error('Not a Total Chaos route file ("version": 2)');
  const problems: string[] = [];
  const known = new Map(actions.map((a) => [a.name, a]));
  const startPoint: StartPose = { x: route.start.x, y: route.start.y, headingDeg: route.start.heading, name: "start" };

  let previous: BasePoint = startPoint;
  const ids = new Map<string, string>();
  const stored: StoredPath[] = route.paths.map((path, index) => {
    const points = path.points.map(([x, y]) => ({ x, y }));
    const first = points[0];
    if (Math.hypot(first.x - previous.x, first.y - previous.y) > 0.01) {
      problems.push(`${path.name} starts at (${first.x}, ${first.y}), not where the path before it ends; the editor joins them`);
    }
    previous = points[points.length - 1];
    const id = makePathId();
    ids.set(path.name, id);
    const h = path.heading;
    const heading = h.type === "linear" ? { type: "linear" as const, startDeg: h.start, endDeg: h.end }
      : h.type === "constant" ? { type: "constant" as const, degrees: h.degrees }
      : { type: "tangential" as const, reverse: !!h.reverse };
    const robotEvents: RobotEvent[] = (path.events ?? []).map((e) => ({
      id: makePathId().replace("line-", "event-"), at: e.at, action: e.action, params: e.params ?? {},
    }));
    return {
      id,
      name: path.name,
      color: COLORS[index % COLORS.length],
      endPoint: { ...points[points.length - 1] },
      controlPoints: points.slice(1, -1),
      heading,
      robotEvents,
      speedPercent: Number(path.speedPercent) > 0 && Number(path.speedPercent) < 100 ? Number(path.speedPercent) : undefined,
    };
  });
  const lines = normalizePaths(stored);

  const sequence: SequenceItem[] = [];
  for (const step of route.steps) {
    if ("follow" in step) {
      const id = ids.get(step.follow);
      if (id) sequence.push({ kind: "path", lineId: id });
      else problems.push(`A step follows "${step.follow}", which is not in the file`);
    } else {
      const def = known.get(step.action);
      if (!def) problems.push(`Unknown action "${step.action}"`);
      const params = step.params ?? {};
      sequence.push(def ? actionStep(def, { ...defaultParams(def), ...params }) : {
        kind: "wait", id: makePathId(), name: step.action, durationMs: 0, robotAction: { name: step.action, params },
      });
    }
  }
  const r = route.robot;
  const robot = r && [r.width, r.length, r.safetyMargin].every((v) => typeof v === "number" && isFinite(v) && v >= 0)
    ? { width: r.width, length: r.length, safetyMargin: r.safetyMargin } : null;
  return { name: route.name ?? "route", startPoint, lines, sequence, problems, robot };
}

export function isAtomic(path: Path | null | undefined): path is AtomicPath {
  return !!path && path.kind === "atomic";
}
