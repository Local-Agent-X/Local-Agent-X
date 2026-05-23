import type { IntegrationConfig } from "../types.js";
import { googleIntegration } from "./google.js";
import { githubIntegration } from "./github.js";
import { slackIntegration } from "./slack.js";
import { discordIntegration } from "./discord.js";
import { twitterIntegration } from "./twitter.js";
import { facebookIntegration } from "./facebook.js";
import { instagramIntegration } from "./instagram.js";
import { spotifyIntegration } from "./spotify.js";
import { ebayIntegration } from "./ebay.js";
import { notionIntegration } from "./notion.js";
import { whatsappIntegration } from "./whatsapp.js";
import { emailIntegration } from "./email.js";

export const BUILTIN_INTEGRATIONS: IntegrationConfig[] = [
  googleIntegration,
  githubIntegration,
  slackIntegration,
  discordIntegration,
  twitterIntegration,
  facebookIntegration,
  instagramIntegration,
  spotifyIntegration,
  ebayIntegration,
  notionIntegration,
  whatsappIntegration,
  emailIntegration,
];
