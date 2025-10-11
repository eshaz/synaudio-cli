import SynAudio from "synaudio";
import fs from "fs";
import { decodeAndSave } from "./decode.js";
import { simpleLinearRegression } from "./linear-regression.js";
import { getFileInfo, getTempFile, runCmd } from "./utilities.js";

const trimAndResample = async (
  inputFile,
  outputFile,
  startSeconds,
  endSeconds,
  rate,
  sampleRate,
  bitDepth,
  channels,
  normalize,
  normalizeIndependent,
  encodeOptions,
  flacThreads,
) => {
  const tempFileName = getTempFile();
  const tempFiles = [];

  try {
    // resample
    console.log("Adjusting offset and speed...");

    const tempTrimmed = tempFileName + ".tmp.flac";
    tempFiles.push(tempTrimmed);
    await runCmd("sox", [
      inputFile,
      tempTrimmed,
      "rate",
      "-v",
      ...(startSeconds > 0 ? ["trim", startSeconds] : ["pad", -startSeconds]),
      "speed",
      rate,
      "trim",
      "0",
      endSeconds,
    ]).promise;

    // optionally normalize
    const normalizePromises = [];
    const normalizeOutputFiles = [];

    if (normalizeIndependent) {
      console.log("Normalizing each channel...");
      for (let i = 1; i <= channels; i++) {
        const channelFile = `${tempFileName}.tmp.${i}.flac`;
        const normalizedFile = `${tempFileName}.tmp.norm.${i}.flac`;

        tempFiles.push(channelFile);
        tempFiles.push(normalizedFile);
        normalizeOutputFiles.push(normalizedFile);
        normalizePromises.push(
          runCmd("sox", [
            tempTrimmed,
            "-c",
            "1",
            channelFile,
            "remix",
            i,
          ]).promise.then(
            () =>
              runCmd("sox", [channelFile, normalizedFile, "--norm"]).promise,
          ),
        );
      }
      await Promise.all(normalizePromises);
    } else if (normalize) {
      console.log("Normalizing...");

      const normalizedFile = `${tempFileName}.tmp.norm.flac`;

      tempFiles.push(normalizedFile);
      normalizeOutputFiles.push(normalizedFile);
      normalizePromises.push(
        runCmd("sox", [tempTrimmed, normalizedFile, "--norm"]).promise,
      );
      await Promise.all(normalizePromises);
    } else {
      normalizeOutputFiles.push(tempTrimmed);
    }

    console.log("Encoding output file...", outputFile);
    const { stdout: soxStdout } = runCmd("sox", [
      ...(normalizeIndependent ? ["--combine", "merge"] : []),
      ...normalizeOutputFiles,
      "-t",
      "raw",
      "-r",
      sampleRate,
      "-c",
      channels,
      "-e",
      "signed",
      "-b",
      bitDepth,
      "-",
    ]);
    const { promise: flacPromise, stdin: flacStdin } = runCmd("flac", [
      "-s",
      "--endian=little",
      "--sign=signed",
      "--bps=" + bitDepth,
      "--channels=" + channels,
      "--sample-rate=" + sampleRate,
      encodeOptions,
      ...(flacThreads > 1 ? ["-j", flacThreads] : []),
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

export const syncResampleEncode = async ({
  baseFile,
  comparisonFile,
  threads,
  flacThreads,
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
    decodeAndSave(baseFile, commonSampleRate, rectify),
    decodeAndSave(
      comparisonFile,
      commonSampleRate,
      rectify,
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

  console.log("Trim start", startSeconds, "Trim end", endSeconds, "Rate", rate);

  const outputFile = comparisonFile.replace(/(\.[^\.]+)$/, `${renameString}$1`);
  await trimAndResample(
    comparisonFile,
    outputFile,
    startSeconds,
    endSeconds,
    rate,
    comparisonFileInfo.sampleRate,
    comparisonFileInfo.bitDepth || 24, // default to 24 in case ffprobe doesn't return a bitdepth
    comparisonFileInfo.channels,
    normalize,
    normalizeIndependent,
    encodeOptions,
    flacThreads,
  );

  if (deleteComparison) {
    console.log("Deleting comparison file...");
    await fs.promises.rm(comparisonFile).catch((e) => {
      console.error("failed to delete the comparison file", e);
    });
  }

  console.log("Done");
  setTimeout(() => process.exit(0), 3000);
};
