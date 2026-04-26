---
name: Summarize File
description: Read a file and provide a structured summary with key points
allowed-tools: [read, grep]
argument-hint: "[file path]"
when-to-use: When the user wants a quick summary of a file's contents
---

Read the file at $ARGUMENTS and provide a structured summary:

1. **What it is**: One sentence describing the file's purpose
2. **Key sections**: List the main sections or components
3. **Size**: How many lines, approximate complexity
4. **Notable**: Anything interesting or unusual about the content

Keep the summary under 10 lines. Be concise.
