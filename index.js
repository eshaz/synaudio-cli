#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import os from "os";
import { syncResampleEncode } from "./src/synaudio-cli.js";

const cpuCoreCount = os.cpus().length;
const syncOptionsGroup =
  "Sync Options: (seconds are rounded to fit the sample rate)";
const outputOptionsGroup = "Output Options:";

const argv = yargs(hideBin(process.argv))
  .command(
    "$0 <base-file> <comparison-file>",
    "syncs the <comparison_file> to the <base_file>",
    (yargs) => {
      yargs
        .positional("base-file", {
          describe: "File used as the base of comparison.",
          type: "string",
        })
        .positional("comparison-file", {
          describe: "File that will be synced against the base file.",
          type: "string",
        });
    },
  )
  .completion()
  .option("t", {
    alias: "threads",
    default: cpuCoreCount,
    describe: "Number of threads to spawn while comparing audio.",
    type: "number",
    min: 1,
    max: cpuCoreCount,
  })
  .option("flac-threads", {
    default: Math.min(cpuCoreCount, 16),
    describe:
      "Number of threads to spawn while encoding using `flac`. Set to 1 to disable threading.",
    type: "number",
    min: 1,
    max: 16,
  })
  .option("R", {
    alias: "rectify",
    group: syncOptionsGroup,
    default: true,
    describe: "Rectify the audio before comparing for better cross-correlation",
    type: "boolean",
  })
  .options("T", {
    alias: "rate-tolerance",
    group: syncOptionsGroup,
    default: 0.5,
    describe:
      "Duration in seconds describing how much +- the rate might differ from the base file.",
    min: 0,
    type: "number",
  })
  .options("L", {
    alias: "sample-length",
    group: syncOptionsGroup,
    default: 0.125,
    describe: "Duration in seconds of each comparison file sample.",
    min: 0,
    type: "number",
  })
  .options("G", {
    alias: "sample-gap",
    group: syncOptionsGroup,
    default: 10,
    describe:
      "Duration in seconds to skip between samples of the comparison file.",
    min: 0,
    type: "number",
  })
  .options("S", {
    alias: "start-range",
    group: syncOptionsGroup,
    default: 60 * 3,
    describe: "Duration in seconds to try to sync before the sample.",
    min: 0,
    type: "number",
  })
  .options("E", {
    alias: "end-range",
    group: syncOptionsGroup,
    default: 60 * 1,
    describe: "Duration in seconds to try to sync after the sample.",
    min: 0,
    type: "number",
  })
  .option("d", {
    alias: "delete-comparison",
    group: outputOptionsGroup,
    default: false,
    describe: "Delete the original comparison file after successfully syncing.",
    type: "boolean",
  })
  .option("n", {
    alias: "normalize",
    group: outputOptionsGroup,
    default: false,
    describe: "Normalize the output audio.",
    type: "boolean",
  })
  .option("m", {
    alias: "normalize-independent",
    group: outputOptionsGroup,
    default: false,
    describe: "Normalize the output audio independently for each channel.",
    type: "boolean",
  })
  .option("e", {
    alias: "encode-options",
    group: outputOptionsGroup,
    default: "--best",
    describe: "Encode options supplied to `flac`",
    type: "string",
  })
  .option("r", {
    alias: "rename-string",
    group: outputOptionsGroup,
    default: ".synced",
    describe:
      "String to insert in the synced file before the extension. i.e. comparison.flac -> comparison.synced.flac",
    type: "string",
  })
  .wrap(yargs.terminalWidth)
  .parse();

syncResampleEncode(argv);
