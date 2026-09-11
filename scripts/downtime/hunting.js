/** Drakmor active hunting: pure rules and public projections. */
import { getDefaultEnvironments } from "../resource/environment.js";

export const HUNTING_ID = "guided-hunting";
export const HUNTING_TEMPLATE = Object.freeze({
  id: HUNTING_ID,
  name: "Hunting",
  description:
    "Track game with Survival, then take one ranged shot. A miss ends the hunt. Eight hours improves your chance of finding larger game.",
  image: "icons/skills/ranged/arrow-flying-brown.webp",
  blockHours: 4,
  skills: ["sur"],
  outcomes: ["No game found", "Game escaped", "Game secured"].map((label) => ({
    label,
    report: "Your hunt and its supplies are recorded below.",
    rewardGp: 0,
  })),
});
const names = {
  "biome-swamp": ["Marsh bird", "Wild pig", "Marsh deer"],
  "biome-desert": ["Desert hare", "Gazelle", "Antelope"],
  "biome-tundra": ["Ptarmigan", "Arctic hare", "Caribou"],
  "biome-mountains": ["Game bird", "Marmot", "Mountain goat"],
};
export function defaultHuntingRegions() {
  return getDefaultEnvironments()
    .filter((e) => e.id.startsWith("biome-"))
    .map((e) => ({
      id: e.id,
      name: e.label,
      activityIds: [HUNTING_ID, "guided-scouting", "guided-reflection"],
      dc: e.id === "biome-forest" ? 10 : 12,
      difficulty: e.id === "biome-forest" ? "Favorable" : "Standard",
      risk: 10,
      game: (names[e.id] ?? ["Rabbit", "Wild pig", "Deer"]).map((name, i) => ({
        name,
        size: ["Small", "Medium", "Large"][i],
        ac: [13, 12, 12][i],
        food: [2, 6, 20][i],
        ordinary: [60, 30, 10][i],
        exceptional: [25, 40, 35][i],
      })),
    }));
}
function integer(value, min, max, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error(`${label}: enter a whole number from ${min} to ${max}.`);
  return n;
}
const text = (value, max = 100) =>
  String(value ?? "")
    .trim()
    .slice(0, max);
export function normalizeHuntingRegion(raw) {
  if (!raw || !/^[A-Za-z0-9_-]{1,80}$/.test(raw.id) || !text(raw.name))
    throw new Error("Name the hunting area.");
  const game = (Array.isArray(raw.game) ? raw.game : []).map((row) => ({
    name: text(row.name),
    size: text(row.size, 30),
    ac: integer(row.ac, 1, 40, "Hunting AC"),
    food: integer(row.food, 1, 1000, "Food portions"),
    ordinary: integer(row.ordinary, 0, 100, "Ordinary chance"),
    exceptional: integer(row.exceptional, 0, 100, "Exceptional chance"),
  }));
  if (
    !game.length ||
    game.length > 20 ||
    game.some((g) => !g.name || !g.size) ||
    ["ordinary", "exceptional"].some(
      (k) => game.reduce((n, g) => n + g[k], 0) !== 100,
    )
  )
    throw new Error(
      "Name each animal and make each chance column total 100% (at most 20 animals).",
    );
  if (!text(raw.difficulty, 60))
    throw new Error("Enter a player difficulty label.");
  return {
    id: raw.id,
    name: text(raw.name),
    dc: integer(raw.dc, 4, 40, "Base Survival DC"),
    difficulty: text(raw.difficulty, 60),
    risk: integer(raw.risk, 0, 100, "Complication chance"),
    game,
    activityIds: [...new Set((raw.activityIds ?? []).map(String))].slice(0, 64),
  };
}
/** This is the ONLY region representation allowed in shared block storage. */
export function publicHuntingRegion(region) {
  return {
    id: region.id,
    name: region.name,
    difficulty: region.difficulty,
    risk: region.risk,
    game: region.game.map(({ name, size, food, ordinary, exceptional }) => ({
      name,
      size,
      food,
      ordinary,
      exceptional,
    })),
  };
}
export function huntingDc(base, hours) {
  if (![4, 8].includes(hours))
    throw new Error("Choose a four-hour or eight-hour hunt.");
  return base - (hours === 8 ? 4 : 0);
}
export function findHuntingGame(
  region,
  hours,
  total,
  percentile,
  complicationRoll,
) {
  if (![total, percentile, complicationRoll].every(Number.isFinite))
    throw new Error("Invalid hunting roll.");
  integer(percentile, 1, 100, "Game roll");
  integer(complicationRoll, 1, 100, "Complication roll");
  const margin = total - huntingDc(region.dc, hours);
  const band = margin < 0 ? "failure" : margin >= 5 ? "exceptional" : "success";
  let gameIndex = -1;
  if (margin >= 0) {
    let cumulative = 0;
    gameIndex = region.game.findIndex(
      (g) =>
        (cumulative +=
          g[band === "exceptional" ? "exceptional" : "ordinary"]) >= percentile,
    );
    if (gameIndex < 0) throw new Error("The hunting table must total 100%.");
  }
  return { band, gameIndex, complication: complicationRoll <= region.risk };
}
export function huntingHit(total, natural, ac) {
  return natural === 1 ? false : natural === 20 ? true : total >= ac;
}
export function huntingSummary(hunt) {
  const result =
    hunt.stage === "attack"
      ? `${hunt.game.name} found. Take your one ranged shot.`
      : !hunt.game
        ? "No shootable game found. No ammunition spent."
        : hunt.hit
          ? `${hunt.game.name} secured: ${hunt.game.food} food portions. One ammunition spent.`
          : `${hunt.game.name} escaped. The missed shot ends the hunt. One ammunition spent; no food gained.`;
  const checks = `Survival ${hunt.survival.total} (${hunt.band})${hunt.attack ? `; ranged attack ${hunt.attack.total}` : ""}.`;
  return `${hunt.hours}h hunt — ${result} ${checks} Complication chance ${hunt.risk}%. ${hunt.complication ? "Complication triggered: the GM adds the consequence to the report." : "No complication."}`;
}
