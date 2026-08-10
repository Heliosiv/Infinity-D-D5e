/**
 * Backward-compatible Merchant names for the shared campaign tab leader.
 *
 * These aliases intentionally use the same singleton as Quartermaster and
 * every other authoritative campaign writer in this browser. The release
 * alias is retained for compatibility; global lifecycle code owns release,
 * rather than an individual feature subsystem.
 */

export const MERCHANT_TAB_LEADERSHIP_HOOK =
  "infinity-dnd5e.merchantTabLeadership";

export {
  createCampaignTabLeadership as createMerchantTabLeadership,
  ensureCampaignTabLeadership as ensureMerchantTabLeadership,
  getCampaignTabLeadershipStatus as getMerchantTabLeadershipStatus,
  hasCampaignTabLeadership as hasMerchantTabLeadership,
  releaseCampaignTabLeadership as releaseMerchantTabLeadership,
} from "../campaign-tab-leadership.js";
