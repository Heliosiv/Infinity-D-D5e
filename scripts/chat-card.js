/**
 * Infinity D&D5e — shared chat-card markup contract.
 *
 * Plain strings are escaped automatically. Rich details must cross the
 * explicit trusted-markup boundary after their caller has applied its existing
 * sanitizers. This keeps Foundry UUID links and intentional semantic markup
 * without weakening any receipt's current privacy or sanitization rules.
 */

const TRUSTED_CHAT_HTML = Symbol("infinity-dnd5e.trusted-chat-html");
const TONES = new Set(["neutral", "info", "success", "warning", "danger"]);

/** Mark caller-sanitized rich detail markup for insertion into a chat card. */
export function markTrustedChatHtml(html) {
  return Object.freeze({
    [TRUSTED_CHAT_HTML]: true,
    html: String(html ?? ""),
  });
}

/** Plain-language audience copy for the module's existing chat mode keys. */
export function describeChatAudience(mode) {
  switch (String(mode ?? "")) {
    case "public":
      return "Visible to everyone in chat.";
    case "whisper-gm":
      return "Visible only to GMs.";
    case "whisper-players":
      return "Visible only to active players.";
    case "whisper-gm-buyer":
      return "Visible to GMs and the character's controlling player.";
    case "whisper-gm-owner":
      return "Visible to GMs and affected character owners.";
    case "owner-gm":
      return "Visible to the character's owner and full GMs.";
    default:
      return "Shared according to this tool's chat setting.";
  }
}

/**
 * Build a consistent module chat card. Recipient selection remains the
 * caller's responsibility and is intentionally absent from this pure helper.
 */
export function buildInfinityChatCard({
  title = "Infinity D&D5e",
  outcome = "Complete.",
  audience = "Shared according to this tool's chat setting.",
  details = "No additional details.",
  nextAction = "No further action is needed.",
  tone = "neutral",
  classes = [],
} = {}) {
  const safeTone = TONES.has(String(tone)) ? String(tone) : "neutral";
  const classNames = [
    "infinity-dnd5e",
    "infinity-chat-card",
    ...sanitizeClassNames(classes),
  ].join(" ");
  return `
<article class="${classNames}" data-tone="${safeTone}">
  <header class="infinity-chat-card__outcome" aria-label="Outcome">
    <p class="infinity-chat-card__label">Outcome</p>
    <h3 class="infinity-chat-card__title">${escapeHtml(title)}</h3>
    <p class="infinity-chat-card__summary">${escapeHtml(outcome)}</p>
  </header>
  <section class="infinity-chat-card__section infinity-chat-card__audience" aria-label="Audience">
    <p class="infinity-chat-card__label">Audience</p>
    <p>${escapeHtml(audience)}</p>
  </section>
  <section class="infinity-chat-card__section infinity-chat-card__details" aria-label="Details">
    <p class="infinity-chat-card__label">Details</p>
    ${renderDetails(details)}
  </section>
  <footer class="infinity-chat-card__section infinity-chat-card__next" aria-label="Next action">
    <p class="infinity-chat-card__label">Next action</p>
    <p>${escapeHtml(nextAction)}</p>
  </footer>
</article>`;
}

function renderDetails(details) {
  if (details?.[TRUSTED_CHAT_HTML] === true) return details.html;
  return `<p>${escapeHtml(details || "No additional details.")}</p>`;
}

function sanitizeClassNames(classes) {
  const source = typeof classes === "string" ? classes.split(/\s+/) : classes;
  if (!Array.isArray(source) && !(source instanceof Set)) return [];
  return [...new Set(source)]
    .map((entry) => String(entry ?? "").trim())
    .filter((entry) => /^[a-zA-Z0-9_-]+$/.test(entry));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
