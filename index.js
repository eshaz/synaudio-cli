import SynAudio from "synaudio";
import fs from "fs";
import { spawn } from "child_process";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import os from "os";

const copyToSharedMemoryChunked = (
  inputChunks,
  inputLength,
  outputChunkSeconds,
  outputChunkIntervalSeconds,
  syncStartRange,
  syncEndRange,
  sampleRate,
) => {
  const sharedMemories = [];
  const samplesPerChunk = sampleRate * outputChunkSeconds;
  const samplesToSkip = sampleRate * outputChunkIntervalSeconds;

  let sharedMemory = null;

  let currentPosition = 0; // total bytes read
  let nextStart = 0;
  let nextEnd = 0;
  let sharedMemoryPosition = 0;

  for (const chunk of inputChunks) {
    if (currentPosition >= nextEnd) {
      // start a new output chunk
      nextStart = nextEnd + samplesToSkip;
      nextEnd = Math.min(nextStart + samplesPerChunk, inputLength);

      if (nextStart >= inputLength) {
        // next output chunk would start be beyond the input data
        break;
      }
      const sharedMemoryBuffer = new SharedArrayBuffer(
        (nextEnd - nextStart) * Float32Array.BYTES_PER_ELEMENT,
      );
      sharedMemory = new Float32Array(sharedMemoryBuffer);
      sharedMemories.push({
        start: nextStart,
        end: nextEnd,
        syncStart:
          Math.round(
            sharedMemories.length * outputChunkIntervalSeconds - syncStartRange,
          ) * sampleRate,
        syncEnd:
          Math.round(
            sharedMemories.length * outputChunkIntervalSeconds + syncEndRange,
          ) * sampleRate,
        data: sharedMemory,
      });
      sharedMemoryPosition = 0;
    }

    const chunkStart = nextStart - currentPosition;
    const chunkEnd = nextEnd - currentPosition;

    if (chunkStart < chunk.length) {
      const chunkLength = chunk.length;
      const startOffset = Math.max(0, chunkStart);
      const endOffset = Math.min(chunkLength, chunkEnd);
      const chunkToCopy = chunk.subarray(startOffset, endOffset);
      sharedMemory.set(chunkToCopy, sharedMemoryPosition);
      sharedMemoryPosition += chunkToCopy.length;
    }

    currentPosition += chunk.length;
  }

  return sharedMemories;
};

const copyToSharedMemory = (inputChunks, inputLength) => {
  let currentPosition = 0;
  const sharedMemoryBuffer = new SharedArrayBuffer(
    inputLength * Float32Array.BYTES_PER_ELEMENT,
  );
  const sharedMemory = new Float32Array(sharedMemoryBuffer);

  for (const chunk of inputChunks) {
    sharedMemory.set(chunk, currentPosition);
    currentPosition += chunk.length;
  }

  return sharedMemory;
};

const decodeAndSave = async (
  inputFile,
  sampleRate,
  chunkSize = 0,
  chunkInterval = 0,
  syncStartRange,
  syncEndRange,
) => {
  const { promise, stdout } = runCmd("ffmpeg", [
    "-v",
    "error",
    "-i",
    inputFile,
    "-map",
    "0:a:0", // only support one audio file
    "-ac",
    "1",
    "-ar",
    sampleRate,
    "-f",
    "f32le",
    "-acodec",
    "pcm_f32le",
    "-",
  ]);

  const outputChunks = [];
  let outputSamples = 0;

  stdout.on("data", (data) => {
    const decoded = new Float32Array(data.buffer);

    // rectify to avoid comparison issues with phase
    for (let i = 0; i < decoded.length; i++) {
      decoded[i] = decoded[i] < 0 ? -decoded[i] : decoded[i];
    }
    outputChunks.push(decoded);
    outputSamples += decoded.length;
  });

  await promise;

  return chunkSize === 0
    ? copyToSharedMemory(outputChunks, outputSamples)
    : copyToSharedMemoryChunked(
        outputChunks,
        outputSamples,
        chunkSize,
        chunkInterval,
        syncStartRange,
        syncEndRange,
        sampleRate,
      );
};

function removeOutliers(data, tolerance = 0.5) {
  // Step 1: Build frequency map of rounded differences
  const freqMap = {};

  for (const item of data) {
    const rounded = Math.round(item.difference * 10) / 10;
    freqMap[rounded] = (freqMap[rounded] || 0) + 1;
  }

  // Step 2: Find the mode (most common rounded value)
  let mode = null;
  let maxCount = -1;

  for (const [valueStr, count] of Object.entries(freqMap)) {
    const value = parseFloat(valueStr);
    if (count > maxCount) {
      maxCount = count;
      mode = value;
    }
  }

  // Step 3: Define bounds around the mode (±0.5)
  const lowerBound = mode - tolerance;
  const upperBound = mode + tolerance;

  // Step 4: Split data into good values and outliers
  const goodValues = data.filter(
    (item) => item.difference >= lowerBound && item.difference <= upperBound,
  );
  const outliers = data.filter(
    (item) => item.difference < lowerBound || item.difference > upperBound,
  );
  return goodValues;
}

function weightedLinearRegression(data) {
  const cleaned = removeOutliers(data);
  let sumW = 0,
    sumWX = 0,
    sumWY = 0,
    sumWXY = 0,
    sumWXX = 0;

  for (const d of cleaned) {
    const w = d.correlation;
    const x = d.order;
    const y = d.difference;

    sumW += w;
    sumWX += w * x;
    sumWY += w * y;
    sumWXY += w * x * y;
    sumWXX += w * x * x;
  }

  const denominator = sumW * sumWXX - sumWX * sumWX;

  const slope = (sumW * sumWXY - sumWX * sumWY) / denominator;
  const intercept = (sumWY * sumWXX - sumWX * sumWXY) / denominator;

  return { slope, intercept };
}

function simpleLinearRegression(data, maxRateTolerance) {
  const cleaned = removeOutliers(data, maxRateTolerance);
  const n = cleaned.length;
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumX2 = 0;

  for (const point of cleaned) {
    const x = point.order;
    const y = point.difference;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  return { slope, intercept };
}

const runCmd = (cmd, args) => {
  const spawned = spawn(cmd, args);
  const promise = new Promise((resolve, reject) => {
    spawned.stderr.on("data", (data) => {
      process.stderr.write(data);
    });

    spawned.on("close", (code) => {
      if (code !== 0) {
        console.error(`${cmd} ${args.join(" ")} exit code ${code}`);
      }
      resolve(code);
    });
  });

  return { promise, stdin: spawned.stdin, stdout: spawned.stdout };
};

const trimAndResample = async (
  inputFile,
  outputFile,
  startSeconds,
  endSeconds,
  rate,
  sampleRate,
  bitDepth,
  channelCount,
  flacThreads,
) => {
  const tempFiles = [];

  try {
    // resample
    console.log("Adjusting speed...");

    const tempTrimmed = outputFile + ".tmp.flac";
    tempFiles.push(tempTrimmed);
    await runCmd("sox", [
      inputFile,
      tempTrimmed,
      "rate",
      "-v",
      "trim",
      startSeconds,
      "speed",
      rate,
    ]).promise;

    // amplify each channel
    console.log("Normalizing...");
    const normalizePromises = [];
    const normalizeOutputFiles = [];
    for (let i = 1; i <= channelCount; i++) {
      const channelFile = `${outputFile}.tmp.${i}.flac`;
      const normalizedFile = `${outputFile}.tmp.norm.${i}.flac`;

      tempFiles.push(channelFile);
      tempFiles.push(normalizedFile);
      normalizeOutputFiles.push(normalizedFile);
      normalizePromises.push(
        runCmd("sox", [
          tempTrimmed,
          "-c",
          "1",
          channelFile,
          "trim",
          "0",
          endSeconds,
          "remix",
          i,
        ]).promise.then(
          () => runCmd("sox", [channelFile, normalizedFile, "--norm"]).promise,
        ),
      );
    }
    await Promise.all(normalizePromises);

    console.log("Writing output file...");
    const { promise: soxPromise, stdout: soxStdout } = runCmd("sox", [
      "--combine",
      "merge",
      ...normalizeOutputFiles,
      "-t",
      "raw",
      "-r",
      sampleRate,
      "-c",
      channelCount,
      "-e",
      "signed",
      "-b",
      bitDepth,
      "-",
    ]);
    const { promise: flacPromise, stdin: flacStdin } = runCmd("flac", [
      "--endian=little",
      "--sign=signed",
      "--bps=" + bitDepth,
      "--channels=" + channelCount,
      "--sample-rate=" + sampleRate,
      "-8",
      "-p",
      "-e",
      "-j",
      flacThreads,
      "-",
      "-f",
      "-o",
      outputFile,
    ]);
    soxStdout.pipe(flacStdin);
    await flacPromise;
  } catch (e) {
    console.log(e);
  } finally {
    await Promise.all(tempFiles.map((file) => fs.promises.rm(file).catch()));
  }
};

/*



* Add README
* Allow for `npm i -g synaudio-cli`
* Release to NPM

* General refactoring


 */

const getFileInfo = async (files) =>
  Promise.all(
    files.map(
      (file) =>
        new Promise((resolve, reject) => {
          const buffers = [];
          const { promise, stdout } = runCmd("ffprobe", [
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=channels,bits_per_raw_sample,sample_rate",
            "-of",
            "json",
            file,
          ]);

          stdout.on("data", (data) => {
            buffers.push(data);
          });

          promise.then(() => {
            const fileInfo = JSON.parse(
              Buffer.concat(buffers).toString("utf8"),
            );
            const firstStream = fileInfo?.streams?.[0]; // only supports using the first stream
            if (!firstStream) {
              reject(file + " does not have any audio streams");
            } else {
              resolve({
                sampleRate: firstStream["sample_rate"],
                channels: firstStream["channels"],
                bitDepth: parseInt(firstStream["bits_per_raw_sample"]),
              });
            }
          });
        }),
    ),
  );

const syncResampleEncode = async ({
  baseFile,
  comparisonFile,
  threads,
  sampleLength,
  sampleGap,
  startRange,
  endRange,
  rateTolerance,
  rectify,
  deleteComparison,
  normalize,
  normalizeIndependent,
  encodeOptions,
  renameString,
}) => {
  console.log("Decoding files...");
  const fileInfo = await getFileInfo([baseFile, comparisonFile]);
  const comparisonFileInfo = fileInfo[1];
  const commonSampleRate = Math.max(...fileInfo.map((info) => info.sampleRate));

  let synaudio = new SynAudio({
    correlationSampleSize: sampleLength * commonSampleRate,
    initialGranularity: 16,
    shared: true,
  });

  let [baseFileDecoded, comparisonFileChunks] = await Promise.all([
    decodeAndSave(baseFile, commonSampleRate),
    decodeAndSave(
      comparisonFile,
      commonSampleRate,
      sampleLength,
      sampleGap,
      startRange,
      endRange,
    ),
  ]);
  const baseFileDecodedLength = baseFileDecoded.length;

  process.stdout.write("Synchronizing files...");
  const syncResults = synaudio.syncOneToMany(
    {
      channelData: [baseFileDecoded],
      samplesDecoded: baseFileDecoded.length,
    },
    comparisonFileChunks.map((comparisonChunk, i) => ({
      name: i,
      data: {
        channelData: [comparisonChunk.data],
        samplesDecoded: comparisonChunk.data.length,
      },
      syncStart: comparisonChunk.syncStart,
      syncEnd: comparisonChunk.syncEnd,
    })),
    threads,
    (progress) =>
      process.stdout.write(
        `\rSynchronizing files... ${Math.round(progress * 100)}%`,
      ),
  );
  // dereference these so they can be garbage collected as soon as possible
  baseFileDecoded = null;
  comparisonFileChunks.forEach((chunk) => (chunk.data = null));

  const results = (await syncResults).map((sr, i) => ({
    ...sr,
    order: i,
    difference:
      (comparisonFileChunks[i].start - sr.sampleOffset) / commonSampleRate,
    start: comparisonFileChunks[i].start,
    end: comparisonFileChunks[i].end,
  }));
  process.stdout.write("\n");

  synaudio = null;

  const { slope, intercept } = simpleLinearRegression(results, rateTolerance);
  const startSeconds = intercept;
  const endSeconds = baseFileDecodedLength / 48000;
  const rate = 1 + slope / sampleGap;

  console.log("Trim Start", startSeconds, "Trim End", endSeconds, "Rate", rate);

  await trimAndResample(
    comparisonFile,
    comparisonFile + ".level.flac",
    startSeconds,
    endSeconds,
    rate,
    comparisonFileInfo.sampleRate,
    comparisonFileInfo.bitDepth || 24, // default to 24 in case ffprobe doesn't return a bitdepth
    comparisonFileInfo.channels,
    threads,
  );

  console.log("Done");
  setTimeout(() => process.exit(0), 3000);
};

const main = () => {
  const cpuCoreCount = os.cpus().length;

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
    .option("t", {
      alias: "threads",
      default: cpuCoreCount,
      describe: "Number of threads to spawn while comparing audio.",
      type: "number",
      min: 1,
      max: cpuCoreCount,
    })
    .option("R", {
      alias: "rectify",
      group: "Sync Options:",
      default: true,
      describe:
        "Rectify the audio before comparing for better cross-correlation",
      type: "boolean",
    })
    .options("T", {
      alias: "rate-tolerance",
      group: "Sync Options:",
      default: 0.5,
      describe:
        "Duration in seconds describing how much +- the rate might differ from the base file.",
      min: 0,
      type: "number",
    })
    .options("L", {
      alias: "sample-length",
      group: "Sync Options:",
      default: 0.125,
      describe: "Duration in seconds of each comparison file sample.",
      min: 0,
      type: "number",
    })
    .options("G", {
      alias: "sample-gap",
      group: "Sync Options:",
      default: 10,
      describe:
        "Duration in seconds to skip between samples of the comparison file.",
      min: 0,
      type: "number",
    })
    .options("S", {
      alias: "start-range",
      group: "Sync Options:",
      default: 60 * 3,
      describe: "Duration in seconds to try to sync before the sample.",
      min: 0,
      type: "number",
    })
    .options("E", {
      alias: "end-range",
      group: "Sync Options:",
      default: 60 * 1,
      describe: "Duration in seconds to try to sync after the sample.",
      min: 0,
      type: "number",
    })
    .option("d", {
      alias: "delete-comparision",
      group: "Output Options:",
      default: false,
      describe:
        "Delete the original comparison file after successfully syncing.",
      type: "boolean",
    })
    .option("n", {
      alias: "normalize",
      group: "Output Options:",
      default: false,
      describe: "Normalize the output audio.",
      type: "boolean",
    })
    .option("m", {
      alias: "normalize-independent",
      group: "Output Options:",
      default: false,
      describe: "Normalize the output audio for each channel independently.",
      type: "boolean",
    })
    .option("e", {
      alias: "encode-options",
      group: "Output Options:",
      default: "-best",
      describe: "Encode options supplied to `flac`",
      type: "string",
    })
    .option("r", {
      alias: "rename-string",
      group: "Output Options:",
      default: ".synced",
      describe:
        "String to insert in the synced file before the extension. i.e. comparison.flac -> comparison.synced.flac",
      type: "string",
    })
    .wrap(yargs.terminalWidth)
    .parse();

  syncResampleEncode(argv);
};

main();
