import { loadConfig } from "./config.js";
import { startServer } from "./server.js";
import { loadTokens } from "./auth.js";

console.log(`
  ╔═══════════════════════════════════╗
  ║       SECRET AGENT X  v0.1       ║
  ╚═══════════════════════════════════╝
`);

const config = loadConfig();

// Check auth status
const tokens = loadTokens();
if (!config.openaiApiKey && !tokens) {
  console.log("  No API key or OAuth tokens found.");
  console.log("  Set OPENAI_API_KEY in your environment, or");
  console.log("  use the dashboard to sign in with OpenAI OAuth.\n");
}

// Handle CLI args
const args = process.argv.slice(2);
if (args.includes("--login")) {
  const { startOAuthLogin } = await import("./auth.js");
  try {
    await startOAuthLogin();
    console.log("[auth] Login successful!");
  } catch (e) {
    console.error("[auth] Login failed:", (e as Error).message);
    process.exit(1);
  }
}

startServer(config);
