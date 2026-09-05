import { isFullGM } from "../permissions.js";
import { isAuthoritativeGM } from "../socket-authority.js";
import { hasCampaignTabLeadership } from "../campaign-tab-leadership.js";
import { isAssignedPlayerCharacter } from "./actors.js";
import { resolveSimpleCalendarApi } from "./calendar.js";
import { createRecordedInjuryApi } from "./recorded-injuries.js";

export const recordedInjuryApi = createRecordedInjuryApi({
  game: () => globalThis.game,
  fromUuid: (uuid) => globalThis.fromUuid(uuid),
  isFullGM: () => isFullGM(),
  canWrite: () => isAuthoritativeGM() && hasCampaignTabLeadership(),
  isAssigned: (actor) => isAssignedPlayerCharacter(actor),
  calendar: () => resolveSimpleCalendarApi(),
});
