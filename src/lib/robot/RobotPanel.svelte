<script lang="ts">
  // BioBuzz: robot actions on the route, and saving the route to the robot.
  import { onMount } from "svelte";
  import type { AtomicPath, Path, SequenceItem, SequenceWaitItem, StartPose } from "../../types";
  import { atomicSegments } from "../../utils/pathTraversal";
  import { makePathId } from "../../utils/ids";
  import {
    actionStep,
    BUILT_IN_ACTIONS,
    defaultParams,
    describeStep,
    estimateSeconds,
    exportRoute,
    fetchActions,
    importRoute,
    listRobotRoutes,
    loadRobotRoute,
    pathNames,
    saveRobotRoute,
    type RobotActionDef,
  } from "./route";

  interface Props {
    startPoint: StartPose;
    lines: Path[];
    sequence: SequenceItem[];
    selectedLine: AtomicPath | null;
    totalTime: number;
    /** The visualizer's settings: robot size and safety margin are saved with the route. */
    settings?: { rWidth: number; rHeight: number; safetyMargin: number };
    recordChange?: () => void;
  }

  let {
    startPoint = $bindable(),
    lines = $bindable(),
    sequence = $bindable(),
    selectedLine = null,
    totalTime = 0,
    settings,
    recordChange,
  }: Props = $props();

  let actions: RobotActionDef[] = $state(BUILT_IN_ACTIONS);
  let online = $state(false);
  let robotName = $state("");
  let routeName = $state(loadName());
  let routes: string[] = $state([]);
  let loadedHash: string | null = $state(null);
  /** The robot file this sequence was opened from or last saved to. */
  let currentFile: string | null = $state(null);
  let message = $state("");
  let messageBad = $state(false);
  let problems: string[] = $state([]);
  let addMode: "function" | "path" = $state("function");
  let addFunctionAction = $state("shoot");
  let addAfter = $state("end");
  let addOnPathAction = $state("flywheelsOn");
  let addPathId = $state("");
  let addPercent = $state(50);
  /** Settings chosen in the Add form before adding, per function (shown with its defaults). */
  let addValues = $state<Record<string, Record<string, number>>>({});

  function addParams(name: string): Record<string, number> {
    const def = byName.get(name);
    return def ? { ...defaultParams(def), ...(addValues[name] ?? {}) } : {};
  }

  function setAddParam(name: string, param: string, value: number) {
    if (!Number.isFinite(value)) return;
    addValues = { ...addValues, [name]: { ...(addValues[name] ?? {}), [param]: value } };
  }
  /** The step or on-path function being edited (its id), or null. */
  let editing: string | null = $state(null);

  let stepActions = $derived(actions);
  let allPaths = $derived(atomicSegments(lines));
  let pathActions = $derived(actions.filter((a) => a.onPath));
  let byName = $derived(new Map(actions.map((a) => [a.name, a])));
  let names = $derived(pathNames(lines, startPoint));
  let colors = $derived(new Map(atomicSegments(lines).map((l) => [l.id, l.color])));
  let fileName = $derived(`autos/${safeName(routeName)}.json`);

  // Clicking a path on the field makes it the one "Function on a path" adds to.
  $effect(() => {
    if (selectedLine) addPathId = selectedLine.id;
    else if (!allPaths.some((l) => l.id === addPathId) && allPaths.length) addPathId = allPaths[0].id;
  });

  onMount(async () => {
    const result = await fetchActions();
    actions = result.actions;
    online = result.online;
    robotName = result.robot;
    if (online) refreshRoutes();
  });

  function loadName() {
    try { return localStorage.getItem("biobuzz.route") || "saturday"; } catch { return "saturday"; }
  }

  function safeName(name: string) {
    return (name || "route").trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "route";
  }

  function say(text: string, bad = false) {
    message = text;
    messageBad = bad;
  }

  async function refreshRoutes() {
    try { routes = await listRobotRoutes(); } catch { routes = []; }
  }

  // ---- The sequence ---------------------------------------------------------

  /** The sequence, filled in with every path when it is empty (the editor's default). */
  function currentSequence(): SequenceItem[] {
    return sequence.length ? sequence : atomicSegments(lines).map((l) => ({ kind: "path" as const, lineId: l.id }));
  }

  function stepLabel(item: SequenceItem, index: number): string {
    if (item.kind === "path") return `${index + 1}. follow ${names.get(item.lineId) ?? "?"}`;
    return `${index + 1}. ${item.robotAction ? label(item.robotAction.name) : "wait"}`;
  }

  /** "Function": a step between paths, inserted after the chosen step (default: at the end). */
  function addFunction() {
    const def = byName.get(addFunctionAction);
    if (!def) return;
    const items = [...currentSequence()];
    const after = addAfter === "end" ? items.length - 1 : Math.min(Number(addAfter), items.length - 1);
    items.splice(after + 1, 0, actionStep(def, addParams(def.name)));
    sequence = items;
    addAfter = "end";
    recordChange?.();
  }

  function moveStep(index: number, by: number) {
    const items = [...currentSequence()];
    const target = index + by;
    if (target < 0 || target >= items.length) return;
    [items[index], items[target]] = [items[target], items[index]];
    sequence = items;
    recordChange?.();
  }

  function removeStep(index: number) {
    const items = [...currentSequence()];
    if (items[index].kind !== "wait") return;
    items.splice(index, 1);
    sequence = items;
    recordChange?.();
  }

  function setStepParam(index: number, param: string, value: number) {
    const items = [...currentSequence()];
    const item = items[index] as SequenceWaitItem;
    if (!item.robotAction) return;
    const params = { ...item.robotAction.params, [param]: value };
    items[index] = { ...item, robotAction: { ...item.robotAction, params },
      durationMs: Math.round(estimateSeconds(item.robotAction.name, params) * 1000) };
    sequence = items;
  }

  /** Changes which function a step runs (wait -> shoot), keeping settings that still apply. */
  function setStepAction(index: number, name: string) {
    const def = byName.get(name);
    if (!def) return;
    const items = [...currentSequence()];
    const item = items[index] as SequenceWaitItem;
    const old = item.robotAction?.params ?? {};
    const params = Object.fromEntries(def.params.map((p) => [p.name, old[p.name] ?? p.default]));
    items[index] = { ...item, name: def.label, robotAction: { name, params },
      durationMs: Math.round(estimateSeconds(name, params) * 1000) };
    sequence = items;
    recordChange?.();
  }

  function stepSummary(item: SequenceWaitItem): string {
    const action = item.robotAction;
    if (!action) return describeStep(item);
    const def = byName.get(action.name);
    return (def?.params ?? []).map((p) => `${action.params[p.name] ?? p.default}${p.unit === "°" ? "°" : ` ${p.unit}`}`).join(", ");
  }

  // ---- Functions on a path ------------------------------------------------------

  function updatePath(id: string, change: (line: AtomicPath) => AtomicPath) {
    const walk = (nodes: Path[]): Path[] => nodes.map((node) =>
      node.kind === "compound" ? { ...node, segments: walk(node.segments) }
        : node.id === id ? change(node) : node);
    lines = walk(lines);
  }

  function pathEvents(id: string) {
    const line = atomicSegments(lines).find((l) => l.id === id);
    return [...(line?.robotEvents ?? [])].sort((a, b) => a.at - b.at);
  }

  /** "Function on a path": fires when the robot is this far along the chosen path. */
  function addOnPath() {
    const def = byName.get(addOnPathAction);
    const pathId = addPathId || atomicSegments(lines)[0]?.id;
    if (!def || !pathId) return;
    const at = Math.min(100, Math.max(0, Number(addPercent) || 0)) / 100;
    updatePath(pathId, (line) => ({
      ...line,
      robotEvents: [...(line.robotEvents ?? []), {
        id: makePathId().replace("line-", "event-"), at, action: def.name, params: addParams(def.name),
      }],
    }));
    recordChange?.();
  }

  function setEvent(pathId: string, eventId: string, change: Record<string, unknown>) {
    updatePath(pathId, (line) => ({
      ...line,
      robotEvents: (line.robotEvents ?? []).map((e) => (e.id === eventId ? { ...e, ...change } : e)),
    }));
  }

  function removeEvent(pathId: string, eventId: string) {
    updatePath(pathId, (line) => ({ ...line, robotEvents: (line.robotEvents ?? []).filter((e) => e.id !== eventId) }));
    recordChange?.();
  }

  // ---- Files ----------------------------------------------------------------------

  function build() {
    const robot = settings ? { width: settings.rWidth, length: settings.rHeight, safetyMargin: settings.safetyMargin } : undefined;
    const result = exportRoute(routeName, startPoint, lines, sequence, actions, robot);
    problems = result.problems;
    return result;
  }

  /** Saves under the name in the box. A different auton that already exists is only replaced after asking. */
  async function saveToRobot() {
    const target = fileName;
    if (routes.includes(target) && target !== currentFile
        && !confirm(`${target} is a different auton that already exists. Replace it?`)) return;
    const { route, problems: found } = build();
    if (found.length && !confirm(`Problems:\n\n${found.join("\n")}\n\nSave anyway?`)) return;
    try {
      // Saving over the file we opened: refuse if someone changed it on the robot since.
      const base = target === currentFile && loadedHash ? loadedHash : routes.includes(target) ? "*" : "new";
      const result = await saveRobotRoute(target, JSON.stringify(route, null, 2) + "\n", base);
      loadedHash = result.hash;
      currentFile = target;
      try { localStorage.setItem("biobuzz.route", routeName); } catch { /* private window */ }
      say(`Saved ${target} on ${robotName || "the robot"}. Press INIT to run it.`);
      window.parent?.postMessage({ type: "biobuzz:saved", path: target }, "*");
      refreshRoutes();
    } catch (error) {
      say(String((error as Error).message), true);
    }
  }

  /** Makes a new auton file from what is on screen, leaving the opened one as it was. */
  async function saveAsNew() {
    const name = prompt("Name for the new auton:", `${safeName(routeName)}-copy`);
    if (!name || !name.trim()) return;
    const target = `autos/${safeName(name)}.json`;
    if (routes.includes(target) && !confirm(`${target} already exists. Replace it?`)) return;
    routeName = name.trim();
    currentFile = target;      // replacing was confirmed above, so do not ask again
    loadedHash = null;
    await saveToRobot();
  }

  function applyImported(text: string) {
    const imported = importRoute(text, actions);
    startPoint = imported.startPoint;
    lines = imported.lines;
    sequence = imported.sequence;
    routeName = imported.name;
    problems = imported.problems;
    if (imported.robot && settings) {
      settings.rWidth = imported.robot.width;
      settings.rHeight = imported.robot.length;
      settings.safetyMargin = imported.robot.safetyMargin;
    }
    recordChange?.();
  }

  async function loadFromRobot(path: string) {
    if (!path) return;
    try {
      const { text, hash } = await loadRobotRoute(path);
      applyImported(text);
      routeName = path.replace(/^autos\//, "").replace(/\.json$/, "");
      loadedHash = hash;
      currentFile = path;
      say(`Loaded ${path} from the robot.`);
    } catch (error) {
      say(String((error as Error).message), true);
    }
  }

  function download() {
    const { route } = build();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([JSON.stringify(route, null, 2) + "\n"], { type: "application/json" }));
    link.download = `${safeName(routeName)}.json`;
    link.click();
  }

  async function importFile(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      applyImported(await file.text());
      say(`Imported ${file.name}.`);
    } catch (error) {
      say(String((error as Error).message), true);
    }
    (event.target as HTMLInputElement).value = "";
  }

  function label(name: string) {
    return byName.get(name)?.label ?? name;
  }
</script>

<div class="robot-panel flex flex-col gap-3 w-full border border-[#333333] bg-[#222222] p-3" data-testid="robot-panel">
  <div class="flex items-center justify-between gap-2">
    <div class="font-semibold">Auton Sequence</div>
    <span class="text-xs px-2 py-0.5 rounded-full {online ? 'bg-green-900/50 text-green-300' : 'bg-neutral-700 text-neutral-300'}"
      title={online ? "Actions come from the robot" : "Not served by a robot: using the built-in action list"}>
      {online ? `connected: ${robotName}` : "offline"}
    </span>
  </div>

  <div class="flex flex-wrap items-center gap-2">
    <input class="flex-1 min-w-32 bg-[#2b2b2b] border border-[#444] rounded px-2 py-1 text-sm"
      bind:value={routeName} aria-label="Route name" data-testid="route-name" />
    <button class="px-2 py-1 rounded bg-yellow-500 text-black text-sm font-semibold disabled:opacity-40"
      onclick={saveToRobot} disabled={!online} data-testid="route-save"
      title="Save to the robot under the name in the box">Save</button>
    <button class="px-2 py-1 rounded bg-[#333] text-sm disabled:opacity-40" onclick={saveAsNew} disabled={!online}
      data-testid="route-save-as" title="Make a new auton file, keeping the one you opened">Save as new…</button>
    <button class="px-2 py-1 rounded bg-[#333] text-sm disabled:opacity-40" disabled={!online || !currentFile}
      title="Every saved version of this auton, with Restore" data-testid="route-history"
      onclick={() => window.parent?.postMessage({ type: "biobuzz:history", path: currentFile }, "*")}>History</button>
    <button class="px-2 py-1 rounded bg-[#333] text-sm" onclick={download}>Download</button>
    <label class="px-2 py-1 rounded bg-[#333] text-sm cursor-pointer">Import
      <input type="file" accept=".json,application/json" class="hidden" onchange={importFile} /></label>
  </div>
  {#if online}
    <div class="flex items-center gap-2 text-sm">
      <span class="text-neutral-400">Open from robot</span>
      <select class="flex-1 bg-[#2b2b2b] border border-[#444] rounded px-2 py-1" data-testid="route-load"
        onchange={(e) => loadFromRobot((e.target as HTMLSelectElement).value)}>
        <option value="">choose…</option>
        {#each routes as route (route)}<option value={route}>{route}</option>{/each}
      </select>
    </div>
  {/if}
  <div class="text-xs text-neutral-400" data-testid="route-file">
    {#if currentFile && currentFile !== fileName}
      Opened <code>{currentFile}</code>; <b>Save</b> will write a new file, <code>{fileName}</code>.
    {:else if currentFile}
      Editing <code>{currentFile}</code>.
    {:else}
      Not saved yet; <b>Save</b> writes <code>{fileName}</code>.
    {/if}
    One file holds the whole auton: start, paths, and every step. To run it, set
    <code>PedroAutonomous.ROUTE</code> to <code>{safeName(routeName)}</code> in the Tune tab (or pick it with the D-pad at INIT).
  </div>
  {#if message}<div class="text-sm {messageBad ? 'text-red-400' : 'text-green-400'}" data-testid="route-message">{message}</div>{/if}
  {#each problems as problem (problem)}<div class="text-sm text-amber-400">⚠ {problem}</div>{/each}

  <div class="flex items-center justify-between">
    <div class="font-semibold text-sm">Sequence</div>
    <div class="text-xs {totalTime > 30 ? 'text-red-400 font-semibold' : 'text-neutral-400'}" data-testid="route-time">
      about {totalTime.toFixed(1)} s{totalTime > 30 ? " — over the 30 s autonomous!" : " of 30 s"}
    </div>
  </div>
  <ol class="flex flex-col gap-1 text-sm" data-testid="route-steps">
    {#each currentSequence() as item, index (item.kind === "path" ? `p-${item.lineId}-${index}` : item.id)}
      <li class="flex flex-col gap-1 bg-[#2a2a2a] rounded px-2 py-1"
        data-action={item.kind === "wait" ? (item.robotAction?.name ?? "wait") : "follow"}>
        <div class="flex items-center gap-2 min-h-7">
          <span class="text-neutral-500 w-5 text-right">{index + 1}</span>
          {#if item.kind === "path"}
            <span class="size-2.5 rounded-full" style="background:{colors.get(item.lineId) ?? '#fff'}"></span>
            <span class="flex-1">follow <b>{names.get(item.lineId) ?? "?"}</b></span>
          {:else if editing === item.id && item.robotAction}
            <span class="flex flex-1 flex-wrap items-center gap-2">
              <select class="bg-[#333] border border-[#444] rounded px-1 py-0.5" value={item.robotAction.name}
                data-testid="step-edit-action"
                onchange={(e) => setStepAction(index, (e.target as HTMLSelectElement).value)}>
                {#each stepActions as action (action.name)}<option value={action.name}>{action.label}</option>{/each}
              </select>
              {#each byName.get(item.robotAction.name)?.params ?? [] as param (param.name)}
                <span class="flex items-center gap-1">
                  <input type="number" step="0.1" min={param.min} max={param.max}
                    class="w-16 bg-[#333] border border-[#444] rounded px-1 text-right" data-testid="step-edit-param"
                    value={item.robotAction.params[param.name] ?? param.default} title={param.label}
                    onchange={(e) => setStepParam(index, param.name, Number((e.target as HTMLInputElement).value))} />
                  <span class="text-neutral-400">{param.unit}</span>
                </span>
              {/each}
            </span>
            <button class="icon-btn text-green-400" title="Done" data-testid="edit-done" onclick={() => { editing = null; recordChange?.(); }}>✓</button>
          {:else}
            <span class="flex-1">⚙ <b>{item.robotAction ? label(item.robotAction.name) : "wait"}</b>
              <span class="text-neutral-400">{stepSummary(item)}</span></span>
            {#if item.robotAction}
              <button class="icon-btn" title="Edit this step" data-testid="step-edit" onclick={() => (editing = item.id)}>
                <svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor" aria-hidden="true"><path d="M13.6 2.6a2 2 0 0 1 2.8 0l1 1a2 2 0 0 1 0 2.8L8 15.8 3.5 17l1.2-4.5 8.9-9.9Z"/></svg>
              </button>
            {/if}
            <button class="icon-btn text-red-400" title="Remove" onclick={() => removeStep(index)}>✕</button>
          {/if}
          <span class="flex gap-0.5 ml-1 pl-2 border-l border-[#444]">
            <button class="icon-btn" title="Move up" onclick={() => moveStep(index, -1)}>↑</button>
            <button class="icon-btn" title="Move down" onclick={() => moveStep(index, 1)}>↓</button>
          </span>
        </div>
        {#if item.kind === "path"}
          <!-- Functions on this path, in the order they fire. -->
          {#each pathEvents(item.lineId) as event (event.id)}
            <div class="flex items-center gap-2 pl-7 min-h-7" data-testid="event-row"
              data-at={Math.round(event.at * 100)} data-action={event.action}>
              <span class="text-yellow-400">◆</span>
              {#if editing === event.id}
                <input type="number" min="0" max="100" step="1" class="w-14 bg-[#333] border border-[#444] rounded px-1 text-right"
                  value={Math.round(event.at * 100)} title="How far along the path, in %" data-testid="event-edit-at"
                  onchange={(e) => setEvent(item.lineId, event.id, { at: Math.min(100, Math.max(0, Number((e.target as HTMLInputElement).value) || 0)) / 100 })} />
                <span class="text-neutral-400">%</span>
                <select class="flex-1 bg-[#333] border border-[#444] rounded px-1 py-0.5" value={event.action}
                  data-testid="event-edit-action"
                  onchange={(e) => setEvent(item.lineId, event.id, { action: (e.target as HTMLSelectElement).value })}>
                  {#each pathActions as action (action.name)}<option value={action.name}>{action.label}</option>{/each}
                </select>
                <button class="icon-btn text-green-400" title="Done" data-testid="edit-done" onclick={() => { editing = null; recordChange?.(); }}>✓</button>
              {:else}
                <span class="w-10 text-right tabular-nums">{Math.round(event.at * 100)}%</span>
                <span class="flex-1">{label(event.action)}</span>
                <button class="icon-btn" title="Edit" data-testid="event-edit" onclick={() => (editing = event.id)}>
                  <svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor" aria-hidden="true"><path d="M13.6 2.6a2 2 0 0 1 2.8 0l1 1a2 2 0 0 1 0 2.8L8 15.8 3.5 17l1.2-4.5 8.9-9.9Z"/></svg>
                </button>
              {/if}
              <button class="icon-btn text-red-400" title="Remove" onclick={() => removeEvent(item.lineId, event.id)}>✕</button>
            </div>
          {/each}
        {/if}
      </li>
    {/each}
  </ol>

  <hr class="border-[#444] my-1" />

  <div class="font-semibold text-sm">Add to the sequence</div>
  <div class="flex rounded overflow-hidden border border-[#444] text-sm w-fit">
    <button class="px-3 py-1 {addMode === 'function' ? 'bg-yellow-500 text-black font-semibold' : 'bg-[#2b2b2b]'}"
      onclick={() => (addMode = "function")} data-testid="add-mode-function">Function</button>
    <button class="px-3 py-1 {addMode === 'path' ? 'bg-yellow-500 text-black font-semibold' : 'bg-[#2b2b2b]'}"
      onclick={() => (addMode = "path")} data-testid="add-mode-path">Function on a path</button>
  </div>
  {#if addMode === "function"}
    <div class="grid grid-cols-[auto_1fr] items-center gap-2 text-sm">
      <span class="text-neutral-400">Function</span>
      <select class="bg-[#2b2b2b] border border-[#444] rounded px-2 py-1" bind:value={addFunctionAction} data-testid="fn-action">
        {#each stepActions as action (action.name)}<option value={action.name} title={action.description}>{action.label}</option>{/each}
      </select>
      {#each byName.get(addFunctionAction)?.params ?? [] as param (param.name)}
        <span class="text-neutral-400">{param.label}</span>
        <span class="flex items-center gap-2">
          <input type="number" step="0.1" min={param.min} max={param.max}
            class="w-20 bg-[#2b2b2b] border border-[#444] rounded px-1 text-right" data-testid="fn-param"
            value={addParams(addFunctionAction)[param.name]}
            oninput={(e) => setAddParam(addFunctionAction, param.name, Number((e.target as HTMLInputElement).value))} />
          <span class="text-neutral-400">{param.unit}</span>
        </span>
      {/each}
      <span class="text-neutral-400">After</span>
      <select class="bg-[#2b2b2b] border border-[#444] rounded px-2 py-1" bind:value={addAfter} data-testid="fn-after">
        <option value="end">the end</option>
        {#each currentSequence() as item, index (index)}<option value={String(index)}>{stepLabel(item, index)}</option>{/each}
      </select>
    </div>
    <button class="px-3 py-1 rounded bg-[#333] text-sm w-fit" onclick={addFunction} data-testid="fn-add">+ Add function</button>
    <div class="text-xs text-neutral-400">{byName.get(addFunctionAction)?.description ?? ""}</div>
  {:else}
    <div class="grid grid-cols-[auto_1fr] items-center gap-2 text-sm">
      <span class="text-neutral-400">Path</span>
      <select class="bg-[#2b2b2b] border border-[#444] rounded px-2 py-1" bind:value={addPathId} data-testid="onpath-path">
        {#each allPaths as line (line.id)}<option value={line.id}>{names.get(line.id)}</option>{/each}
      </select>
      <span class="text-neutral-400">Function</span>
      <select class="bg-[#2b2b2b] border border-[#444] rounded px-2 py-1" bind:value={addOnPathAction} data-testid="onpath-action">
        {#each pathActions as action (action.name)}<option value={action.name} title={action.description}>{action.label}</option>{/each}
      </select>
      {#each byName.get(addOnPathAction)?.params ?? [] as param (param.name)}
        <span class="text-neutral-400">{param.label}</span>
        <span class="flex items-center gap-2">
          <input type="number" step="0.1" min={param.min} max={param.max}
            class="w-20 bg-[#2b2b2b] border border-[#444] rounded px-1 text-right" data-testid="onpath-param"
            value={addParams(addOnPathAction)[param.name]}
            oninput={(e) => setAddParam(addOnPathAction, param.name, Number((e.target as HTMLInputElement).value))} />
          <span class="text-neutral-400">{param.unit}</span>
        </span>
      {/each}
      <span class="text-neutral-400">At</span>
      <span class="flex items-center gap-2">
        <input type="range" min="0" max="100" step="1" class="flex-1" bind:value={addPercent} />
        <input type="number" min="0" max="100" step="1" class="w-16 bg-[#2b2b2b] border border-[#444] rounded px-1 text-right"
          bind:value={addPercent} data-testid="onpath-at" />
        <span class="text-neutral-400">% along</span>
      </span>
    </div>
    <button class="px-3 py-1 rounded bg-[#333] text-sm w-fit" onclick={addOnPath} data-testid="onpath-add">+ Add on path</button>
    <div class="text-xs text-neutral-400">Fires while the robot drives, when it is that far along the path. Shown as ◆
      on the field and under the path above. Only instant functions can go on a path; ones that take time
      (shoot, wait) are added as a Function.</div>
  {/if}
</div>

<style>
  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.6rem;
    height: 1.6rem;
    border-radius: 0.3rem;
    color: #a3a3a3;
  }
  .icon-btn:hover {
    background: #3a3a3a;
    color: #fff;
  }
</style>
