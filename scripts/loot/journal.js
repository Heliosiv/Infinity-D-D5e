/**
 * Infinity D&D5e — journal export.
 *
 * Turns a rolled haul into a JournalEntry with a single HTML page, so a
 * GM can keep a permanent record of a roll (or paste it into prep). The
 * page body reuses the same chat-card HTML the tools build for
 * Send-to-Chat, so there's one source of truth for roll presentation.
 */

import { notify } from "../ui-util.js";

const MODULE_ID = "infinity-dnd5e";

/**
 * Create a JournalEntry from pre-built HTML and open its sheet.
 *
 * @param {object} opts
 * @param {string} opts.title - entry + page name
 * @param {string} opts.html  - page body (the tool's chat-card HTML)
 * @returns {Promise<JournalEntry|null>}
 */
export async function buildJournalEntry({ title, html } = {}) {
  if (
    typeof globalThis.game === "undefined" ||
    typeof globalThis.JournalEntry === "undefined"
  ) {
    throw new Error("NotInFoundry: buildJournalEntry requires Foundry runtime");
  }
  const name = String(title ?? "").trim() || "Infinity D&D5e Loot";
  try {
    const entry = await globalThis.JournalEntry.create({
      name,
      pages: [
        {
          name,
          type: "text",
          // 1 === CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML
          text: { content: String(html ?? ""), format: 1 },
        },
      ],
    });
    entry?.sheet?.render(true);
    notify("info", `saved loot to journal "${name}".`);
    return entry;
  } catch (error) {
    console.error(`${MODULE_ID} | failed to create journal entry`, error);
    ui.notifications?.error(
      `${MODULE_ID}: could not create the journal entry. See console.`,
    );
    return null;
  }
}
