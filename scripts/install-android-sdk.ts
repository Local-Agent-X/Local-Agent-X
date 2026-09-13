#!/usr/bin/env node
import { installAndroidSdk } from "../src/android/sdk-installer.js";

await installAndroidSdk((step) => { console.log(step); });
