/**
 * Social Media Protocol Pack — Instagram, Twitter/X, Facebook, TikTok protocols.
 */

import type { Protocol } from "../../protocols/index.js";

export const instagramStoryMission: Protocol = {
  name: "instagram_story",
  description: "Post a story to Instagram with stickers, text overlays, and music.",
  triggers: ["post instagram story", "ig story", "share to my story", "instagram story"],
  learnablePreferences: ["instagram_username", "story_style", "default_stickers"],
  rules: [
    "Stories disappear after 24 hours — remind the user if they want to also save to highlights.",
    "Check for existing Instagram tabs before opening a new one.",
    "File picker cannot be automated — guide the user to select media.",
    "Verify the story preview before posting.",
  ],
  steps: [
    { id: "gather", instruction: "Collect media (photo/video), text overlays, and sticker preferences." },
    { id: "open_ig", instruction: "Navigate to Instagram, check login status." },
    { id: "create_story", instruction: "Click the story creation button (camera icon or '+' > Story)." },
    { id: "upload_media", instruction: "Guide user to select media from file picker.", requiresUserAction: true },
    { id: "add_overlays", instruction: "Add text, stickers, music, or other overlays as requested." },
    { id: "review", instruction: "Preview the story, verify all elements.", validate: "Story preview matches user request" },
    { id: "publish", instruction: "Post the story. Confirm it appeared." },
  ],
};

export const twitterPostMission: Protocol = {
  name: "x_post",
  description: "Post on X (formerly Twitter) with optional media, polls, threads, and scheduling.",
  triggers: ["tweet", "post on twitter", "post on x", "tweet this", "share on twitter", "post to x"],
  learnablePreferences: ["twitter_username", "tweet_style", "default_hashtags_twitter", "thread_style"],
  rules: [
    "Twitter character limit is 280 per tweet (or 25,000 for premium).",
    "For threads: number each tweet mentally, aim for 1-3 key points per tweet.",
    "Check if user has Twitter/X Blue for extended features (longer tweets, edit).",
    "Always preview the tweet before posting.",
    "For images: max 4 per tweet, max 5MB GIFs, max 512MB video.",
  ],
  steps: [
    { id: "gather", instruction: "Collect tweet content, media, and preferences (thread vs single, poll, schedule)." },
    { id: "draft", instruction: "Draft the tweet(s). Show character count. Get approval." },
    { id: "open_twitter", instruction: "Navigate to twitter.com/x.com, verify login." },
    { id: "compose", instruction: "Open the tweet composer." },
    { id: "insert_content", instruction: "Enter the tweet text. Attach media if any." },
    { id: "review", instruction: "Preview before posting.", validate: "Tweet content and media correct" },
    { id: "publish", instruction: "Click Post. Confirm the tweet is live.", requiresUserAction: true },
  ],
};

export const facebookPostMission: Protocol = {
  name: "facebook_post",
  description: "Create a Facebook post with text, photos, links, or video.",
  triggers: ["post on facebook", "facebook post", "share on fb", "post to facebook"],
  learnablePreferences: ["facebook_page", "fb_audience", "posting_style_fb"],
  rules: [
    "Check if posting to personal profile or a Page — different flows.",
    "Facebook allows very long posts but optimal engagement is under 80 characters.",
    "Link previews auto-generate — verify the preview looks correct.",
    "Privacy settings matter — confirm audience (Public, Friends, etc.) before posting.",
  ],
  steps: [
    { id: "gather", instruction: "Collect content, media, target (profile vs page), and audience setting." },
    { id: "draft", instruction: "Draft the post. Optimize for engagement." },
    { id: "open_fb", instruction: "Navigate to Facebook, verify login." },
    { id: "compose", instruction: "Click 'What's on your mind?' or navigate to the target page." },
    { id: "insert_content", instruction: "Enter text and attach media/links." },
    { id: "set_audience", instruction: "Verify and set the audience/privacy level." },
    { id: "review", instruction: "Preview the post.", validate: "Content, media, and audience correct" },
    { id: "publish", instruction: "Click Post. Confirm it's live." },
  ],
};

export const tiktokPostMission: Protocol = {
  name: "tiktok_post",
  description: "Upload and publish a video to TikTok with caption, sounds, and effects.",
  triggers: ["post on tiktok", "tiktok post", "upload to tiktok", "share on tiktok"],
  learnablePreferences: ["tiktok_username", "tiktok_style", "default_hashtags_tiktok"],
  rules: [
    "TikTok videos should be vertical (9:16 aspect ratio).",
    "Captions are limited to 2,200 characters.",
    "Hashtags are critical for TikTok discovery — use trending + niche ones.",
    "TikTok web upload is at tiktok.com/upload.",
    "Sound/music selection may not be fully automatable — guide user.",
  ],
  steps: [
    { id: "gather", instruction: "Collect video file, caption, hashtags, and sound preferences." },
    { id: "draft_caption", instruction: "Draft caption with hashtags. Optimize for discovery." },
    { id: "open_tiktok", instruction: "Navigate to tiktok.com/upload, verify login." },
    { id: "upload", instruction: "Guide user to select video file.", requiresUserAction: true },
    { id: "add_details", instruction: "Enter caption, set cover image, configure privacy/comments." },
    { id: "review", instruction: "Preview the post.", validate: "Video, caption, and settings correct" },
    { id: "publish", instruction: "Click Post. Confirm upload succeeded." },
  ],
};

export const socialProtocols: Protocol[] = [
  instagramStoryMission,
  twitterPostMission,
  facebookPostMission,
  tiktokPostMission,
];
