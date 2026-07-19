#!/usr/bin/env node
import { runQualificationCli } from "./local-qualification/cli.js";

process.exitCode = await runQualificationCli(process.env, console);
