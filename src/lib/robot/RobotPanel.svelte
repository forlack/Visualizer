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
    recordChange?: () => void;
  }

  let {
    startPoint = $bindable(),
    lines = $bindable(),
    sequence = $bindable(),
    selectedLine = null,
    totalTime = 0,
    recordChange,
  }: Props = $props();

  let actions: RobotActionDef[] = $state(BUILT_IN_ACTIONS);
  let online = $state(false);
  let robotName = $state("");
  let routeName = $state(loadName());
  let routes: string[] = $state([]);
  let loadedHash: string | null = $state(null);
  let message = $state("");
  let messageBad = $state(false);
  let problems: string[] = $state([]);
  let addStepAction = $state("shoot");
  let addEventAction = $state("flywheelsOn");

  let stepActions = $derived(actions);
  let pathActions = $derived(actions.filter((a) => a.onPath));
  let byName = $derived(new Map(actions.map((a) => [a.name, a])));
  let names = $derived(pathNames(lines, startPoint));
  let colors = $derived(new Map(atomicSegments(lines).map((l) => [l.id, l.color])));
  let fileName = $derived(`autos/${safeName(routeName)}.json`);

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

  // ---- Steps between paths ----------------------------------------------------

  /** The sequence, filled in with every path when it is empty (the editor's default). */
  function currentSequence(): SequenceItem[] {
    return sequence.length ? sequence : atomicSegments(lines).map((l) => ({ kind: "path" as const, lineId: l.id }));
  }

  function addStep() {
    const def = byName.get(addStepAction);
    if (!def) return;
    const items = [...currentSequence()];
    // After the selected path's step, or at the end.
    let at = items.length;
    if (selectedLine) {
      const index = items.findIndex((i) => i.kind === "path" && i.lineId === selectedLine!.id);
      if (index >= 0) {
        at = index + 1;
        while (at < items.length && items[at].kind === "wait") at++;
      }
    }
    items.splice(at, 0, actionStep(def));
    sequence = items;
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

  // ---- Actions along the selected path -------------------------------------------

  function updateSelected(change: (line: AtomicPath) => AtomicPath) {
    if (!selectedLine) return;
    const id = selectedLine.id;
    const walk = (nodes: Path[]): Path[] => nodes.map((node) =>
      node.kind === "compound" ? { ...node, segments: walk(node.segments) }
        : node.id === id ? change(node) : node);
    lines = walk(lines);
  }

  function addEvent() {
    const def = byName.get(addEventAction);
    if (!def || !selectedLine) return;
    updateSelected((line) => ({
      ...line,
      robotEvents: [...(line.robotEvents ?? []), {
        id: makePathId().replace("line-", "event-"), at: 0.5, action: def.name, params: defaultParams(def),
      }],
    }));
    recordChange?.();
  }

  function setEvent(eventId: string, change: Record<string, unknown>) {
    updateSelected((line) => ({
      ...line,
      robotEvents: (line.robotEvents ?? []).map((e) => (e.id === eventId ? { ...e, ...change } : e)),
    }));
  }

  function removeEvent(eventId: string) {
    updateSelected((line) => ({ ...line, robotEvents: (line.robotEvents ?? []).filter((e) => e.id !== eventId) }));
    recordChange?.();
  }

  // ---- Files ----------------------------------------------------------------------

  function build() {
    const result = exportRoute(routeName, startPoint, lines, sequence, actions);
    problems = result.problems;
    return result;
  }

  async function saveToRobot() {
    const { route, problems: found } = build();
    if (found.length && !confirm(`Problems:\n\n${found.join("\n")}\n\nSave anyway?`)) return;
    try {
      const result = await saveRobotRoute(fileName, JSON.stringify(route, null, 2) + "\n",
        loadedHash && routes.includes(fileName) ? loadedHash : "*");
      loadedHash = result.hash;
      try { localStorage.setItem("biobuzz.route", routeName); } catch { /* private window */ }
      say(`Saved ${fileName} on ${robotName || "the robot"}. Press INIT to run it.`);
      window.parent?.postMessage({ type: "biobuzz:saved", path: fileName }, "*");
      refreshRoutes();
    } catch (error) {
      say(String((error as Error).message), true);
    }
  }

  function applyImported(text: string) {
    const imported = importRoute(text, actions);
    startPoint = imported.startPoint;
    lines = imported.lines;
    sequence = imported.sequence;
    routeName = imported.name;
    problems = imported.problems;
    recordChange?.();
  }

  async function loadFromRobot(path: string) {
    if (!path) return;
    try {
      const { text, hash } = await loadRobotRoute(path);
      applyImported(text);
      routeName = path.replace(/^autos\//, "").replace(/\.json$/, "");
      loadedHash = hash;
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
    <div class="font-semibold">Robot route</div>
    <span class="text-xs px-2 py-0.5 rounded-full {online ? 'bg-green-900/50 text-green-300' : 'bg-neutral-700 text-neutral-300'}"
      title={online ? "Actions come from the robot" : "Not served by a robot: using the built-in action list"}>
      {online ? `connected: ${robotName}` : "offline"}
    </span>
  </div>

  <div class="flex flex-wrap items-center gap-2">
    <input class="flex-1 min-w-32 bg-[#2b2b2b] border border-[#444] rounded px-2 py-1 text-sm"
      bind:value={routeName} aria-label="Route name" data-testid="route-name" />
    <button class="px-2 py-1 rounded bg-yellow-500 text-black text-sm font-semibold disabled:opacity-40"
      onclick={saveToRobot} disabled={!online} data-testid="route-save">Save to robot</button>
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
  <div class="text-xs text-neutral-400">Saves as <code>{fileName}</code>. Set <code>PedroAutonomous.ROUTE</code>
    to <code>{safeName(routeName)}</code> in the dashboard's Tune tab to run it.</div>
  {#if message}<div class="text-sm {messageBad ? 'text-red-400' : 'text-green-400'}" data-testid="route-message">{message}</div>{/if}
  {#each problems as problem (problem)}<div class="text-sm text-amber-400">⚠ {problem}</div>{/each}

  <div class="flex items-center justify-between">
    <div class="font-semibold text-sm">Steps</div>
    <div class="text-xs {totalTime > 30 ? 'text-red-400 font-semibold' : 'text-neutral-400'}" data-testid="route-time">
      about {totalTime.toFixed(1)} s{totalTime > 30 ? " — over the 30 s autonomous!" : " of 30 s"}
    </div>
  </div>
  <ol class="flex flex-col gap-1 text-sm" data-testid="route-steps">
    {#each currentSequence() as item, index (item.kind === "path" ? `p-${item.lineId}-${index}` : item.id)}
      <li class="flex items-center gap-2 bg-[#2a2a2a] rounded px-2 py-1">
        <span class="text-neutral-500 w-5 text-right">{index + 1}</span>
        {#if item.kind === "path"}
          <span class="size-2.5 rounded-full" style="background:{colors.get(item.lineId) ?? '#fff'}"></span>
          <span class="flex-1">follow <b>{names.get(item.lineId) ?? "?"}</b></span>
        {:else}
          <span class="flex-1">⚙ <b>{item.robotAction ? label(item.robotAction.name) : "wait"}</b>
            {#if item.robotAction}
              {#each byName.get(item.robotAction.name)?.params ?? [] as param (param.name)}
                <input type="number" step="0.1" min={param.min} max={param.max}
                  class="w-16 ml-1 bg-[#333] border border-[#444] rounded px-1 text-right"
                  value={item.robotAction.params[param.name] ?? param.default}
                  title={param.label}
                  onchange={(e) => setStepParam(index, param.name, Number((e.target as HTMLInputElement).value))} />
                <span class="text-neutral-400">{param.unit}</span>
              {/each}
            {:else}
              <span class="text-neutral-400">{describeStep(item)}</span>
            {/if}
          </span>
          <button class="text-red-400 px-1" title="Remove" onclick={() => removeStep(index)}>✕</button>
        {/if}
        <button class="px-1 text-neutral-400" title="Move up" onclick={() => moveStep(index, -1)}>↑</button>
        <button class="px-1 text-neutral-400" title="Move down" onclick={() => moveStep(index, 1)}>↓</button>
      </li>
    {/each}
  </ol>
  <div class="flex items-center gap-2 text-sm">
    <select class="flex-1 bg-[#2b2b2b] border border-[#444] rounded px-2 py-1" bind:value={addStepAction} data-testid="step-action">
      {#each stepActions as action (action.name)}<option value={action.name} title={action.description}>{action.label}</option>{/each}
    </select>
    <button class="px-2 py-1 rounded bg-[#333]" onclick={addStep} data-testid="step-add">
      + Add step{selectedLine ? ` after ${names.get(selectedLine.id) ?? "path"}` : ""}</button>
  </div>

  <div class="font-semibold text-sm mt-1">
    On the path{selectedLine ? `: ${names.get(selectedLine.id) ?? ""}` : ""}
  </div>
  {#if selectedLine}
    {#each selectedLine.robotEvents ?? [] as event (event.id)}
      <div class="flex items-center gap-2 text-sm bg-[#2a2a2a] rounded px-2 py-1">
        <span class="text-yellow-400">◆</span>
        <select class="bg-[#333] border border-[#444] rounded px-1" value={event.action}
          onchange={(e) => setEvent(event.id, { action: (e.target as HTMLSelectElement).value })}>
          {#each pathActions as action (action.name)}<option value={action.name}>{action.label}</option>{/each}
        </select>
        <span class="text-neutral-400">at</span>
        <input type="range" min="0" max="100" step="1" class="flex-1" value={Math.round(event.at * 100)}
          oninput={(e) => setEvent(event.id, { at: Number((e.target as HTMLInputElement).value) / 100 })}
          onchange={() => recordChange?.()} data-testid="event-at" />
        <span class="w-10 text-right tabular-nums">{Math.round(event.at * 100)}%</span>
        <button class="text-red-400 px-1" title="Remove" onclick={() => removeEvent(event.id)}>✕</button>
      </div>
    {/each}
    <div class="flex items-center gap-2 text-sm">
      <select class="flex-1 bg-[#2b2b2b] border border-[#444] rounded px-2 py-1" bind:value={addEventAction} data-testid="event-action">
        {#each pathActions as action (action.name)}<option value={action.name} title={action.description}>{action.label}</option>{/each}
      </select>
      <button class="px-2 py-1 rounded bg-[#333]" onclick={addEvent} data-testid="event-add">+ Add on this path</button>
    </div>
    <div class="text-xs text-neutral-400">Instant actions fire part way along the path, shown as ◆ on the field.
      Actions that take time (shoot, wait) go between paths as steps.</div>
  {:else}
    <div class="text-sm text-neutral-400">Select a path to put actions on it.</div>
  {/if}
</div>
