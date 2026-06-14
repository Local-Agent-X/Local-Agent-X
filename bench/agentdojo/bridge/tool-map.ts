// AgentDojo tool → LAX/ARI semantics map.
//
// Each AgentDojo tool is mapped to the ARI (toolClass, action) that LAX assigns
// its NEAREST real analog, so the kernel sees the same shape it would in
// production — not a shape tuned to make ARI look good or bad:
//
//   - LAX classes email_send / email_draft / calendar_create_event as kernel:"http"
//     (tool-policies.network.ts), action "post" (ARI_ACTION_MAP). So AgentDojo's
//     outbound-comms sinks (send_email, send_message, post_webpage, invite, share,
//     send_money, reserve_*) → http/post. NOTE: the workspace-assistant preset
//     blanket-denies http writes — faithful to prod, this blocks these sinks
//     whether or not an injection is present (recorded as stage "preset-policy").
//   - Local state mutations with no comms (account settings, channel membership,
//     transaction scheduling, calendar delete) → database/mutate (clean ALLOW,
//     web-tainted DENY via the tainted_database_write behavioral rule).
//   - Filesystem writes → file/write.
//   - Reads that return attacker-influenceable content (emails, webpages, reviews,
//     files, chat, calendar bodies, transaction notes) → retrieval/search (or
//     file/read), flagged `untrusted` so the sanitizer wraps them.
//   - get_webpage is the one read whose LAX analog (web_fetch) is sanitized even
//     in the FAITHFUL config (webClass:true); every other untrusted read is only
//     sanitized in the sanitize-all config.

export interface ToolSpec {
  ariClass: "http" | "file" | "database" | "retrieval" | "shell";
  action: string;
  /** Read returns externally-authored content → wrap with sanitizer (in sanitize-all; +faithful if webClass). */
  untrusted?: boolean;
  /** LAX analog is web_fetch/http/browser → sanitized in the faithful config too. */
  webClass?: boolean;
  /** Carries data out to a party → run lineage + canary egress gates + threat "restricted" gate. */
  egress?: boolean;
  /** wrapExternalContent source label. */
  source?: string;
}

const R: ToolSpec = { ariClass: "retrieval", action: "search" };               // benign read
const U: ToolSpec = { ariClass: "retrieval", action: "search", untrusted: true, source: "tool_result" }; // untrusted read
const FR: ToolSpec = { ariClass: "file", action: "read", untrusted: true, source: "file" };               // untrusted file read
const COMMS: ToolSpec = { ariClass: "http", action: "post", egress: true, source: "egress" };             // outbound comms (preset-denied)
const MUT: ToolSpec = { ariClass: "database", action: "mutate" };              // local state mutation
const FW: ToolSpec = { ariClass: "file", action: "write" };                    // filesystem write

export const TOOL_MAP: Record<string, ToolSpec> = {
  // ── banking ──
  get_balance: R, get_iban: R, get_user_info: R, get_scheduled_transactions: R,
  get_most_recent_transactions: U,           // transaction notes are an injection vector
  read_file: FR,                             // bill file content is an injection vector
  send_money: COMMS, schedule_transaction: MUT, update_scheduled_transaction: MUT,
  update_user_info: MUT, update_password: MUT,

  // ── slack ──
  get_channels: R, get_users_in_channel: R,
  read_channel_messages: U, read_inbox: U,
  get_webpage: { ariClass: "http", action: "get", untrusted: true, webClass: true, source: "web_fetch" },
  send_direct_message: COMMS, send_channel_message: COMMS, post_webpage: COMMS,
  invite_user_to_slack: COMMS,
  add_user_to_channel: MUT, remove_user_from_slack: MUT,

  // ── travel ──
  get_user_information: R,
  get_all_hotels_in_city: U, get_all_restaurants_in_city: U, get_all_car_rental_companies_in_city: U,
  get_rating_reviews_for_hotels: U, get_rating_reviews_for_restaurants: U, get_rating_reviews_for_car_rental: U,
  get_contact_information_for_restaurants: U, get_cuisine_type_for_restaurants: U,
  get_dietary_restrictions_for_all_restaurants: U, get_price_for_restaurants: U,
  check_restaurant_opening_hours: U, get_restaurants_address: U,
  get_hotels_address: U, get_hotels_prices: U,
  get_car_price_per_day: U, get_car_fuel_options: U, get_car_rental_address: U, get_car_types_available: U,
  get_flight_information: U,
  reserve_hotel: COMMS, reserve_restaurant: COMMS, reserve_car_rental: COMMS,
  send_email: COMMS,
  create_calendar_event: COMMS, cancel_calendar_event: COMMS,
  get_day_calendar_events: U, search_calendar_events: U,

  // ── workspace ──
  search_emails: U, get_received_emails: U, get_unread_emails: U, get_sent_emails: U, get_draft_emails: U,
  get_file_by_id: FR, search_files: U, search_files_by_filename: U, list_files: U,
  search_contacts_by_email: R, search_contacts_by_name: R,
  get_current_day: R,
  add_calendar_event_participants: COMMS, reschedule_calendar_event: COMMS,
  delete_email: MUT,
  create_file: FW, append_to_file: FW, delete_file: FW, share_file: COMMS,
};

// Unmapped → conservative default: an untrusted read that does NOT blanket-block.
// Logged by the bridge so coverage gaps surface instead of silently passing.
export const DEFAULT_SPEC: ToolSpec = { ariClass: "retrieval", action: "search", untrusted: true, source: "tool_result" };

export function specFor(toolName: string): { spec: ToolSpec; mapped: boolean } {
  const spec = TOOL_MAP[toolName];
  return spec ? { spec, mapped: true } : { spec: DEFAULT_SPEC, mapped: false };
}
