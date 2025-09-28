import { FLACDecoderWebWorker } from "@wasm-audio-decoders/flac";
import SynAudio from "synaudio";
import fs from "fs";
import { spawn } from "child_process";
import { OggOpusDecoderWebWorker } from "ogg-opus-decoder";

const saveDecodedData = (outputChunks) => (decoded) => {
  if (decoded.samplesDecoded > 0) {
    for (let i = 1; i < decoded.channelData.length; i++) {
      for (let j = 0; j < decoded.samplesDecoded; j++) {
        // sum to mono
        decoded.channelData[0][j] += decoded.channelData[i][j];
      }
    }
    for (let i = 0; i < decoded.channelData[0].length; i++) {
      // positive phase only
      decoded.channelData[0][i] =
        decoded.channelData[0][i] < 0
          ? -decoded.channelData[0][i]
          : decoded.channelData[0][i];
    }
    outputChunks.push(decoded.channelData[0]);
  }
  return decoded.samplesDecoded;
};

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

const decodeAndSave = (
  inputFile,
  chunkSize = 0,
  chunkInterval = 0,
  syncStartRange,
  syncEndRange,
  sampleRate,
) => {
  return new Promise(async (resolve, reject) => {
    const outputChunks = [];
    let outputSamples = 0;
    let decoder;

    if (inputFile.endsWith(".ogg")) {
      decoder = new OggOpusDecoderWebWorker();
    } else {
      decoder = new FLACDecoderWebWorker();
    }

    await decoder.ready;
    const readStream = fs.createReadStream(inputFile);

    readStream.on("data", (chunk) => {
      decoder
        .decode(chunk)
        .then((decoded) => {
          return decoded;
        })
        .then(saveDecodedData(outputChunks))
        .then((samplesDecoded) => (outputSamples += samplesDecoded));
    });

    readStream.on("end", async () => {
      decoder
        .flush()
        .then(saveDecodedData(outputChunks))
        .then((samplesDecoded) => (outputSamples += samplesDecoded))
        .then(() => {
          decoder.free();

          resolve(
            chunkSize === 0
              ? copyToSharedMemory(outputChunks, outputSamples)
              : copyToSharedMemoryChunked(
                  outputChunks,
                  outputSamples,
                  chunkSize,
                  chunkInterval,
                  syncStartRange,
                  syncEndRange,
                  sampleRate,
                ),
          );
        });
    });

    readStream.on("error", (err) => {
      reject(err);
    });
  });
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
 * Multiple comparison files against one base file
 * Spawn main decode into promise
 * Start loop decoding and syncing comparison files
 * Spawn first comparison decode
 * Wait for main decode and comparison decode
 * Spawn new promise to sync and sox commands
 * Wait for all sync and resamples to complete
 * Decode input audio using sox
 * Decode audio to a shared sample rate
 * Add yargs
 * General refactoring
 * Add parameters
 * Positional parameters
 * First positional arguments, input base file
 * All other positional arguments, input comparison file(s)
 * Decode Options
 * Sync shared sample rate, default 48000 (maybe should default to highest rate of all sources)
 * Option to rectify input audio, so phase match has less of an influence for syncing. Good for syncing sources with wow and flutter
 * Output Options
 * File name renaming pattern for synced comparison files
 * Delete comparison files when done
 * Output encoding options, i.e. flac options
 * Option to normalize
 * Option to normalize as independent channels
 * Sync options
 * Sync thread count
 * Sync chunk size
 * Sync chunk interval
 * Sync start range
 * Sync end range
 * Max sync rate tolerance (how much +- the rate might differ from source)
 */

const main = async () => {
  const baseFile = process.argv[2];
  const comparisonFile = process.argv[3];
  const sampleRate = 48000;
  const bitDepth = 24;
  const channelCount = 2;
  const threads = 16;
  const chunkSize = 0.125; // how long the comparison file samples should be, shorter is better since it reduces the probability of miss-matching due to wow / flutter
  const chunkInterval = 10; // how many seconds should elapse between samples of the comparison file
  const syncStartRange = 60 * 3; // how many seconds to try to sync before the sample
  const syncEndRange = 60 * 1; // how many seconds to try to sync after the sample
  const maxRateTolerance = 0.5;

  let synaudio = new SynAudio({
    correlationSampleSize: chunkSize * sampleRate,
    initialGranularity: 16,
    shared: true,
  });

  console.log("Decoding files...");
  let [baseFileDecoded, comparisonFileChunks] = await Promise.all([
    decodeAndSave(baseFile),
    decodeAndSave(
      comparisonFile,
      chunkSize,
      chunkInterval,
      syncStartRange,
      syncEndRange,
      sampleRate,
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
    difference: (comparisonFileChunks[i].start - sr.sampleOffset) / sampleRate,
    start: comparisonFileChunks[i].start,
    end: comparisonFileChunks[i].end,
  }));
  process.stdout.write("\n");

  synaudio = null;

  const { slope, intercept } = simpleLinearRegression(
    results,
    maxRateTolerance,
  );
  const startSeconds = intercept;
  const endSeconds = baseFileDecodedLength / 48000;
  const rate = 1 + slope / chunkInterval;

  console.log("Trim Start", startSeconds, "Trim End", endSeconds, "Rate", rate);

  await trimAndResample(
    comparisonFile,
    comparisonFile + ".level.flac",
    startSeconds,
    endSeconds,
    rate,
    sampleRate,
    bitDepth,
    channelCount,
    threads,
  );

  console.log("Done");
  setTimeout(() => process.exit(0), 3000);
};

main();
